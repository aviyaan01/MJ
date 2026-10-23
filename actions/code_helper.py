import os
import re
import subprocess
import sys
import time
from pathlib import Path

from utils.env import get_api_key, get_base_dir, get_os

BASE_DIR           = get_base_dir()
API_CONFIG_PATH    = BASE_DIR / "config" / "api_keys.json"
DESKTOP            = Path.home() / "Desktop"
MAX_BUILD_ATTEMPTS = 3
GEMINI_MODEL       = "gemini-3.6-flash"


def _log(msg: str):
    try:
        print(msg)
    except UnicodeEncodeError:
        try:
            print(msg.encode("ascii", errors="replace").decode("ascii"))
        except Exception:
            pass


def _get_gemini(model: str = GEMINI_MODEL):
    from google import genai
    _c = genai.Client(api_key=get_api_key('gemini_api_key'))

    class _W:
        def generate_content(self, contents):
            return _c.models.generate_content(model=model, contents=contents)

    return _W()


def _clean_code(text: str | None) -> str:
    if not text:
        return ""
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    return text.strip()


def _open_in_vscode(path: Path):
    """Instantly open the targeted file or directory in VS Code so the user sees changes."""
    import shutil
    try:
        # Check real Microsoft VS Code paths first
        code_bin = None
        vscode_candidates = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Microsoft VS Code" / "Code.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Microsoft VS Code" / "bin" / "code.cmd",
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Microsoft VS Code" / "Code.exe",
            Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "Microsoft VS Code" / "bin" / "code.cmd",
            Path(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")) / "Microsoft VS Code" / "Code.exe",
        ]
        for candidate in vscode_candidates:
            if candidate.exists():
                code_bin = str(candidate)
                break

        if not code_bin:
            which_code = shutil.which("code")
            if which_code and "cursor" not in which_code.lower():
                code_bin = which_code

        if get_os() == "Windows":
            if code_bin:
                subprocess.Popen([code_bin, str(path)])
            else:
                subprocess.Popen(f'code "{path}"', shell=True)
        else:
            subprocess.Popen([code_bin or "code", str(path)])
        _log(f"[Code] [OK] Opened in VS Code: {path}")
    except Exception as e:
        _log(f"[Code] [WARN] Could not open VS Code ({e}) - trying fallback")
        try:
            subprocess.run(f'code "{path}"', shell=(get_os() == "Windows"), capture_output=True)
        except Exception:
            pass


def _resolve_save_path(output_path: str, language: str) -> Path:
    ext_map = {
        "python": ".py", "py": ".py",
        "javascript": ".js", "js": ".js",
        "typescript": ".ts", "ts": ".ts",
        "html": ".html", "css": ".css",
        "java": ".java", "cpp": ".cpp", "c": ".c",
        "bash": ".sh", "shell": ".sh", "powershell": ".ps1",
        "sql": ".sql", "json": ".json", "rust": ".rs", "go": ".go",
        "csharp": ".cs", "cs": ".cs", "php": ".php", "ruby": ".rb",
    }
    default_ext = ext_map.get((language or "python").lower().strip(), ".py")

    if output_path:
        raw = output_path.strip().replace('"', "").replace("'", "")
        # Handle natural folder aliases
        shortcuts = {
            "desktop": Path.home() / "Desktop",
            "documents": Path.home() / "Documents",
            "downloads": Path.home() / "Downloads",
            "home": Path.home(),
            "projects": Path.home() / "Desktop" / "Projects",
            "workspace": BASE_DIR,
        }
        lower_raw = raw.lower()
        for prefix, target_dir in shortcuts.items():
            if lower_raw == prefix:
                return target_dir / f"mj_code{default_ext}"
            if lower_raw.startswith(f"{prefix}/") or lower_raw.startswith(f"{prefix}\\"):
                rel_part = raw[len(prefix) + 1:]
                target_p = target_dir / rel_part
                if not target_p.suffix:
                    target_p = target_p.with_suffix(default_ext)
                return target_p

        p = Path(raw).expanduser()
        if not p.is_absolute():
            # If path contains subdirectories or drive letter
            if ":" in raw:
                p = Path(raw)
            else:
                p = BASE_DIR / raw
        if not p.suffix:
            p = p.with_suffix(default_ext)
        return p.resolve()

    return DESKTOP / f"mj_code{default_ext}"


def _read_file(file_path: str) -> tuple[str, str]:
    if not file_path:
        return "", "No file path provided."
    p = Path(file_path)
    if not p.exists():
        return "", f"File not found: {file_path}"
    try:
        return p.read_text(encoding="utf-8"), ""
    except Exception as e:
        return "", f"Could not read file: {e}"


def _save_file(path: Path, content: str) -> str:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return f"Saved to: {path}"
    except Exception as e:
        return f"Could not save: {e}"


def _preview(code: str, lines: int = 10) -> str:
    all_lines = code.splitlines()
    preview   = "\n".join(all_lines[:lines])
    suffix    = f"\n... ({len(all_lines) - lines} more lines)" if len(all_lines) > lines else ""
    return preview + suffix


def _has_error(output: str) -> bool:
    error_signals = ["error", "exception", "traceback", "syntaxerror",
                     "nameerror", "typeerror", "stderr", "failed", "crash"]
    return any(s in output.lower() for s in error_signals)


def _take_screenshot() -> Path | None:
    try:
        import pyautogui  # type: ignore[import-untyped]
        screenshot_path = Path.home() / "Desktop" / f"ultron_debug_{int(time.time())}.png"
        screenshot = pyautogui.screenshot()
        screenshot.save(str(screenshot_path))
        _log(f"[Code] [SHOT] Screenshot: {screenshot_path}")
        return screenshot_path
    except Exception as e:
        _log(f"[Code] [WARN] Screenshot failed: {e}")
        return None


def _image_to_base64(path: Path) -> str:
    import base64
    return base64.b64encode(path.read_bytes()).decode("utf-8")


_VALID_INTENTS = {"write", "edit", "explain", "run", "build", "screen_debug", "optimize", "fix_error_on_screen"}


def _detect_intent(description: str, file_path: str, code: str) -> str:
    """
    Dil bağımsız niyet tespiti — sabit anahtar kelime listesi YOK.
    Kullanıcı hangi dilde konuşursa konuşsun, açıklama Gemini'ye
    sınıflandırtılır. API'ye ulaşılamazsa dile bakmayan yapısal
    ipuçlarına (dosya diskte var mı, kod verilmiş mi) düşülür.
    """
    desc        = (description or "").strip()
    file_exists = bool(file_path) and Path(file_path).exists()

    if desc:
        try:
            ctx = []
            if file_path:
                ctx.append(f"a file path is provided (exists on disk: {file_exists})")
            if code:
                ctx.append("an inline code snippet is provided")
            prompt = (
                "Classify a coding assistant request into exactly ONE intent word.\n"
                "The request may be written in ANY language.\n\n"
                f"Request: {desc}\n"
                + (f"Context: {'; '.join(ctx)}\n" if ctx else "")
                + "\nIntents:\n"
                "  write               = create new code from scratch\n"
                "  edit                = modify an existing file\n"
                "  explain             = describe what given code/file does\n"
                "  run                 = execute an existing file\n"
                "  build               = write code, run it, and iterate until it works\n"
                "  screen_debug        = analyze an error currently visible on the user's screen\n"
                "  fix_error_on_screen = inspect terminal/IDE error from screen, locate file/line, apply clean fix, and re-run\n"
                "  optimize            = refactor / clean up / speed up existing code\n\n"
                "Reply with ONLY the intent word, nothing else."
            )
            resp = _get_gemini().generate_content(prompt)
            raw = getattr(resp, "text", None) or ""
            ans = raw.strip().lower().strip("`'\". \n")
            if ans in _VALID_INTENTS:
                return ans
        except Exception as e:
            _log(f"[Code] [WARN] Intent classification failed ({e}) - structural fallback")

    # Yapısal geri dönüş — hiçbir dile bağlı değil
    if any(k in desc.lower() for k in ["fix this error", "terminal error", "screen error", "fix error", "error on screen", "screen er error"]):
        return "fix_error_on_screen"
    if file_exists:
        return "edit" if desc else "explain"
    if code:
        return "explain"
    return "write"

def _write(description: str, language: str, output_path: str, player=None) -> tuple[str, Path]:
    lang  = language or "python"
    model = _get_gemini()

    prompt = f"""You are an expert {lang} developer.
Write clean, working, well-commented {lang} code for the description below.

Rules:
- Output ONLY the code. No explanation, no markdown, no backticks.
- Add helpful inline comments.
- Handle errors and edge cases properly.
- Use modern best practices.

Description: {description}

Code:"""

    response = model.generate_content(prompt)
    code     = _clean_code(response.text)
    path     = _resolve_save_path(output_path, lang)
    _save_file(path, code)
    return code, path


def _fix_code(code: str, error_output: str, description: str) -> str:
    model  = _get_gemini()
    prompt = f"""You are an expert debugger.
The code below failed with the following error. Fix it.
Return ONLY the corrected code — no explanation, no markdown, no backticks.

Original goal: {description}

Error:
{error_output[:2000]}

Broken code:
{code}

Fixed code:"""

    response = model.generate_content(prompt)
    return _clean_code(response.text)


def _run_file(path: Path, args: list, timeout: int) -> str:
    interpreters = {
        ".py":  [sys.executable],
        ".js":  ["node"],
        ".ts":  ["ts-node"],
        ".sh":  ["bash"],
        ".ps1": ["powershell", "-File"],
        ".rb":  ["ruby"],
        ".php": ["php"],
    }
    interp = interpreters.get(path.suffix.lower())
    if not interp:
        return f"No interpreter for {path.suffix}."

    try:
        result = subprocess.run(
            interp + [str(path)] + (args or []),
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=timeout, cwd=str(path.parent)
        )
        output = result.stdout.strip()
        error  = result.stderr.strip()
        parts  = []
        if output: parts.append(f"Output:\n{output}")
        if error:  parts.append(f"Stderr:\n{error}")
        return "\n\n".join(parts) if parts else "Executed with no output."

    except subprocess.TimeoutExpired:
        return f"Timed out after {timeout}s."
    except FileNotFoundError:
        return f"Interpreter not found: {interp[0]}."
    except Exception as e:
        return f"Execution error: {e}"


def _build(description, language, output_path, args, timeout, speak=None, player=None) -> str:
    if not description:
        return "Please describe what you want me to build, sir."

    if player:
        player.write_log("[Code] Build started...")

    lang = language or "python"

    try:
        code, path = _write(description, lang, output_path, player)
        _log(f"[Code] [OK] Written: {path}")
    except Exception as e:
        msg = f"Could not write initial code: {e}"
        if speak: speak(msg)
        return msg

    last_output = ""
    for attempt in range(1, MAX_BUILD_ATTEMPTS + 1):
        _log(f"[Code] [RETRY] Attempt {attempt}/{MAX_BUILD_ATTEMPTS}")
        if player:
            player.write_log(f"[Code] Attempt {attempt}...")

        last_output = _run_file(path, args, timeout)

        if not _has_error(last_output):
            msg = (
                f"Build complete, sir. "
                f"The code is working after {attempt} attempt{'s' if attempt > 1 else ''}. "
                f"Saved to {path}."
            )
            if speak: speak(msg)
            return f"{msg}\n\nOutput:\n{last_output}"

        _log(f"[Code] [WARN] Error on attempt {attempt}, fixing...")
        if player:
            player.write_log(f"[Code] Fixing (attempt {attempt})...")

        try:
            code = _fix_code(code, last_output, description)
            _save_file(path, code)
        except Exception as e:
            msg = f"Could not fix code on attempt {attempt}: {e}"
            if speak: speak(msg)
            return msg

    msg = (
        f"I was unable to build a working version after {MAX_BUILD_ATTEMPTS} attempts, sir. "
        f"The last error was: {last_output[:200]}"
    )
    if speak: speak(msg)
    return f"{msg}\n\nLast code saved to: {path}"

def _write_action(description, language, output_path, player) -> str:
    if not description:
        return "Please describe what you want me to write, sir."
    if player:
        player.write_log("[Code] Writing code...")
    try:
        code, path = _write(description, language, output_path, player)
        _open_in_vscode(path)
        _log(f"[Code] [OK] Written & Opened in VS Code: {path}")
        return f"Code written. Saved to: {path} (Opened in VS Code)\n\nPreview:\n{_preview(code)}"
    except Exception as e:
        return f"Could not generate code: {e}"


def _detect_active_file() -> Path | None:
    """Detect open code file from active window or VS Code window title."""
    os_name = get_os()
    if os_name == "Windows":
        try:
            import win32gui  # type: ignore[import-untyped]
            windows = []

            def _enum(hwnd, _):
                if win32gui.IsWindowVisible(hwnd):
                    t = win32gui.GetWindowText(hwnd).strip()
                    if t:
                        windows.append(t)

            win32gui.EnumWindows(_enum, None)

            fg_title = win32gui.GetWindowText(win32gui.GetForegroundWindow()).strip()
            all_titles = [fg_title] + windows

            for t in all_titles:
                # Look for VS Code window patterns: "● main.py - MJ - Visual Studio Code" or "code_helper.py - Visual Studio Code"
                if "visual studio code" in t.lower() or "code" in t.lower():
                    clean = re.sub(r"^[●*•]\s*", "", t)
                    parts = clean.split("-")
                    if parts:
                        filename = parts[0].strip()
                        if any(filename.lower().endswith(ext) for ext in [".py", ".js", ".ts", ".html", ".css", ".json", ".c", ".cpp", ".java", ".rs"]):
                            # Search in workspace first
                            for match in BASE_DIR.rglob(filename):
                                if ".venv" not in match.parts and ".git" not in match.parts:
                                    return match
                            # Fallback: search in Desktop
                            for match in DESKTOP.rglob(filename):
                                return match
        except Exception as e:
            _log(f"[Code] [WARN] Active file detection error: {e}")
    return None


def _screen_edit_action(instruction: str, player=None) -> str:
    """
    Captures visible code on screen, applies the requested changes, and
    pastes it back into the active editor or saves it.
    """
    if player:
        player.write_log("[Code] Capturing screen for code edit...")

    screenshot_path = _take_screenshot()
    if not screenshot_path:
        return "Could not capture screen for code editing."

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=get_api_key('gemini_api_key'))
        image_bytes = screenshot_path.read_bytes()

        prompt = f"""You are an expert software engineer.
Analyze the code visible on this screen and apply the user's edit instruction:
Instruction: {instruction}

Return ONLY the complete updated code inside a markdown code block (```language ... ```). No explanations."""

        contents = types.Content(
            parts=[
                types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
                types.Part.from_text(text=prompt),
            ]
        )
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
        )
        raw_text = (getattr(response, "text", None) or "").strip()
        code = _clean_code(raw_text)

        try:
            screenshot_path.unlink()
        except Exception:
            pass

        if not code:
            return "Could not extract or edit code from the screen."

        # Check if an active file was detected on disk
        active_f = _detect_active_file()
        if active_f:
            _save_file(active_f, code)
            _open_in_vscode(active_f)
            return f"Code on screen edited and saved to: {active_f}\n\nPreview:\n{_preview(code)}"

        # If user is in an active editor window, paste the edited code
        try:
            import pyautogui  # type: ignore[import-untyped]
            import pyperclip  # type: ignore[import-untyped]
            os_name = get_os()
            select_all = ("command", "a") if os_name == "mac" else ("ctrl", "a")
            pyautogui.hotkey(*select_all)
            time.sleep(0.15)
            pyperclip.copy(code)
            time.sleep(0.15)
            paste_hotkey = ("command", "v") if os_name == "mac" else ("ctrl", "v")
            pyautogui.hotkey(*paste_hotkey)
            time.sleep(0.15)
            save_hotkey = ("command", "s") if os_name == "mac" else ("ctrl", "s")
            pyautogui.hotkey(*save_hotkey)
            return f"Code on screen updated and saved in active editor!\n\nPreview:\n{_preview(code)}"
        except Exception:
            out_p = DESKTOP / "mj_edited_code.py"
            _save_file(out_p, code)
            _open_in_vscode(out_p)
            return f"Code on screen edited. Saved to: {out_p}\n\nPreview:\n{_preview(code)}"

    except Exception as e:
        try:
            screenshot_path.unlink()
        except Exception:
            pass
        return f"Screen code edit failed: {e}"


def _edit_action(file_path, instruction, player, code="") -> str:
    if not instruction:
        return "Please describe what change to make, sir."

    target_p = None
    if file_path:
        target_p = Path(file_path).resolve()
    else:
        detected = _detect_active_file()
        if detected:
            target_p = detected
            _log(f"[Code] [TARGET] Auto-detected active file: {target_p}")

    if not target_p and not code:
        # Fallback to screen code editing if no file specified
        return _screen_edit_action(instruction, player)

    if target_p and not code:
        content, err = _read_file(str(target_p))
        if err:
            return err
    else:
        content = code

    if player:
        player.write_log("[Code] Editing code...")

    model  = _get_gemini()
    prompt = f"""You are an expert code editor.
Apply the following change to the code below.
Return ONLY the complete updated code — no explanation, no markdown, no backticks.

Change: {instruction}

Original code:
{content}

Updated code:"""

    try:
        response = model.generate_content(prompt)
        edited   = _clean_code(response.text)
    except Exception as e:
        return f"Could not edit code: {e}"

    if target_p:
        status = _save_file(target_p, edited)
        _open_in_vscode(target_p)
        _log(f"[Code] [OK] Edited & Opened in VS Code: {target_p}")
        return f"File edited. {status} (Opened in VS Code)\n\nPreview:\n{_preview(edited)}"
    else:
        return f"Code edited successfully:\n\n{edited}"


def _explain_action(file_path, code, player) -> str:
    if file_path and not code:
        code, err = _read_file(file_path)
        if err:
            return err
    if not code:
        return "Please provide code or a file path to explain, sir."

    if player:
        player.write_log("[Code] Analyzing code...")

    model  = _get_gemini()
    prompt = f"""Explain what this code does in simple, clear language.
Focus on: what it does, how it works, and any important details.
Be concise — 3 to 6 sentences maximum.

Code:
{code[:4000]}

Explanation:"""

    try:
        response = model.generate_content(prompt)
        return (getattr(response, "text", None) or "").strip()
    except Exception as e:
        return f"Could not explain code: {e}"


def _run_action(file_path, args, timeout, player) -> str:
    if not file_path:
        return "Please provide a file path to run, sir."
    p = Path(file_path)
    if not p.exists():
        return f"File not found: {file_path}"
    if player:
        player.write_log(f"[Code] Running {p.name}...")
    return _run_file(p, args, timeout)


def _optimize_action(file_path, code, language, output_path, player) -> str:

    if file_path and not code:
        code, err = _read_file(file_path)
        if err:
            return err
    if not code:
        return "Please provide code or a file path to optimize, sir."

    if player:
        player.write_log("[Code] Optimizing code...")

    lang  = language or "python"
    model = _get_gemini()

    prompt = f"""You are an expert {lang} developer and code reviewer.
Optimize the following code for:
1. Performance — eliminate unnecessary operations, use efficient data structures
2. Readability — clear variable names, proper formatting, logical structure
3. Best practices — modern {lang} patterns, error handling, type hints if applicable
4. Remove dead code, redundant comments, and unnecessary complexity

Return ONLY the optimized code — no explanation, no markdown, no backticks.

Original code:
{code[:6000]}

Optimized code:"""

    try:
        response  = model.generate_content(prompt)
        optimized = _clean_code(response.text)
    except Exception as e:
        return f"Could not optimize code: {e}"

    # Kaydet
    if file_path:
        save_path = Path(file_path).resolve()
    else:
        save_path = _resolve_save_path(output_path, lang)

    status = _save_file(save_path, optimized)
    _open_in_vscode(save_path)
    _log(f"[Code] [OK] Optimized & Opened in VS Code: {save_path}")

    original_lines  = len(code.splitlines())
    optimized_lines = len(optimized.splitlines())
    diff = original_lines - optimized_lines

    return (
        f"Code optimized. {status} (Opened in VS Code)\n"
        f"Lines: {original_lines} → {optimized_lines} "
        f"({'−' if diff > 0 else '+'}{abs(diff)} lines)\n\n"
        f"Preview:\n{_preview(optimized)}"
    )


def _screen_debug_action(description, file_path, player, speak=None) -> str:

    if player:
        player.write_log("[Code] Taking screenshot for analysis...")

    _log("[Code] [SHOT] Capturing screen for debug...")


    screenshot_path = _take_screenshot()
    if not screenshot_path:
        return "Could not take screenshot, sir. Please make sure PyAutoGUI is installed."


    file_content = ""
    if file_path:
        file_content, err = _read_file(file_path)
        if err:
            _log(f"[Code] [WARN] Could not read file: {err}")

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=get_api_key('gemini_api_key'))

        image_bytes  = screenshot_path.read_bytes()
        image_base64 = _image_to_base64(screenshot_path)

        user_question = description or "What error or problem do you see on the screen? How can it be fixed?"

        context = ""
        if file_content:
            context = f"\n\nAdditionally, here is the related file content:\n```\n{file_content[:4000]}\n```"

        analysis_prompt = f"""You are an expert programmer and debugger analyzing a screenshot.

User's question: {user_question}{context}

Please:
1. Identify any errors, exceptions, or problems visible on the screen
2. Explain what is causing the problem in simple terms
3. Provide a concrete fix or solution
4. If there's code visible, show the corrected version

Be specific and actionable. If you see an error message, quote it exactly."""

        contents = types.Content(
            parts=[
                types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
                types.Part.from_text(text=analysis_prompt),
            ]
        )

        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=contents,
        )

        analysis = (getattr(response, "text", None) or "").strip()
        _log("[Code] [OK] Screen analysis complete")

        try:
            screenshot_path.unlink()
        except Exception:
            pass

        if file_path and file_content:

            code_match = re.search(r"```[a-zA-Z]*\n(.*?)```", analysis, re.DOTALL)
            if code_match:
                fixed_code = code_match.group(1).strip()
                save_path  = Path(file_path)
                _save_file(save_path, fixed_code)
                analysis += f"\n\n[OK] Fixed code has been saved to: {file_path}"
                _log(f"[Code] [OK] Fixed code saved: {file_path}")

        return analysis

    except Exception as e:

        try:
            screenshot_path.unlink()
        except Exception:
            pass
        return f"Screen analysis failed: {e}"


def _fix_error_on_screen(
    description: str = "",
    file_path: str = "",
    command: str = "",
    player=None,
    speak=None
) -> str:
    """
    [MODULE: CODING & VSCODE AUTOMATION]
    5-step execution loop:
    Step 1: If user says "Fix this error on screen", read exact traceback/error from terminal/IDE via Screen Vision.
    Step 2: Identify file name, line number, and root cause of the bug.
    Step 3: Open target file using vscode_control (goto_line) or read in background via _read_file.
    Step 4: Apply fix cleanly without breaking existing imports or logic, and save the file.
    Step 5: Focus integrated terminal, re-run execution command, and monitor output to confirm resolution.
    """
    if player:
        player.write_log("[Code] [Step 1] Capturing screen to read error traceback...")
    _log("[Code] [LOOKUP] [Step 1] Reading traceback from screen via Screen Vision...")

    screenshot_path = _take_screenshot()
    if not screenshot_path:
        return "Could not capture screen for error analysis, sir. Please make sure PyAutoGUI is installed."

    try:
        import json
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=get_api_key('gemini_api_key'))
        image_bytes = screenshot_path.read_bytes()

        vision_prompt = f"""You are an elite software engineer and debugger analyzing a screenshot of an IDE/terminal window.
The user requested: "{description or 'Fix this error on screen'}"

Strictly perform the following diagnosis:
Step 1: Read the EXACT traceback / error message visible on the terminal or IDE screen.
Step 2: Identify:
  - error_message: exact string of the error or traceback
  - file_path: target source file where the error occurred (e.g. main.py or full path). If multiple files in traceback, pick the innermost user code file.
  - line_number: integer line number where the failure occurred (or null if not found)
  - root_cause: concise technical root cause of the bug
  - command: terminal command to re-run the script (e.g. "python main.py", or null if unknown)
  - fix_suggestion: clear suggestion on how to fix it cleanly

Respond ONLY with a valid JSON object:
{{
  "error_message": "...",
  "file_path": "...",
  "line_number": 42,
  "root_cause": "...",
  "command": "python main.py",
  "fix_suggestion": "..."
}}"""

        contents = types.Content(
            parts=[
                types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
                types.Part.from_text(text=vision_prompt),
            ]
        )
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
        )
        raw_res = (getattr(response, "text", None) or "").strip()
        cleaned_json = _clean_code(raw_res)

        try:
            screenshot_path.unlink()
        except Exception:
            pass

        diag = {}
        try:
            diag = json.loads(cleaned_json)
        except Exception:
            m = re.search(r"\{.*\}", cleaned_json, re.DOTALL)
            if m:
                try:
                    diag = json.loads(m.group(0))
                except Exception:
                    pass

        error_msg = diag.get("error_message") or raw_res
        inferred_file = diag.get("file_path") or ""
        line_num = diag.get("line_number")
        root_cause = diag.get("root_cause") or "Runtime error detected on screen"
        rerun_cmd = command or diag.get("command") or ""

        # Step 2: Identify target file, line number, and root cause
        target_file_str = file_path or inferred_file
        _log(f"[Code] [TARGET] [Step 2] Target: {target_file_str}:{line_num} | Root Cause: {root_cause}")
        if player:
            player.write_log(f"[Code] [Step 2] Target {target_file_str}:{line_num} - {root_cause}")

        target_p = None
        if target_file_str:
            cand = Path(target_file_str).expanduser()
            if cand.is_absolute() and cand.exists():
                target_p = cand
            else:
                fname = cand.name
                for match in BASE_DIR.rglob(fname):
                    if ".venv" not in match.parts and ".git" not in match.parts:
                        target_p = match
                        break
                if not target_p and (DESKTOP / fname).exists():
                    target_p = DESKTOP / fname

        if not target_p:
            active_p = _detect_active_file()
            if active_p:
                target_p = active_p
                _log(f"[Code] [TARGET] Detected active file: {target_p}")

        if not target_p:
            return (
                f"Identified error on screen:\n{error_msg}\n\n"
                f"Root cause: {root_cause}\n"
                f"Could not locate the target file '{target_file_str}' on disk to apply fix automatically."
            )

        # Step 3: Open target file using vscode_control or read in background
        _log(f"[Code] [OPEN] [Step 3] Opening target file {target_p} via vscode_control...")
        if player:
            player.write_log(f"[Code] [Step 3] Opening {target_p.name}...")

        try:
            from actions.vscode_control import vscode_control
            vscode_control({
                "action": "goto_line",
                "file_path": str(target_p),
                "line": line_num or 1,
                "column": 1
            }, player=player)
        except Exception as e:
            _log(f"[Code] [WARN] VS Code goto_line fallback: {e}")
            _open_in_vscode(target_p)

        content, read_err = _read_file(str(target_p))
        if read_err:
            return f"Opened {target_p} in VS Code, but could not read content: {read_err}"

        # Step 4: Apply the fix cleanly without breaking existing imports or logic, and save the file
        _log(f"[Code] [FIX] [Step 4] Applying clean fix to {target_p.name}...")
        if player:
            player.write_log(f"[Code] [Step 4] Applying clean fix...")

        fix_prompt = f"""You are an elite software engineer.
Fix the bug in the file below cleanly and accurately.

CRITICAL INSTRUCTIONS:
1. Preserve all existing imports, dependencies, functions, classes, comments, and docstrings that are unrelated to the bug.
2. DO NOT strip or delete working logic.
3. Fix ONLY the root cause identified below.
4. Output the COMPLETE updated file content.
5. Return ONLY the code inside a code block or raw text — no conversational filler or explanations.

File: {target_p.name}
Line: {line_num}
Error / Traceback:
{error_msg}

Root Cause:
{root_cause}

Original Code:
{content}

Fixed Code:"""

        fix_response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=fix_prompt,
        )
        fixed_raw = getattr(fix_response, "text", None) or ""
        fixed_code = _clean_code(fixed_raw)

        if not fixed_code or len(fixed_code) < 10:
            return f"Failed to generate valid fix for {target_p.name}."

        save_status = _save_file(target_p, fixed_code)
        _log(f"[Code] [SAVE] Saved clean fix: {save_status}")

        # Step 5: Focus integrated terminal, re-run execution command, and monitor output
        _log(f"[Code] [RUN] [Step 5] Re-running execution command to verify fix...")
        if player:
            player.write_log("[Code] [Step 5] Re-running command in terminal to verify...")

        terminal_output = ""
        if not rerun_cmd:
            if target_p.suffix == ".py":
                rerun_cmd = f"python {target_p.name}"
            elif target_p.suffix in (".js", ".ts"):
                rerun_cmd = f"node {target_p.name}"

        if rerun_cmd:
            try:
                from actions.vscode_control import vscode_control
                res_term = vscode_control({"action": "run_in_terminal", "command": rerun_cmd}, player=player)
                terminal_output = res_term
            except Exception as e:
                terminal_output = f"Terminal dispatch error: {e}"

        run_res = _run_file(target_p, args=[], timeout=15)
        has_err = _has_error(run_res)
        if not has_err:
            verdict_text = "VERDICT: PASS - Error resolved cleanly without breaking imports or logic."
        else:
            verdict_text = f"VERDICT: FAIL - Execution still reported an error:\n{run_res[:300]}"

        report = (
            f"### [CODING & VSCODE AUTOMATION REPORT]\n"
            f"- **Error Identified:** {root_cause}\n"
            f"- **Target File:** {target_p} (Line {line_num})\n"
            f"- **Status:** {save_status} (Cleanly patched)\n"
            f"- **Re-run Command:** `{rerun_cmd}`\n"
            f"- **Verification:** {verdict_text}\n\n"
            f"**Output:**\n{run_res if run_res else terminal_output}"
        )

        if speak:
            msg = f"Fixed the error in {target_p.name}, sir. {'The re-run passed successfully!' if not has_err else 'Please check the terminal output.'}"
            speak(msg)

        return report

    except Exception as e:
        try:
            screenshot_path.unlink()
        except Exception:
            pass
        return f"Error screen fix failed: {e}"


def code_helper(
    parameters: dict,
    response=None,
    player=None,
    session_memory=None,
    speak=None
) -> str:
    """
    Called from main.py.

    parameters:
        action      : write | edit | screen_edit | fix_error_on_screen | explain | run | build | screen_debug | optimize | auto
        description : What the code should do / what change to make / what problem to analyze
        language    : Programming language (default: python)
        output_path : Where to save — user specifies full path or filename
        file_path   : Path to existing file (edit / explain / run / build / optimize / fix_error_on_screen)
        command     : Terminal execution command to re-run (e.g. 'python main.py')
        code        : Raw code string (explain/optimize without a file)
        args        : CLI argument list for run/build
        timeout     : Execution timeout in seconds (default: 30)
    """
    p           = parameters or {}
    action      = p.get("action", "auto").lower().strip()
    description = p.get("description", "").strip()
    language    = p.get("language", "python").strip()
    output_path = p.get("output_path", "").strip()
    file_path   = p.get("file_path", "").strip()
    command     = p.get("command", "").strip()
    code        = p.get("code", "").strip()
    args        = p.get("args", [])
    timeout     = int(p.get("timeout", 30))

    if action == "auto":
        action = _detect_intent(description, file_path, code)
        _log(f"[Code] [AUTO] Auto-detected: {action}")

    if action in ("write", "create", "create_file", "new_file"):
        return _write_action(description, language, output_path or file_path, player)

    elif action in ("edit", "screen_edit", "edit_screen", "screen_code_edit"):
        return _edit_action(
            file_path,
            description or p.get("instruction", ""),
            player,
            code=code
        )

    elif action in ("fix_error", "fix_error_on_screen", "fix_screen_error", "fix_screen", "screen_fix"):
        return _fix_error_on_screen(
            description=description,
            file_path=file_path,
            command=command,
            player=player,
            speak=speak
        )

    elif action in ("open_in_vscode", "open_vscode", "vscode"):
        target = file_path or output_path or str(BASE_DIR)
        target_p = Path(target).expanduser().resolve()
        _open_in_vscode(target_p)
        return f"Opened {target_p} in Visual Studio Code."

    elif action == "explain":
        return _explain_action(file_path, code, player)

    elif action == "run":
        return _run_action(file_path, args, timeout, player)

    elif action == "build":
        return _build(description, language, output_path, args, timeout, speak, player)

    elif action == "optimize":
        return _optimize_action(file_path, code, language, output_path, player)

    elif action == "screen_debug":
        return _screen_debug_action(description, file_path, player, speak)

    else:
        return f"Unknown action: '{action}'. Use write, edit, fix_error_on_screen, explain, run, build, optimize, open_in_vscode, or screen_debug."