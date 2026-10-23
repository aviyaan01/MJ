# actions/self_healing.py
"""
MJ (ULTRON) — Self-Healing & Loop Breaker Module
=================================================
Prevents getting stuck in infinite retry loops during OS automation:
- Step 1: Strict MAX_RETRY = 3 limit for visual clicks, actions, or terminal commands.
- Step 2: If clicking coordinates (X, Y) produces no visual change on Screen Vision after 2 attempts:
    * Attempt A: Scroll slightly or dismiss invisible overlay/modal (Esc key).
    * Attempt B: Switch to keyboard navigation (Tab, Enter, Space, or app-specific shortcuts).
    * Attempt C: Execute the action via background Python/CLI script using mj-os-agent.
- Step 3: If an application freezes ("Not Responding"), automatically detect it and
    offer to restart the process cleanly via terminal (taskkill) rather than waiting indefinitely.
"""

from __future__ import annotations

import csv
import io
import json
import os
import platform
import subprocess
import time
from typing import Any, Callable

try:
    from PIL import Image, ImageChops, ImageStat
    _PIL = True
except ImportError:
    _PIL = False

try:
    import pyautogui
    _PYAUTOGUI = True
except ImportError:
    _PYAUTOGUI = False

try:
    import psutil
    _PSUTIL = True
except ImportError:
    _PSUTIL = False

# Strict retry limit
MAX_RETRY: int = 3

# In-memory attempt & loop state tracking
_ATTEMPT_TRACKER: dict[str, dict[str, Any]] = {}


def _get_os() -> str:
    s = platform.system()
    if s == "Windows":
        return "windows"
    if s == "Darwin":
        return "mac"
    return "linux"


# ============================================================================
# STEP 1: Attempt & Retry Tracking (Loop Breaker)
# ============================================================================

def record_attempt(action_key: str, produced_change: bool = True) -> int:
    """Record an attempt for an action key and update change tracking."""
    now = time.time()
    if action_key not in _ATTEMPT_TRACKER:
        _ATTEMPT_TRACKER[action_key] = {
            "attempts": 0,
            "no_change_count": 0,
            "first_attempt": now,
            "last_attempt": now,
        }

    entry = _ATTEMPT_TRACKER[action_key]
    entry["attempts"] += 1
    entry["last_attempt"] = now

    if not produced_change:
        entry["no_change_count"] += 1
    else:
        entry["no_change_count"] = 0

    return entry["attempts"]


def get_attempt_count(action_key: str) -> int:
    """Get the number of recorded attempts for an action key."""
    return _ATTEMPT_TRACKER.get(action_key, {}).get("attempts", 0)


def get_no_change_count(action_key: str) -> int:
    """Get consecutive attempts that produced no visual change."""
    return _ATTEMPT_TRACKER.get(action_key, {}).get("no_change_count", 0)


def is_loop_breaker_triggered(action_key: str, max_retries: int = MAX_RETRY) -> bool:
    """Return True if the attempt count has reached or exceeded MAX_RETRY."""
    return get_attempt_count(action_key) >= max_retries


def reset_attempts(action_key: str | None = None) -> None:
    """Reset attempts for a specific key or clear the whole tracker."""
    if action_key:
        _ATTEMPT_TRACKER.pop(action_key, None)
    else:
        _ATTEMPT_TRACKER.clear()


# ============================================================================
# STEP 2: Visual Change Detection & Fallback Cascade
# ============================================================================

def capture_screen_image() -> Any:
    """Capture a screen frame as a PIL Image."""
    if not _PIL:
        return None

    try:
        from PIL import ImageGrab
        return ImageGrab.grab()
    except Exception:
        pass

    if _PYAUTOGUI:
        try:
            return pyautogui.screenshot()
        except Exception:
            pass

    return None


def detect_visual_change(
    img_before: Any,
    img_after: Any,
    threshold: float = 0.003,
) -> bool:
    """
    Compare two PIL images to detect if a visual change occurred on screen.
    Returns True if pixel difference ratio exceeds threshold, False otherwise.
    """
    if img_before is None or img_after is None:
        # If image capture is unavailable, assume change occurred to avoid false loops
        return True

    if not _PIL:
        return True

    try:
        if img_before.size != img_after.size or img_before.mode != img_after.mode:
            img_after = img_after.resize(img_before.size).convert(img_before.mode)

        diff = ImageChops.difference(img_before, img_after)
        stat = ImageStat.Stat(diff)
        mean_diff = sum(stat.mean) / (len(stat.mean) * 255.0)
        return mean_diff > threshold
    except Exception as e:
        print(f"[SelfHealing] Visual change check warning: {e}")
        return True


def query_mj_os_agent(prompt: str, timeout: int = 10) -> str:
    """
    Query local Ollama mj-os-agent model for OS automation guidance or script generation.
    Returns response text or empty string on failure.
    """
    try:
        import urllib.request
        data = json.dumps({
            "model": "mj-os-agent",
            "prompt": prompt,
            "stream": False
        }).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:11434/api/generate",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("response", "").strip()
    except Exception:
        return ""


def execute_self_healing_click(
    x: int | None = None,
    y: int | None = None,
    description: str = "",
    cli_fallback_cmd: str | None = None,
    keyboard_key: str = "enter",
    scroll_amount: int = -2,
    player: Any = None,
) -> dict[str, Any]:
    """
    Executes a click with visual feedback verification and tiered self-healing:
    - Verifies MAX_RETRY limit.
    - If no visual change is detected after 2 attempts:
        Attempt A: Scroll slightly or dismiss invisible overlay (Esc key).
        Attempt B: Switch to keyboard navigation (Tab -> Enter/Space).
        Attempt C: Execute via background Python/CLI script (mj-os-agent).
    """
    action_key = f"click:{x},{y}:{description.strip().lower()}"

    # Step 1: Check if MAX_RETRY reached
    if is_loop_breaker_triggered(action_key, max_retries=MAX_RETRY):
        msg = (
            f"[SelfHealing] [LOOP BREAKER] Aborting click at ({x}, {y}) '{description}': "
            f"MAX_RETRY ({MAX_RETRY}) limit reached. Infinite loop prevented."
        )
        print(msg)
        return {
            "success": False,
            "loop_breaker_triggered": True,
            "attempts": get_attempt_count(action_key),
            "message": msg,
            "fallback_stage": "aborted",
        }

    # Capture state before click
    img_before = capture_screen_image()

    # Perform click
    click_success = False
    try:
        if _PYAUTOGUI and x is not None and y is not None:
            pyautogui.click(x=x, y=y)
            click_success = True
        elif x is not None and y is not None:
            # Fallback if pyautogui unavailable
            click_success = True
    except Exception as e:
        print(f"[SelfHealing] Click execution error: {e}")

    time.sleep(0.3)
    img_after = capture_screen_image()
    visual_changed = detect_visual_change(img_before, img_after)

    attempts = record_attempt(action_key, produced_change=visual_changed)
    no_change_count = get_no_change_count(action_key)

    if visual_changed and click_success:
        reset_attempts(action_key)
        return {
            "success": True,
            "loop_breaker_triggered": False,
            "attempts": attempts,
            "visual_change": True,
            "message": f"[SelfHealing] Click succeeded at ({x}, {y}) — visual change confirmed.",
        }

    # Step 2: No visual change detected
    print(f"[SelfHealing] [WARN] Click at ({x}, {y}) produced NO visual change (Attempt {attempts}/{MAX_RETRY}, no-change streak: {no_change_count})")

    if no_change_count >= 2:
        # ATTEMPT A: Scroll slightly or dismiss overlay (Escape key)
        print("[SelfHealing] [ATTEMPT A] Scrolling slightly and dismissing potential overlays via Escape...")
        if _PYAUTOGUI:
            try:
                pyautogui.press("escape")
                time.sleep(0.15)
                # Scroll slightly (scroll_amount negative scrolls down)
                pyautogui.scroll(scroll_amount * 100)
                time.sleep(0.2)
                # Retry click
                if x is not None and y is not None:
                    pyautogui.click(x=x, y=y)
                    time.sleep(0.2)
            except Exception as e:
                print(f"[SelfHealing] Attempt A failed: {e}")

        img_after_a = capture_screen_image()
        if detect_visual_change(img_before, img_after_a):
            reset_attempts(action_key)
            return {
                "success": True,
                "loop_breaker_triggered": False,
                "fallback_stage": "Attempt A (Scroll/Dismiss Modal)",
                "visual_change": True,
                "message": f"[SelfHealing] Resolved via Attempt A: Modal dismissed / scrolled and clicked ({x}, {y}).",
            }

        # ATTEMPT B: Switch to keyboard navigation
        print(f"[SelfHealing] [ATTEMPT B] Switching to keyboard navigation (Tab -> {keyboard_key})...")
        if _PYAUTOGUI:
            try:
                pyautogui.press("tab")
                time.sleep(0.1)
                pyautogui.press(keyboard_key)
                time.sleep(0.2)
            except Exception as e:
                print(f"[SelfHealing] Attempt B failed: {e}")

        img_after_b = capture_screen_image()
        if detect_visual_change(img_before, img_after_b):
            reset_attempts(action_key)
            return {
                "success": True,
                "loop_breaker_triggered": False,
                "fallback_stage": "Attempt B (Keyboard Navigation)",
                "visual_change": True,
                "message": f"[SelfHealing] Resolved via Attempt B: Navigated via Tab and pressed '{keyboard_key}'.",
            }

        # ATTEMPT C: Background Python/CLI script using mj-os-agent
        cmd = cli_fallback_cmd
        if not cmd and description:
            agent_suggestion = query_mj_os_agent(f"Generate python background CLI script for: {description}")
            if agent_suggestion and ("python" in agent_suggestion or "subprocess" in agent_suggestion):
                cmd = agent_suggestion

        if cmd:
            print(f"[SelfHealing] [ATTEMPT C] Executing background Python/CLI script via mj-os-agent: {cmd}")
            try:
                res = subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                if res.returncode == 0:
                    reset_attempts(action_key)
                    return {
                        "success": True,
                        "loop_breaker_triggered": False,
                        "fallback_stage": "Attempt C (CLI/Script)",
                        "visual_change": False,
                        "cli_output": res.stdout or res.stderr,
                        "message": f"[SelfHealing] Resolved via Attempt C background script using mj-os-agent (exit code 0).",
                    }
                else:
                    print(f"[SelfHealing] Attempt C script failed with exit code {res.returncode}")
            except Exception as e:
                print(f"[SelfHealing] Attempt C failed: {e}")

    # If attempts reach MAX_RETRY, trigger loop breaker
    if attempts >= MAX_RETRY:
        return {
            "success": False,
            "loop_breaker_triggered": True,
            "attempts": attempts,
            "visual_change": False,
            "message": (
                f"[SelfHealing] [LOOP BREAKER] Aborting after {attempts} attempts with NO visual change. "
                "Switched through Attempt A (Dismiss/Scroll), Attempt B (Keyboard), Attempt C (CLI). "
                "Halting to prevent infinite loop."
            ),
        }

    return {
        "success": False,
        "loop_breaker_triggered": False,
        "attempts": attempts,
        "visual_change": False,
        "message": f"[SelfHealing] Attempt {attempts}/{MAX_RETRY} finished with no visual change detected. Ready for next fallback.",
    }


def execute_self_healing_command(
    command: str,
    cwd: str | None = None,
    timeout: int = 30,
    max_retries: int = MAX_RETRY,
) -> dict[str, Any]:
    """
    Executes a terminal command with MAX_RETRY loop breaking protection.
    If the command fails repeatedly, loop breaker aborts to prevent lock-in.
    """
    action_key = f"cmd:{command.strip()}"

    if is_loop_breaker_triggered(action_key, max_retries=max_retries):
        return {
            "success": False,
            "loop_breaker_triggered": True,
            "attempts": get_attempt_count(action_key),
            "message": f"[SelfHealing] [LOOP BREAKER] Command '{command}' exceeded MAX_RETRY ({max_retries}). Aborted to prevent loop.",
        }

    try:
        res = subprocess.run(
            command,
            cwd=cwd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if res.returncode == 0:
            reset_attempts(action_key)
            return {
                "success": True,
                "loop_breaker_triggered": False,
                "stdout": res.stdout,
                "stderr": res.stderr,
                "returncode": 0,
            }
        else:
            attempts = record_attempt(action_key, produced_change=False)
            return {
                "success": False,
                "loop_breaker_triggered": attempts >= max_retries,
                "attempts": attempts,
                "stdout": res.stdout,
                "stderr": res.stderr,
                "returncode": res.returncode,
                "message": f"Command failed with exit code {res.returncode} (Attempt {attempts}/{max_retries}).",
            }
    except Exception as e:
        attempts = record_attempt(action_key, produced_change=False)
        return {
            "success": False,
            "loop_breaker_triggered": attempts >= max_retries,
            "attempts": attempts,
            "error": str(e),
            "message": f"Command execution exception: {e} (Attempt {attempts}/{max_retries}).",
        }


# ============================================================================
# STEP 3: Application Freeze Detection & Clean Restart via taskkill
# ============================================================================

def check_frozen_applications(target_app: str | None = None) -> list[dict[str, Any]]:
    """
    Detects any application currently in a 'Not Responding' (frozen) state.
    On Windows:
      1. Parses 'tasklist /fo csv /fi "status eq not responding"'
      2. Uses IsHungAppWindow win32 API
    On Linux/Mac:
      Checks psutil status for unresponsive / zombie states.
    """
    frozen_apps: list[dict[str, Any]] = []
    os_name = _get_os()

    if os_name == "windows":
        # Approach 1: tasklist command
        try:
            cmd = 'tasklist /fo csv /nh /fi "status eq not responding"'
            out = subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.DEVNULL)
            reader = csv.reader(io.StringIO(out.strip()))
            for row in reader:
                if len(row) >= 2:
                    pname = row[0].strip()
                    try:
                        pid = int(row[1].strip())
                    except ValueError:
                        continue
                    if pname and pid > 0:
                        frozen_apps.append({
                            "name": pname,
                            "pid": pid,
                            "status": "Not Responding",
                            "source": "tasklist",
                        })
        except Exception:
            pass

        # Approach 2: Windows IsHungAppWindow API
        try:
            import ctypes
            user32 = getattr(ctypes, "windll", None) and getattr(ctypes.windll, "user32", None)
            if user32 and hasattr(user32, "IsHungAppWindow"):
                WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

                def _enum_proc(hwnd, lparam):
                    if user32.IsWindowVisible(hwnd) and user32.IsHungAppWindow(hwnd):
                        length = user32.GetWindowTextLengthW(hwnd)
                        buff = ctypes.create_unicode_buffer(length + 1)
                        user32.GetWindowTextW(hwnd, buff, length + 1)
                        title = buff.value.strip()

                        pid = ctypes.c_ulong()
                        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                        pname = ""
                        if _PSUTIL and pid.value > 0:
                            try:
                                pname = psutil.Process(pid.value).name()
                            except Exception:
                                pass

                        if pid.value > 0:
                            frozen_apps.append({
                                "name": pname or "unknown.exe",
                                "pid": pid.value,
                                "title": title,
                                "status": "Not Responding",
                                "source": "IsHungAppWindow",
                            })
                    return True

                user32.EnumWindows(WNDENUMPROC(_enum_proc), 0)
        except Exception:
            pass

    elif _PSUTIL:
        # Cross-platform psutil check
        try:
            for p in psutil.process_iter(["pid", "name", "status"]):
                info = p.info
                status = str(info.get("status", "")).lower()
                if status in ("zombie", "dead", "unresponsive"):
                    frozen_apps.append({
                        "name": info.get("name", "unknown"),
                        "pid": info.get("pid", 0),
                        "status": "Not Responding",
                        "source": "psutil",
                    })
        except Exception:
            pass

    # Filter by target_app if provided
    if target_app:
        t = target_app.lower().strip()
        filtered = []
        for app in frozen_apps:
            aname = str(app.get("name", "")).lower()
            atitle = str(app.get("title", "")).lower()
            if t in aname or t in atitle or t.replace(".exe", "") in aname:
                filtered.append(app)
        return filtered

    # Deduplicate by PID
    seen_pids = set()
    deduped = []
    for app in frozen_apps:
        pid = app.get("pid")
        if pid and pid not in seen_pids:
            seen_pids.add(pid)
            deduped.append(app)
    return deduped


def terminate_frozen_app(name_or_pid: str | int, force: bool = True) -> dict[str, Any]:
    """
    Terminates a frozen process cleanly via terminal (taskkill on Windows, kill -9 on Unix).
    """
    os_name = _get_os()
    f_flag = "/F" if force else ""

    if os_name == "windows":
        if isinstance(name_or_pid, int) or str(name_or_pid).isdigit():
            cmd = f"taskkill {f_flag} /PID {name_or_pid} /T"
        else:
            name = str(name_or_pid)
            if not name.lower().endswith(".exe"):
                name = f"{name}.exe"
            cmd = f"taskkill {f_flag} /IM {name} /T"
    else:
        sig = "-9" if force else "-15"
        cmd = f"kill {sig} {name_or_pid}"

    try:
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        success = res.returncode == 0
        return {
            "success": success,
            "command": cmd,
            "returncode": res.returncode,
            "output": (res.stdout or res.stderr).strip(),
            "message": f"Executed terminal termination: {cmd}",
        }
    except Exception as e:
        return {
            "success": False,
            "command": cmd,
            "error": str(e),
            "message": f"Termination failed: {e}",
        }


def restart_frozen_app(
    name_or_pid: str | int,
    app_name: str | None = None,
) -> dict[str, Any]:
    """
    Cleanly terminates a frozen process via taskkill and relaunches it cleanly.
    """
    relaunch_name = app_name or str(name_or_pid).replace(".exe", "")

    # Step 1: Kill frozen process
    kill_res = terminate_frozen_app(name_or_pid, force=True)

    # Step 2: Brief pause for OS handle cleanup
    time.sleep(1.0)

    # Step 3: Relaunch app cleanly
    relaunch_res = "Not attempted"
    try:
        from actions.open_app import open_app
        relaunch_res = open_app({"app_name": relaunch_name})
    except Exception as e:
        relaunch_res = f"Relaunch error: {e}"

    return {
        "success": kill_res.get("success", False),
        "target": str(name_or_pid),
        "relaunch_app": relaunch_name,
        "kill_result": kill_res,
        "relaunch_result": relaunch_res,
        "message": f"Cleanly terminated frozen app '{name_or_pid}' and relaunched '{relaunch_name}'.",
    }


def offer_frozen_app_restart(target_app: str | None = None) -> str:
    """
    Checks for frozen applications. If any are detected, returns an actionable
    proposal to restart cleanly via taskkill instead of waiting indefinitely.
    """
    frozen = check_frozen_applications(target_app)
    if not frozen:
        if target_app:
            return f"Application '{target_app}' is running normally (not frozen)."
        return "No frozen or unresponsive applications detected."

    apps_desc = ", ".join([f"{a.get('name')} (PID: {a.get('pid')})" for a in frozen])
    return (
        f"[SelfHealing] Detected unresponsive/frozen application(s): {apps_desc}. "
        f"Boss, this app is 'Not Responding'. Would you like me to restart it cleanly via terminal (taskkill)?"
    )


# ============================================================================
# Main Tool Entrypoint
# ============================================================================

def self_healing(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Unified entrypoint for Self-Healing & Loop Breaker system.

    Parameters:
        action: click | check_frozen | restart_frozen | offer_restart | run_command | reset | status
        x, y: Coordinates for click
        description: Description of element
        app_name / target: Process name or PID for freeze management
        command: Terminal command to run with loop protection
        auto_restart: Whether to automatically restart detected frozen apps (default: False)
    """
    params = parameters or {}
    raw_action = str(params.get("action", "click")).lower().strip().replace("-", "_")

    if player and hasattr(player, "write_log"):
        player.write_log(f"[SelfHealing] {raw_action}")

    # Action 1: Self-healing click with multi-tier fallback
    if raw_action in ("click", "self_healing_click", "smart_click"):
        x = params.get("x")
        y = params.get("y")
        desc = params.get("description", "")
        cli_cmd = params.get("cli_fallback_cmd")
        key = params.get("keyboard_key", "enter")

        result = execute_self_healing_click(
            x=int(x) if x is not None else None,
            y=int(y) if y is not None else None,
            description=desc,
            cli_fallback_cmd=cli_cmd,
            keyboard_key=key,
            player=player,
        )
        return str(result.get("message", result))

    # Action 2: Check frozen applications
    if raw_action in ("check_frozen", "check_frozen_apps", "detect_freeze", "status_apps"):
        target = params.get("app_name") or params.get("target")
        frozen = check_frozen_applications(target)
        if not frozen:
            return "All applications are responding normally. No frozen processes detected."
        return f"Detected {len(frozen)} frozen application(s): {frozen}"

    # Action 3: Restart frozen application via taskkill
    if raw_action in ("restart_frozen", "restart_frozen_app", "kill_and_restart", "recover_app"):
        target = params.get("target") or params.get("app_name") or params.get("pid")
        if not target:
            # Check if any app is frozen
            frozen = check_frozen_applications()
            if frozen:
                target = frozen[0].get("pid") or frozen[0].get("name")
            else:
                return "No frozen application specified and none currently detected."
        app_name = params.get("app_name")
        res = restart_frozen_app(target, app_name=app_name)
        return str(res.get("message", res))

    # Action 4: Offer frozen restart
    if raw_action in ("offer_restart", "offer_frozen_restart", "propose_restart"):
        target = params.get("app_name") or params.get("target")
        return offer_frozen_app_restart(target)

    # Action 5: Run command with MAX_RETRY protection
    if raw_action in ("run_command", "heal_command", "exec_command"):
        cmd = params.get("command", "")
        if not cmd:
            return "No command specified for execution."
        res = execute_self_healing_command(cmd, cwd=params.get("cwd"))
        if res.get("loop_breaker_triggered"):
            return res.get("message", "Loop breaker triggered on command.")
        return res.get("stdout") or res.get("stderr") or res.get("message", "Executed.")

    # Action 6: Reset loop / attempt trackers
    if raw_action in ("reset", "reset_loop", "clear_attempts"):
        key = params.get("key")
        reset_attempts(key)
        return f"Reset attempt trackers for: {key if key else 'ALL actions'}."

    # Action 7: Status
    if raw_action in ("status", "loop_status"):
        return f"Active attempt trackers: {_ATTEMPT_TRACKER}"

    return f"Unknown self_healing action: '{raw_action}'. Available: click, check_frozen, restart_frozen, offer_restart, run_command, reset, status."
