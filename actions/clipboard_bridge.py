# actions/clipboard_bridge.py
"""
[MODULE: CROSS-APP PIPELINE & CLIPBOARD BRIDGE]
When a task requires moving information between multiple applications
(e.g., "Search this topic on Brave, summarize it, and send it on WhatsApp"
 or "Copy the error from browser and fix it in VS Code"):
Step 1: Write text directly to system clipboard and press Ctrl+V for instant, zero-typo pasting.
Step 2: Maintain a 'Working Scratchpad' in memory when switching windows (Alt+Tab) so context
        from App A is never lost when focusing App B.
Step 3: Verify that the target window is active in the foreground via Screen Vision / Window API
        before executing paste (Ctrl+V) or pressing Enter.
"""

import subprocess
import time
from typing import Any
from utils.env import get_os

try:
    import pyautogui  # type: ignore
    setattr(pyautogui, "FAILSAFE", False)  # type: ignore
    pyautogui.PAUSE = 0.05
    _PYAUTOGUI = True
except ImportError:
    _PYAUTOGUI = False

try:
    import pyperclip  # type: ignore
    _PYPERCLIP = True
except ImportError:
    _PYPERCLIP = False

try:
    import pygetwindow as gw  # type: ignore
    _PYGETWINDOW = True
except ImportError:
    _PYGETWINDOW = False

if get_os() == "Windows":
    try:
        import win32con
        import win32gui
        _WIN32 = True
    except ImportError:
        _WIN32 = False
else:
    _WIN32 = False


# In-memory Working Scratchpad across window switching (Step 2)
_WORKING_SCRATCHPAD: dict[str, dict[str, Any]] = {}


def get_scratchpad(key: str = "main") -> dict[str, Any]:
    """Retrieve working scratchpad context."""
    return _WORKING_SCRATCHPAD.get(key, {}).copy()


def set_scratchpad(
    content: str,
    source_app: str = "",
    target_app: str = "",
    key: str = "main",
    metadata: dict | None = None,
) -> dict[str, Any]:
    """Store context in memory before switching windows (Step 2)."""
    entry = {
        "content": content,
        "source_app": source_app,
        "target_app": target_app,
        "timestamp": time.time(),
        "metadata": metadata or {},
    }
    _WORKING_SCRATCHPAD[key] = entry
    return entry.copy()


def clear_scratchpad(key: str = "main") -> None:
    """Clear working scratchpad after pipeline completes."""
    _WORKING_SCRATCHPAD.pop(key, None)


def list_scratchpads() -> dict[str, dict[str, Any]]:
    """List all active scratchpad entries."""
    return {k: v.copy() for k, v in _WORKING_SCRATCHPAD.items()}


def get_foreground_window_title() -> str:
    """Retrieve the title of the current foreground window."""
    if _WIN32:
        try:
            hwnd = win32gui.GetForegroundWindow()
            if hwnd:
                return win32gui.GetWindowText(hwnd).strip()
        except Exception:
            pass

    if _PYGETWINDOW and get_os() == "Windows":
        try:
            win = gw.getActiveWindow()
            if win and win.title:
                return win.title.strip()
        except Exception:
            pass

    if get_os() == "Darwin":
        try:
            res = subprocess.run(
                ["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
                capture_output=True, text=True, timeout=2
            )
            return res.stdout.strip()
        except Exception:
            pass

    return ""


def _normalize_app_query(app_name: str) -> list[str]:
    """Map common application identifiers to matching window title substrings."""
    query = app_name.lower().strip()
    mapping = {
        "brave": ["brave"],
        "chrome": ["google chrome", "chrome"],
        "edge": ["microsoft edge", "edge"],
        "firefox": ["firefox", "mozilla firefox"],
        "vscode": ["visual studio code", "code"],
        "vs code": ["visual studio code", "code"],
        "code": ["visual studio code", "code"],
        "cursor": ["cursor"],
        "whatsapp": ["whatsapp"],
        "telegram": ["telegram"],
        "messenger": ["messenger"],
        "facebook": ["facebook"],
        "linkedin": ["linkedin"],
        "notepad": ["notepad"],
        "terminal": ["terminal", "powershell", "cmd", "command prompt", "bash"],
        "powershell": ["powershell"],
        "spotify": ["spotify"],
        "discord": ["discord"],
    }
    return mapping.get(query, [query])


def verify_target_window_active(expected_app: str) -> tuple[bool, str]:
    """
    Verify that the target application window is active in the foreground (Step 3).
    Returns: (is_active: bool, current_title: str)
    """
    if not expected_app:
        return True, get_foreground_window_title()

    current_title = get_foreground_window_title()
    current_lower = current_title.lower()

    match_candidates = _normalize_app_query(expected_app)
    is_active = any(candidate in current_lower for candidate in match_candidates)
    return is_active, current_title


def focus_app_window(target_app: str) -> bool:
    """Attempt to bring the target application window to the foreground."""
    if not target_app:
        return True

    match_candidates = _normalize_app_query(target_app)

    # 1. Try win32gui window search & activation on Windows
    if _WIN32:
        found_hwnd = None

        def _enum_cb(hwnd, _):
            nonlocal found_hwnd
            if not win32gui.IsWindowVisible(hwnd):
                return True
            title = win32gui.GetWindowText(hwnd).strip()
            if not title:
                return True
            title_lower = title.lower()
            if any(cand in title_lower for cand in match_candidates):
                found_hwnd = hwnd
                return False
            return True

        try:
            win32gui.EnumWindows(_enum_cb, None)
            if found_hwnd:
                if win32gui.IsIconic(found_hwnd):
                    win32gui.ShowWindow(found_hwnd, win32con.SW_RESTORE)
                win32gui.SetForegroundWindow(found_hwnd)
                time.sleep(0.3)
                return True
        except Exception:
            pass

    # 2. Try pygetwindow
    if _PYGETWINDOW:
        try:
            for cand in match_candidates:
                wins = gw.getWindowsWithTitle(cand)
                if wins:
                    win = wins[0]
                    if hasattr(win, "isMinimized") and win.isMinimized:
                        win.restore()
                    win.activate()
                    time.sleep(0.3)
                    return True
        except Exception:
            pass

    # 3. Fallback: Alt+Tab
    if _PYAUTOGUI:
        switch_key = "command" if get_os() == "Darwin" else "alt"
        pyautogui.hotkey(switch_key, "tab")
        time.sleep(0.3)

    return False


def copy_to_clipboard(text: str) -> bool:
    """Write text directly to the system clipboard (Step 1)."""
    if _PYPERCLIP:
        try:
            pyperclip.copy(text)
            time.sleep(0.05)
            return True
        except Exception:
            pass
    return False


def paste_from_clipboard(
    target_app: str = "",
    press_enter: bool = False,
    verify_foreground: bool = True,
) -> str:
    """
    Verify foreground window and paste clipboard content via Ctrl+V (Step 1 & 3).
    """
    if not _PYAUTOGUI:
        return "pyautogui is required for clipboard pasting."

    if target_app and verify_foreground:
        is_active, title = verify_target_window_active(target_app)
        if not is_active:
            focus_app_window(target_app)
            time.sleep(0.2)
            is_active, title = verify_target_window_active(target_app)
            if not is_active:
                return (
                    f"Warning: Foreground mismatch before paste! Expected '{target_app}', "
                    f"but active window is '{title}'. Aborted paste to prevent pasting into wrong app."
                )

    paste_key = "command" if get_os() == "Darwin" else "ctrl"
    pyautogui.hotkey(paste_key, "v")
    time.sleep(0.1)

    if press_enter:
        pyautogui.press("enter")
        time.sleep(0.05)

    return "Pasted successfully via Ctrl+V."


def cross_app_transfer(
    text: str,
    target_app: str = "",
    source_app: str = "",
    press_enter: bool = False,
    clear_first: bool = False,
    verify_window: bool = True,
    key: str = "main",
) -> str:
    """
    [MODULE: CROSS-APP PIPELINE & CLIPBOARD BRIDGE]
    Full pipeline implementation:
    Step 1: Write text directly to system clipboard and press Ctrl+V for instant, zero-typo pasting.
    Step 2: Maintain a 'Working Scratchpad' in memory when switching windows.
    Step 3: Verify that target window is active in the foreground via Screen Vision / Window API.
    """
    if not text:
        return "No text provided for cross-app transfer."

    # Step 2: Maintain Working Scratchpad in memory
    set_scratchpad(content=text, source_app=source_app, target_app=target_app, key=key)

    # Step 1: Write directly to system clipboard
    if not copy_to_clipboard(text):
        return "Failed to copy text to system clipboard (pyperclip unavailable)."

    # Step 3: Switch & Verify target window in foreground
    if target_app:
        is_active, title = verify_target_window_active(target_app)
        if not is_active:
            focus_app_window(target_app)
            time.sleep(0.3)
            is_active, title = verify_target_window_active(target_app)
            if not is_active and verify_window:
                return (
                    f"[ClipboardBridge] [BLOCKED] Target window '{target_app}' is NOT active in foreground. "
                    f"Current window: '{title}'. Aborted paste to prevent data spill. "
                    f"Text preserved safely in Scratchpad ({len(text)} chars)."
                )

    # Optional: Clear field if requested
    if clear_first and _PYAUTOGUI:
        sel_key = "command" if get_os() == "Darwin" else "ctrl"
        pyautogui.hotkey(sel_key, "a")
        time.sleep(0.05)
        pyautogui.press("backspace")
        time.sleep(0.05)

    # Step 1: Instant zero-typo paste via Ctrl+V
    if _PYAUTOGUI:
        paste_key = "command" if get_os() == "Darwin" else "ctrl"
        pyautogui.hotkey(paste_key, "v")
        time.sleep(0.08)
        if press_enter:
            pyautogui.press("enter")
            time.sleep(0.05)

    preview = text[:60] + ("..." if len(text) > 60 else "")
    report = f"[ClipboardBridge] Transferred {len(text)} chars to '{target_app or 'active window'}' via Ctrl+V: \"{preview}\""
    if source_app:
        report += f" (Source: {source_app})"
    return report


def clipboard_bridge(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Main dispatch entrypoint for Cross-App Pipeline & Clipboard Bridge.
    Actions:
      - transfer / cross_app_transfer: Full pipeline (copy -> scratchpad -> verify window -> paste)
      - copy: Copy text to clipboard and save in scratchpad
      - paste: Verify foreground window and paste clipboard
      - switch_and_paste: Focus target app, verify foreground, paste
      - get_scratchpad: Read current scratchpad context
      - set_scratchpad: Save text to scratchpad
      - clear_scratchpad: Clear scratchpad
      - verify_window: Check if expected window is active
    """
    params = parameters or {}
    action = params.get("action", "transfer").lower().strip()
    text = str(params.get("text") or params.get("content") or "").strip()
    target_app = str(params.get("target_app") or params.get("target") or params.get("app") or "").strip()
    source_app = str(params.get("source_app") or params.get("source") or "").strip()
    press_enter = bool(params.get("press_enter") or params.get("enter") or False)
    clear_first = bool(params.get("clear_first") or params.get("clear") or False)
    verify_window = bool(params.get("verify_window", True))
    key = str(params.get("key", "main"))

    if action in ("transfer", "cross_app_transfer", "copy_and_paste"):
        return cross_app_transfer(
            text=text,
            target_app=target_app,
            source_app=source_app,
            press_enter=press_enter,
            clear_first=clear_first,
            verify_window=verify_window,
            key=key,
        )

    if action == "copy":
        if not text:
            return "No text provided to copy."
        set_scratchpad(content=text, source_app=source_app, target_app=target_app, key=key)
        ok = copy_to_clipboard(text)
        if ok:
            return f"Copied {len(text)} chars to clipboard and stored in Scratchpad."
        return "Failed to copy to clipboard."

    if action == "paste":
        if text:
            copy_to_clipboard(text)
        return paste_from_clipboard(target_app=target_app, press_enter=press_enter, verify_foreground=verify_window)

    if action in ("switch_and_paste", "focus_and_paste"):
        pad = get_scratchpad(key=key)
        paste_text = text or pad.get("content", "")
        return cross_app_transfer(
            text=paste_text,
            target_app=target_app or pad.get("target_app", ""),
            source_app=source_app or pad.get("source_app", ""),
            press_enter=press_enter,
            clear_first=clear_first,
            verify_window=verify_window,
            key=key,
        )

    if action == "get_scratchpad":
        pad = get_scratchpad(key=key)
        if not pad:
            return "Scratchpad is empty."
        return (
            f"Scratchpad [{key}]: {len(pad.get('content', ''))} chars | "
            f"Source: {pad.get('source_app', 'N/A')} | Target: {pad.get('target_app', 'N/A')}\n"
            f"Content: \"{pad.get('content', '')[:120]}\""
        )

    if action == "set_scratchpad":
        set_scratchpad(content=text, source_app=source_app, target_app=target_app, key=key)
        return f"Stored {len(text)} chars in Scratchpad [{key}]."

    if action == "clear_scratchpad":
        clear_scratchpad(key=key)
        return f"Scratchpad [{key}] cleared."

    if action == "verify_window":
        is_active, title = verify_target_window_active(target_app)
        status = "ACTIVE" if is_active else "NOT ACTIVE"
        return f"Target '{target_app}' is {status}. Current window: '{title}'."

    return f"Unknown action: '{action}'."
