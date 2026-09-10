# actions/browser_manager.py
import re
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


def _focus_browser(browser_name: str = "chrome") -> bool:
    """Bring Google Chrome or Brave Browser window to the foreground."""
    target_name = browser_name.lower().strip()
    keywords = ["chrome", "google chrome"] if "brave" not in target_name else ["brave"]
    if target_name in ("browser", "web", "internet"):
        keywords = ["chrome", "brave", "edge", "firefox"]

    if _PYGETWINDOW:
        try:
            windows = gw.getAllWindows()
            for win in windows:
                title = (win.title or "").lower()
                if any(k in title for k in keywords):
                    if hasattr(win, "isMinimized") and win.isMinimized:
                        win.restore()
                    win.activate()
                    time.sleep(0.15)
                    return True
        except Exception as e:
            print(f"[BrowserManager] pygetwindow focus failed: {e}")

    # Fallback to keypress / app open
    return False


def switch_to_tab(tab_number: int, browser: str = "chrome") -> str:
    """Jump to specific tab (1-9) using Ctrl+[1-9]."""
    _focus_browser(browser)
    tab_num = max(1, min(9, int(tab_number)))
    if get_os() == "Darwin":
        pyautogui.hotkey("command", str(tab_num))
    else:
        pyautogui.hotkey("ctrl", str(tab_num))
    return f"Switched to tab {tab_num}."


def close_active_tab(browser: str = "chrome") -> str:
    """Close currently active tab using Ctrl+W."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "w")
    else:
        pyautogui.hotkey("ctrl", "w")
    return "Closed active browser tab."


def close_multiple_tabs(count: int = 2, start_tab: int = 1, browser: str = "chrome") -> str:
    """Close a specific number of tabs (e.g. close first 2 tabs)."""
    _focus_browser(browser)
    count = max(1, min(20, int(count)))
    if start_tab and 1 <= start_tab <= 9:
        switch_to_tab(start_tab, browser)
        time.sleep(0.1)

    for i in range(count):
        if get_os() == "Darwin":
            pyautogui.hotkey("command", "w")
        else:
            pyautogui.hotkey("ctrl", "w")
        time.sleep(0.12)
    return f"Closed {count} browser tab(s)."


def new_tab(url: str = "", browser: str = "chrome") -> str:
    """Open a new browser tab (Ctrl+T) and optionally navigate to URL."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "t")
    else:
        pyautogui.hotkey("ctrl", "t")
    time.sleep(0.15)
    if url:
        import pyperclip  # type: ignore
        pyperclip.copy(url)
        time.sleep(0.1)
        if get_os() == "Darwin":
            pyautogui.hotkey("command", "v")
        else:
            pyautogui.hotkey("ctrl", "v")
        time.sleep(0.05)
        pyautogui.press("enter")
        return f"Opened new tab with URL: {url}"
    return "Opened new browser tab."


def reopen_closed_tab(browser: str = "chrome") -> str:
    """Reopen last closed browser tab using Ctrl+Shift+T."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "shift", "t")
    else:
        pyautogui.hotkey("ctrl", "shift", "t")
    return "Reopened last closed tab."


def next_tab(browser: str = "chrome") -> str:
    """Navigate to next tab (Ctrl+Tab)."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "option", "right")
    else:
        pyautogui.hotkey("ctrl", "tab")
    return "Navigated to next tab."


def prev_tab(browser: str = "chrome") -> str:
    """Navigate to previous tab (Ctrl+Shift+Tab)."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "option", "left")
    else:
        pyautogui.hotkey("ctrl", "shift", "tab")
    return "Navigated to previous tab."


def browser_manager(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Main entrypoint for Chrome & Brave browser tab management.

    parameters:
        action     : switch_tab | close_tab | close_tabs | new_tab | reopen_tab | next_tab | prev_tab | auto
        tab_number : 1-9 for switch_tab
        count      : Number of tabs to close for close_tabs
        url        : URL to navigate to for new_tab
        browser    : chrome | brave (default: chrome)
        command    : Natural language command (e.g. 'close the first 2 tabs')
    """
    if not _PYAUTOGUI:
        return "pyautogui is required for browser tab management."

    params = parameters or {}
    action = str(params.get("action", "auto")).lower().strip().replace(" ", "_").replace("-", "_")
    browser = str(params.get("browser", "chrome")).lower().strip()
    url = str(params.get("url", "")).strip()
    command = str(params.get("command", "") or params.get("description", "")).lower().strip()

    # Parse natural language if action is auto or command provided
    if action in ("auto", "manage") or (not action and command):
        if "reopen" in command or "restore" in command:
            action = "reopen_tab"
        elif "first" in command and "tab" in command:
            match = re.search(r"(\d+)", command)
            count = int(match.group(1)) if match else 2
            return close_multiple_tabs(count=count, start_tab=1, browser=browser)
        elif "close" in command and "tab" in command:
            match = re.search(r"(\d+)\s*tabs?", command)
            if match:
                count = int(match.group(1))
                return close_multiple_tabs(count=count, browser=browser)
            action = "close_tab"
        elif "new" in command and "tab" in command:
            action = "new_tab"
        elif "next" in command:
            action = "next_tab"
        elif "previous" in command or "prev" in command:
            action = "prev_tab"
        elif "tab" in command:
            match = re.search(r"tab\s*(\d+)", command)
            if match:
                return switch_to_tab(int(match.group(1)), browser=browser)

    if action in ("switch_tab", "switch_to_tab", "goto_tab", "jump_tab"):
        tab_num = int(params.get("tab_number") or params.get("value") or 1)
        return switch_to_tab(tab_num, browser=browser)

    if action in ("close_tab", "close_active_tab", "close_current_tab"):
        return close_active_tab(browser=browser)

    if action in ("close_tabs", "close_multiple_tabs", "close_first_tabs"):
        count = int(params.get("count") or params.get("value") or 2)
        start_tab = int(params.get("start_tab") or 1)
        return close_multiple_tabs(count=count, start_tab=start_tab, browser=browser)

    if action in ("new_tab", "open_tab", "create_tab"):
        return new_tab(url=url, browser=browser)

    if action in ("reopen_tab", "undo_close_tab", "restore_tab"):
        return reopen_closed_tab(browser=browser)

    if action in ("next_tab", "forward_tab"):
        return next_tab(browser=browser)

    if action in ("prev_tab", "previous_tab", "back_tab"):
        return prev_tab(browser=browser)

    return f"Unknown browser action: '{action}'. Available: switch_tab, close_tab, close_tabs, new_tab, reopen_tab, next_tab, prev_tab."
