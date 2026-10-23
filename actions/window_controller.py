# actions/window_controller.py
import os
import time
from typing import Any
from utils.env import get_os

try:
    import pyautogui  # type: ignore
    setattr(pyautogui, "FAILSAFE", False)  # type: ignore
    _PYAUTOGUI = True
except ImportError:
    _PYAUTOGUI = False

try:
    import pygetwindow as gw  # type: ignore
    _PYGETWINDOW = True
except ImportError:
    _PYGETWINDOW = False


_PROTECTED_PROCESSES = {
    "explorer.exe", "dwm.exe", "system", "registry", "smss.exe", "csrss.exe",
    "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "fontdrvhost.exe",
    "winlogon.exe", "taskhostw.exe", "sihost.exe", "taskmgr.exe", "python.exe",
    "pythonw.exe", "antigravity.exe", "code.exe", "cmd.exe", "powershell.exe"
}


def minimize_all_windows() -> str:
    """Instantly show desktop and minimize all open windows."""
    if _PYAUTOGUI:
        if get_os() == "Darwin":
            pyautogui.hotkey("command", "option", "h")
        else:
            pyautogui.hotkey("win", "d")
        return "Minimized all open windows and displayed desktop."
    return "pyautogui is required to minimize windows."


def restore_all_windows() -> str:
    """Restore all previously minimized windows."""
    if _PYAUTOGUI:
        if get_os() == "Darwin":
            pyautogui.hotkey("command", "option", "h")
        else:
            pyautogui.hotkey("win", "shift", "m")
        return "Restored open windows."
    return "pyautogui is required to restore windows."


def close_all_user_windows() -> str:
    """Gracefully close all visible user application windows while keeping system processes safe."""
    closed_count = 0

    if _PYGETWINDOW and get_os() == "Windows":
        try:
            windows = gw.getAllWindows()
            for win in windows:
                title = (win.title or "").strip()
                # Skip empty titles, taskbar, program manager, and desktop
                if not title or title in ("Program Manager", "Task Switching", "Windows Input Experience", "Settings"):
                    continue
                if hasattr(win, "visible") and not win.visible:
                    continue
                if hasattr(win, "isMinimized") and win.isMinimized:
                    continue

                try:
                    win.activate()
                    time.sleep(0.08)
                    if _PYAUTOGUI:
                        pyautogui.hotkey("alt", "f4")
                        closed_count += 1
                        time.sleep(0.08)
                except Exception:
                    pass
        except Exception as e:
            print(f"[WindowController] pygetwindow close_all fallback: {e}")

    # If pygetwindow wasn't available or caught 0 windows, try psutil user app cleanup
    if closed_count == 0:
        try:
            import psutil  # type: ignore # noqa: E402
            curr_pid = os.getpid()
            for proc in psutil.process_iter(["pid", "name", "username"]):
                try:
                    pname = (proc.info.get("name") or "").lower()
                    pid = proc.info.get("pid")
                    if pid == curr_pid or pname in _PROTECTED_PROCESSES:
                        continue
                    # Close user-level common browsers / editors / apps
                    target_apps = ["notepad.exe", "calc.exe", "msedge.exe", "chrome.exe", "brave.exe", "spotify.exe", "discord.exe"]
                    if pname in target_apps:
                        proc.terminate()
                        closed_count += 1
                except Exception:
                    continue
        except Exception:
            pass

    return f"Closed {closed_count} application window(s)." if closed_count > 0 else "No application windows were found to close."


def window_controller(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Main entrypoint for extreme window management (minimize all, close all, restore).

    parameters:
        action : minimize_all | show_desktop | close_all | restore_all
    """
    params = parameters or {}
    action = str(params.get("action", "minimize_all")).lower().strip().replace(" ", "_").replace("-", "_")

    print(f"[WindowController] Action: '{action}'")
    if player and hasattr(player, "write_log"):
        player.write_log(f"[Window] {action}")

    if action in ("minimize_all", "show_desktop", "hide_all", "minimize_everything"):
        return minimize_all_windows()

    if action in ("close_all", "close_everything", "close_all_apps", "terminate_all"):
        return close_all_user_windows()

    if action in ("restore_all", "unminimize_all", "restore_windows"):
        return restore_all_windows()

    return f"Unknown window action: '{action}'. Available: minimize_all, close_all, restore_all."
