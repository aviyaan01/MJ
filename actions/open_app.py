import platform
import shutil
import subprocess
import time

try:
    import psutil
    _PSUTIL = True
except ImportError:
    _PSUTIL = False

_SYSTEM = platform.system()

_APP_ALIASES: dict[str, dict[str, str]] = {

    "chrome":             {"Windows": "chrome",                  "Darwin": "Google Chrome",        "Linux": "google-chrome"},
    "google chrome":      {"Windows": "chrome",                  "Darwin": "Google Chrome",        "Linux": "google-chrome"},
    "firefox":            {"Windows": "firefox",                 "Darwin": "Firefox",              "Linux": "firefox"},
    "edge":               {"Windows": "msedge",                  "Darwin": "Microsoft Edge",       "Linux": "microsoft-edge"},
    "brave":              {"Windows": "brave",                   "Darwin": "Brave Browser",        "Linux": "brave-browser"},
    "safari":             {"Windows": "msedge",                  "Darwin": "Safari",               "Linux": "firefox"},
    "opera":              {"Windows": "opera",                   "Darwin": "Opera",                "Linux": "opera"},
    "whatsapp":           {"Windows": "WhatsApp",                "Darwin": "WhatsApp",             "Linux": "whatsapp"},
    "telegram":           {"Windows": "Telegram",                "Darwin": "Telegram",             "Linux": "telegram"},
    "discord":            {"Windows": "Discord",                 "Darwin": "Discord",              "Linux": "discord"},
    "slack":              {"Windows": "Slack",                   "Darwin": "Slack",                "Linux": "slack"},
    "zoom":               {"Windows": "Zoom",                    "Darwin": "zoom.us",              "Linux": "zoom"},
    "teams":              {"Windows": "msteams",                 "Darwin": "Microsoft Teams",      "Linux": "teams"},
    "skype":              {"Windows": "skype",                   "Darwin": "Skype",                "Linux": "skype"},
    "signal":             {"Windows": "signal",                  "Darwin": "Signal",               "Linux": "signal"},
    "spotify":            {"Windows": "Spotify",                 "Darwin": "Spotify",              "Linux": "spotify"},
    "vlc":                {"Windows": "vlc",                     "Darwin": "VLC",                  "Linux": "vlc"},
    "netflix":            {"Windows": "Netflix",                 "Darwin": "Netflix",              "Linux": "firefox"},
    "vscode":             {"Windows": "code",                    "Darwin": "Visual Studio Code",   "Linux": "code"},
    "visual studio code": {"Windows": "code",                    "Darwin": "Visual Studio Code",   "Linux": "code"},
    "code":               {"Windows": "code",                    "Darwin": "Visual Studio Code",   "Linux": "code"},
    "terminal":           {"Windows": "wt",                      "Darwin": "Terminal",             "Linux": "x-terminal-emulator"},
    "cmd":                {"Windows": "cmd.exe",                 "Darwin": "Terminal",             "Linux": "bash"},
    "powershell":         {"Windows": "powershell.exe",          "Darwin": "Terminal",             "Linux": "bash"},
    "postman":            {"Windows": "Postman",                 "Darwin": "Postman",              "Linux": "postman"},
    "git":                {"Windows": "git-bash",                "Darwin": "Terminal",             "Linux": "bash"},
    "figma":              {"Windows": "Figma",                   "Darwin": "Figma",                "Linux": "figma"},
    "blender":            {"Windows": "blender",                 "Darwin": "Blender",              "Linux": "blender"},
    "word":               {"Windows": "winword",                 "Darwin": "Microsoft Word",       "Linux": "libreoffice --writer"},
    "excel":              {"Windows": "excel",                   "Darwin": "Microsoft Excel",      "Linux": "libreoffice --calc"},
    "powerpoint":         {"Windows": "powerpnt",                "Darwin": "Microsoft PowerPoint", "Linux": "libreoffice --impress"},
    "libreoffice":        {"Windows": "soffice",                 "Darwin": "LibreOffice",          "Linux": "libreoffice"},
    "notepad":            {"Windows": "notepad.exe",             "Darwin": "TextEdit",             "Linux": "gedit"},
    "textedit":           {"Windows": "notepad.exe",             "Darwin": "TextEdit",             "Linux": "gedit"},
    "explorer":           {"Windows": "explorer.exe",            "Darwin": "Finder",               "Linux": "nautilus"},
    "file explorer":      {"Windows": "explorer.exe",            "Darwin": "Finder",               "Linux": "nautilus"},
    "finder":             {"Windows": "explorer.exe",            "Darwin": "Finder",               "Linux": "nautilus"},
    "task manager":       {"Windows": "taskmgr.exe",             "Darwin": "Activity Monitor",     "Linux": "gnome-system-monitor"},
    "settings":           {"Windows": "ms-settings:",            "Darwin": "System Preferences",   "Linux": "gnome-control-center"},
    "calculator":         {"Windows": "calc.exe",                "Darwin": "Calculator",           "Linux": "gnome-calculator"},
    "paint":              {"Windows": "mspaint.exe",             "Darwin": "Preview",              "Linux": "gimp"},
    "instagram":          {"Windows": "Instagram",               "Darwin": "Instagram",            "Linux": "firefox"},
    "tiktok":             {"Windows": "TikTok",                  "Darwin": "TikTok",               "Linux": "firefox"},
    "notion":             {"Windows": "Notion",                  "Darwin": "Notion",               "Linux": "notion"},
    "obsidian":           {"Windows": "Obsidian",                "Darwin": "Obsidian",             "Linux": "obsidian"},
    "capcut":             {"Windows": "CapCut",                  "Darwin": "CapCut",               "Linux": "capcut"},
    "steam":              {"Windows": "steam",                   "Darwin": "Steam",                "Linux": "steam"},
    "epic":               {"Windows": "EpicGamesLauncher",       "Darwin": "Epic Games Launcher",  "Linux": "legendary"},
    "epic games":         {"Windows": "EpicGamesLauncher",       "Darwin": "Epic Games Launcher",  "Linux": "legendary"},
}


def _normalize(raw: str) -> str:
    key = raw.lower().strip()

    if key in _APP_ALIASES:
        return _APP_ALIASES[key].get(_SYSTEM, raw)

    for alias_key, os_map in _APP_ALIASES.items():
        if alias_key in key or key in alias_key:
            return os_map.get(_SYSTEM, raw)

    return raw  

def _launch_windows(app_name: str) -> bool:
    import os

    try:
        subprocess.Popen(
            f'start "" "{app_name}"',
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.0)
        return True
    except Exception:
        pass

    if shutil.which(app_name) or shutil.which(app_name.split(".")[0]):
        try:
            subprocess.Popen(
                app_name,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(1.0)
            return True
        except Exception as e:
            print(f"[open_app] subprocess failed: {e}")

    if hasattr(os, "startfile"):
        try:
            os.startfile(app_name)
            time.sleep(1.0)
            return True
        except Exception:
            pass

    try:
        import pyautogui

        pyautogui.PAUSE = 0.1
        pyautogui.press("win")
        time.sleep(0.5)
        pyautogui.write(app_name, interval=0.05)
        time.sleep(0.5)
        pyautogui.press("enter")
        time.sleep(1.5)
        return True
    except Exception as e:
        print(f"[open_app] Start Menu search failed: {e}")

    return False


def _launch_macos(app_name: str) -> bool:

    try:
        result = subprocess.run(
            ["open", "-a", app_name],
            capture_output=True, timeout=8
        )
        if result.returncode == 0:
            time.sleep(1.0)
            return True
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["open", "-a", f"{app_name}.app"],
            capture_output=True, timeout=8
        )
        if result.returncode == 0:
            time.sleep(1.0)
            return True
    except Exception:
        pass

    binary = shutil.which(app_name) or shutil.which(app_name.lower())
    if binary:
        try:
            subprocess.Popen(
                [binary],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            time.sleep(1.0)
            return True
        except Exception:
            pass

    try:
        import pyautogui
        pyautogui.hotkey("command", "space")
        time.sleep(0.6)
        pyautogui.write(app_name, interval=0.05)
        time.sleep(0.8)
        pyautogui.press("enter")
        time.sleep(1.5)
        return True
    except Exception as e:
        print(f"[open_app] Spotlight failed: {e}")

    return False


_LINUX_TERMINAL_FALLBACKS = [
    "x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal",
    "xterm", "lxterminal", "mate-terminal", "tilix", "alacritty", "kitty",
]

def _launch_linux(app_name: str) -> bool:

    # terminal emulators: try common ones in order
    if app_name in ("x-terminal-emulator", "gnome-terminal", "terminal"):
        for term in _LINUX_TERMINAL_FALLBACKS:
            if shutil.which(term):
                try:
                    subprocess.Popen([term], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    time.sleep(1.0)
                    return True
                except Exception:
                    continue

    binary = (
        shutil.which(app_name) or
        shutil.which(app_name.lower()) or
        shutil.which(app_name.lower().replace(" ", "-")) or
        shutil.which(app_name.lower().replace(" ", "_"))
    )
    if binary:
        try:
            subprocess.Popen(
                [binary],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            time.sleep(1.0)
            return True
        except Exception:
            pass

    try:
        subprocess.run(
            ["xdg-open", app_name],
            capture_output=True, timeout=5
        )
        return True
    except Exception:
        pass

    for desktop_name in [
        app_name.lower(),
        app_name.lower().replace(" ", "-"),
        app_name.lower().replace(" ", ""),
    ]:
        try:
            result = subprocess.run(
                ["gtk-launch", desktop_name],
                capture_output=True, timeout=5
            )
            if result.returncode == 0:
                return True
        except Exception:
            pass

    return False


_OS_LAUNCHERS = {
    "Windows": _launch_windows,
    "Darwin":  _launch_macos,
    "Linux":   _launch_linux,
}

def open_app(
    parameters=None,
    response=None,
    player=None,
    session_memory=None,
) -> str:
    app_name = (parameters or {}).get("app_name", "").strip()

    if not app_name:
        return "No application name provided."

    launcher = _OS_LAUNCHERS.get(_SYSTEM)
    if launcher is None:
        return f"Unsupported operating system: {_SYSTEM}"

    normalized = _normalize(app_name)
    print(f"[open_app] Launching: '{app_name}' -> '{normalized}' ({_SYSTEM})")

    if player:
        player.write_log(f"[open_app] {app_name}")

    try:
        if launcher(normalized):
            return f"Opened {app_name}."
        if normalized.lower() != app_name.lower():
            if launcher(app_name):
                return f"Opened {app_name}."
        return (
            f"Could not confirm that {app_name} launched. "
            f"It may still be loading, or it might not be installed."
        )
    except Exception as e:
        print(f"[open_app] Error: {e}")
        return f"Failed to open {app_name}: {e}"


_PROTECTED_PROCESS_NAMES = {
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
    "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe",
    "launchd", "systemd", "init",
}


def _close_needles(app_name: str) -> list[str]:
    """Case-insensitive process-name needles from spoken name + alias map."""
    raw = (app_name or "").strip()
    if not raw:
        return []
    needles: set[str] = set()
    key = raw.lower()
    needles.add(key)
    needles.add(key.replace(" ", ""))
    needles.add(key.replace(" ", "-"))
    needles.add(key.replace(".exe", ""))

    normalized = _normalize(raw).lower()
    for item in (normalized, normalized.replace(" ", ""), normalized.split()[-1]):
        needles.add(item)
        needles.add(item.replace(".exe", ""))
        if _SYSTEM == "Windows" and not item.endswith(".exe"):
            needles.add(item + ".exe")

    if key in _APP_ALIASES:
        for os_name in _APP_ALIASES[key].values():
            needles.add(os_name.lower())
            needles.add(os_name.lower().replace(".exe", ""))

    for alias_key, os_map in _APP_ALIASES.items():
        if alias_key in key or key in alias_key:
            mapped = os_map.get(_SYSTEM, "").lower()
            if mapped:
                needles.add(mapped)
                needles.add(mapped.replace(".exe", ""))

    return [n for n in needles if n]


def _name_matches(proc_name: str, needles: list[str]) -> bool:
    pn = (proc_name or "").lower()
    if not pn:
        return False
    stem = pn[:-4] if pn.endswith(".exe") else pn
    for needle in needles:
        n = needle[:-4] if needle.endswith(".exe") else needle
        if n and (n == stem or n in stem or stem in n):
            return True
    return False


def close_app(
    app_name: str = "",
    parameters=None,
    response=None,
    player=None,
    session_memory=None,
    timeout: float = 5.0,
) -> str:
    """Find a running process by name (alias-aware) and terminate it.

    Graceful terminate first; force-kill if it is still alive after `timeout`.
    This closes the named application wherever it runs — not the foreground window.
    """
    if parameters and not app_name:
        app_name = str(parameters.get("app_name") or "").strip()
    app_name = (app_name or "").strip()
    if not app_name:
        return "No application name provided."

    if not _PSUTIL:
        return "psutil is not installed. Run: pip install psutil"

    import os

    needles = _close_needles(app_name)
    if not needles:
        return f"Could not resolve application name '{app_name}'."

    matches = []
    my_pid = os.getpid()
    try:
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                pid = proc.info.get("pid")
                name = proc.info.get("name") or ""
                if pid == my_pid:
                    continue
                if name.lower() in _PROTECTED_PROCESS_NAMES:
                    continue
                if _name_matches(name, needles):
                    matches.append(proc)
            except (psutil.Error, ProcessLookupError):
                continue
    except Exception as e:
        return f"Failed to scan processes: {e}"

    if not matches:
        return f"No running process matched '{app_name}'."

    if player:
        player.write_log(f"[close_app] {app_name} ({len(matches)} process(es))")

    seen: set[int] = set()
    unique = []
    for proc in matches:
        try:
            if proc.pid not in seen:
                seen.add(proc.pid)
                unique.append(proc)
        except (psutil.Error, ProcessLookupError):
            continue

    names = sorted({(p.name() or "?") for p in unique})
    for proc in unique:
        try:
            proc.terminate()
        except (psutil.Error, ProcessLookupError):
            pass

    gone, alive = psutil.wait_procs(unique, timeout=max(1.0, float(timeout)))
    for proc in alive:
        try:
            proc.kill()
        except (psutil.Error, ProcessLookupError):
            pass
    psutil.wait_procs(alive, timeout=2.0)

    still = []
    for proc in unique:
        try:
            if proc.is_running():
                still.append(proc.name())
        except (psutil.Error, ProcessLookupError):
            pass

    if still:
        return f"Tried to close {app_name} ({', '.join(names)}) but still running: {', '.join(still)}."
    return f"Closed {app_name} ({', '.join(names)})."