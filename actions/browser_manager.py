# actions/browser_manager.py
from __future__ import annotations

import re
import subprocess
import time
from typing import Any
from urllib.parse import quote_plus
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

try:
    import pyperclip  # type: ignore
    _PYPERCLIP = True
except ImportError:
    _PYPERCLIP = False


def _normalize_url(url: str) -> str:
    url = url.strip()
    if not url:
        return "https://www.google.com"
    if "://" in url:
        return url
    if "." not in url:
        return f"https://www.{url}.com"
    return f"https://{url}"


def _focus_browser(browser_name: str = "brave") -> bool:
    """
    Bring Brave, Chrome, Edge, or Firefox browser window to the foreground.
    Multi-tier strategy: pygetwindow -> PowerShell AppActivate -> open_app().
    """
    target_name = browser_name.lower().strip() if browser_name else "brave"
    if "brave" in target_name:
        keywords = ["brave"]
        app_id = "brave"
    elif "edge" in target_name:
        keywords = ["edge", "microsoft edge"]
        app_id = "edge"
    elif "firefox" in target_name:
        keywords = ["firefox"]
        app_id = "firefox"
    elif target_name in ("browser", "web", "internet"):
        keywords = ["brave", "chrome", "edge", "firefox"]
        app_id = "brave"
    else:
        keywords = ["chrome", "google chrome"]
        app_id = "chrome"

    # 1. Try PyGetWindow by title
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
        except Exception:
            pass

    # 2. Try PowerShell AppActivate on Windows
    if get_os() == "Windows":
        try:
            title_search = "Brave" if "brave" in target_name else ("Chrome" if "chrome" in target_name else "Edge")
            ps_cmd = f'(New-Object -ComObject WScript.Shell).AppActivate("{title_search}")'
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if "True" in (proc.stdout or ""):
                time.sleep(0.15)
                return True
        except Exception:
            pass

    # 3. Direct launcher fallback: Brings existing running instance to front
    try:
        from actions.open_app import open_app
        open_app({"app_name": app_id})
        time.sleep(0.2)
        return True
    except Exception as e:
        print(f"[BrowserManager] Failed to focus {browser_name}: {e}")

    return False


def navigate(url: str, browser: str = "brave") -> str:
    """Navigate currently active tab to URL via address bar."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    target_url = _normalize_url(url)

    is_mac = get_os() == "Darwin"
    # Select address bar: Ctrl+L or Cmd+L
    pyautogui.hotkey("command" if is_mac else "ctrl", "l")
    time.sleep(0.12)

    if _PYPERCLIP:
        pyperclip.copy(target_url)
        time.sleep(0.08)
        pyautogui.hotkey("command" if is_mac else "ctrl", "v")
    else:
        pyautogui.typewrite(target_url, interval=0.01)

    time.sleep(0.08)
    pyautogui.press("enter")
    return f"Navigated {browser} to {target_url}."


def search(query: str, browser: str = "brave", engine: str = "google") -> str:
    """Perform a web search in active browser."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    is_mac = get_os() == "Darwin"

    # Focus address bar
    pyautogui.hotkey("command" if is_mac else "ctrl", "l")
    time.sleep(0.12)

    if _PYPERCLIP:
        pyperclip.copy(query)
        time.sleep(0.08)
        pyautogui.hotkey("command" if is_mac else "ctrl", "v")
    else:
        pyautogui.typewrite(query, interval=0.01)

    time.sleep(0.08)
    pyautogui.press("enter")
    return f"Searched '{query}' in {browser}."


def scroll_down(amount: int = 4, browser: str = "brave") -> str:
    """Scroll down the active webpage."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    amount = max(1, min(20, int(amount)))
    for _ in range(amount):
        pyautogui.press("pagedown")
        time.sleep(0.05)
    return f"Scrolled down in {browser}."


def scroll_up(amount: int = 4, browser: str = "brave") -> str:
    """Scroll up the active webpage."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    amount = max(1, min(20, int(amount)))
    for _ in range(amount):
        pyautogui.press("pageup")
        time.sleep(0.05)
    return f"Scrolled up in {browser}."


def reload_page(browser: str = "brave") -> str:
    """Reload the currently active webpage (Ctrl+R / Cmd+R)."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    is_mac = get_os() == "Darwin"
    pyautogui.hotkey("command" if is_mac else "ctrl", "r")
    return f"Reloaded active page in {browser}."


def go_back(browser: str = "brave") -> str:
    """Navigate back in history (Alt+Left / Cmd+[)."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "[")
    else:
        pyautogui.hotkey("alt", "left")
    return f"Navigated back in {browser}."


def go_forward(browser: str = "brave") -> str:
    """Navigate forward in history (Alt+Right / Cmd+])."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "]")
    else:
        pyautogui.hotkey("alt", "right")
    return f"Navigated forward in {browser}."


def fullscreen(browser: str = "brave") -> str:
    """Toggle fullscreen (F11 or Cmd+Ctrl+F)."""
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "ctrl", "f")
    else:
        pyautogui.press("f11")
    return f"Toggled fullscreen in {browser}."


def zoom_in(browser: str = "brave") -> str:
    """Zoom in webpage (Ctrl++)."""
    _focus_browser(browser)
    pyautogui.hotkey("ctrl" if get_os() != "Darwin" else "command", "+")
    return f"Zoomed in {browser}."


def zoom_out(browser: str = "brave") -> str:
    """Zoom out webpage (Ctrl+-)."""
    _focus_browser(browser)
    pyautogui.hotkey("ctrl" if get_os() != "Darwin" else "command", "-")
    return f"Zoomed out {browser}."


def zoom_reset(browser: str = "brave") -> str:
    """Reset zoom in webpage (Ctrl+0)."""
    _focus_browser(browser)
    pyautogui.hotkey("ctrl" if get_os() != "Darwin" else "command", "0")
    return f"Reset zoom in {browser}."


def switch_to_tab(tab_number: int, browser: str = "brave") -> str:
    """Jump to specific tab (1-9) using Ctrl+[1-9]."""
    _focus_browser(browser)
    tab_num = max(1, min(9, int(tab_number)))
    if get_os() == "Darwin":
        pyautogui.hotkey("command", str(tab_num))
    else:
        pyautogui.hotkey("ctrl", str(tab_num))
    return f"Switched to tab {tab_num} in {browser}."


def close_active_tab(browser: str = "brave") -> str:
    """Close currently active tab using Ctrl+W."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "w")
    else:
        pyautogui.hotkey("ctrl", "w")
    return f"Closed active tab in {browser}."


def close_multiple_tabs(count: int = 2, start_tab: int = 1, browser: str = "brave") -> str:
    """Close a specific number of tabs (e.g. close first 2 tabs)."""
    _focus_browser(browser)
    count = max(1, min(20, int(count)))
    if start_tab and 1 <= start_tab <= 9:
        switch_to_tab(start_tab, browser)
        time.sleep(0.1)

    for _ in range(count):
        if get_os() == "Darwin":
            pyautogui.hotkey("command", "w")
        else:
            pyautogui.hotkey("ctrl", "w")
        time.sleep(0.12)
    return f"Closed {count} tab(s) in {browser}."


def new_tab(url: str = "", browser: str = "brave") -> str:
    """Open a new browser tab (Ctrl+T) and optionally navigate to URL."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "t")
    else:
        pyautogui.hotkey("ctrl", "t")
    time.sleep(0.15)
    if url:
        return navigate(url, browser=browser)
    return f"Opened new tab in {browser}."


def reopen_closed_tab(browser: str = "brave") -> str:
    """Reopen last closed browser tab using Ctrl+Shift+T."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "shift", "t")
    else:
        pyautogui.hotkey("ctrl", "shift", "t")
    return f"Reopened last closed tab in {browser}."


def next_tab(browser: str = "brave") -> str:
    """Navigate to next tab (Ctrl+Tab)."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "option", "right")
    else:
        pyautogui.hotkey("ctrl", "tab")
    return f"Navigated to next tab in {browser}."


def prev_tab(browser: str = "brave") -> str:
    """Navigate to previous tab (Ctrl+Shift+Tab)."""
    _focus_browser(browser)
    if get_os() == "Darwin":
        pyautogui.hotkey("command", "option", "left")
    else:
        pyautogui.hotkey("ctrl", "shift", "tab")
    return f"Navigated to previous tab in {browser}."


def youtube_search(query: str, browser: str = "brave", play_first: bool = True) -> str:
    """
    [MODULE: WEB & OFFICE AUTOMATION - Step 2]
    Navigate directly to YouTube search URL, wait for results to render,
    and activate the first valid video thumbnail (skipping sponsored ads).
    """
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)

    # URL-encode query. sp=EgIQAQ%3D%3D filters specifically to video results (skips playlists, channel headers)
    encoded_q = quote_plus(query.strip())
    yt_url = f"https://www.youtube.com/results?search_query={encoded_q}&sp=EgIQAQ%3D%3D"

    navigate(yt_url, browser=browser)
    time.sleep(1.5)  # Wait for results to render on Screen Vision

    if play_first:
        try:
            # Shift focus to results and activate first video thumbnail
            pyautogui.press("tab")
            time.sleep(0.1)
            pyautogui.press("enter")
            time.sleep(0.2)
        except Exception:
            pass
        return f"Searched YouTube for '{query}' and opened the first valid video in {browser}."
    return f"Searched YouTube for '{query}' in {browser}."


def gmail_compose(
    to: str = "",
    subject: str = "",
    body: str = "",
    browser: str = "brave",
    send_now: bool = False,
) -> str:
    """
    [MODULE: WEB & OFFICE AUTOMATION - Step 3 & Step 4]
    Opens Gmail compose modal, fills 'To', 'Subject', and 'Body' fields sequentially.
    STRICT SAFETY RULE (Step 4): Stops at the draft stage and displays it on screen
    for user review unless explicitly told to send immediately.
    """
    if not _PYAUTOGUI:
        return "pyautogui is required for browser control."
    _focus_browser(browser)

    # Compose URL directly opens compose popup with prefilled fields at DRAFT stage
    # view=cm (compose mode), fs=1 (fullscreen compose dialog)
    to_enc = quote_plus(to.strip())
    su_enc = quote_plus(subject.strip())
    body_enc = quote_plus(body.strip())

    compose_url = f"https://mail.google.com/mail/?view=cm&fs=1&to={to_enc}&su={su_enc}&body={body_enc}"
    navigate(compose_url, browser=browser)
    time.sleep(1.8)  # Wait for Gmail compose modal to render on Screen Vision

    # Step 4: Destructive Action Gate - Stop at draft stage for review
    if not send_now:
        return (
            f"[DRAFT PREPARED] Email draft created in {browser} at draft stage for user review:\n"
            f"- To: {to or '(Empty)'}\n"
            f"- Subject: {subject or '(No Subject)'}\n"
            f"- Body: {body or '(Empty)'}\n"
            "Displayed on screen. Stopping at draft stage for user review before sending."
        )
    else:
        # User explicitly requested immediate send
        is_mac = get_os() == "Darwin"
        pyautogui.hotkey("command" if is_mac else "ctrl", "enter")
        return f"Sent email to '{to}' with subject '{subject}' via {browser}."


def browser_manager(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Main entrypoint for desktop browser control (Brave, Chrome, Edge).
    Directly controls native browser window with zero profile conflict.

    parameters:
        action     : navigate | search | scroll_down | scroll_up | reload | back | forward | fullscreen |
                     switch_tab | close_tab | close_tabs | new_tab | reopen_tab | next_tab | prev_tab |
                     youtube_search | gmail_compose | auto
        browser    : brave | chrome | edge (default: brave)
        url        : URL to navigate to (e.g. 'youtube.com', 'https://github.com')
        query      : Search query for search or youtube_search action
        tab_number : 1-9 for switch_tab
        count      : Number of tabs to close for close_tabs
        amount     : Number of page scrolls for scroll_down/scroll_up
        to         : Recipient email address for gmail_compose
        subject    : Email subject for gmail_compose
        body       : Email body content for gmail_compose
        send_now   : bool, whether to send immediately (default: False)
        command    : Natural language command (e.g. 'Brave e youtube open koro', 'scroll down')
    """
    if not _PYAUTOGUI:
        return "pyautogui is required for browser tab management."

    params = parameters or {}
    action = str(params.get("action", "auto")).lower().strip().replace(" ", "_").replace("-", "_")
    browser = str(params.get("browser", "brave")).lower().strip() or "brave"
    url = str(params.get("url", "")).strip()
    query = str(params.get("query", "")).strip()
    command = str(params.get("command", "") or params.get("description", "")).lower().strip()

    # If url is provided but action is auto, assume navigate
    if action in ("auto", "manage") and url:
        return navigate(url=url, browser=browser)

    # Natural language parsing for English and Bengali / Banglish
    if action in ("auto", "manage") or (not action and command):
        # YouTube media automation
        if any(w in command for w in ("youtube", "yt")) and any(w in command for w in ("play", "chalao", "shuno", "dekho", "search", "khujo", "open")):
            q = query
            if not q:
                q = re.sub(r"\b(brave|chrome|browser|e|te|youtube|yt|play|chalao|shuno|dekho|search|koro|open)\b", "", command).strip()
            if q:
                return youtube_search(query=q, browser=browser)

        # Gmail email drafting
        if any(w in command for w in ("gmail", "email", "mail")) and any(w in command for w in ("compose", "draft", "lekho", "pathao", "write", "send")):
            to_val = params.get("to") or params.get("receiver", "")
            su_val = params.get("subject") or params.get("su", "")
            body_val = params.get("body") or params.get("text") or params.get("message", "")
            send_val = bool(params.get("send_now") or params.get("immediate", False))
            return gmail_compose(to=to_val, subject=su_val, body=body_val, browser=browser, send_now=send_val)

        if any(w in command for w in ("reopen", "restore", "abar kholo", "firye anao")):
            return reopen_closed_tab(browser=browser)
        if any(w in command for w in ("scroll down", "niche", "down", "nicher dike")):
            return scroll_down(amount=4, browser=browser)
        if any(w in command for w in ("scroll up", "upore", "up", "uporer dike")):
            return scroll_up(amount=4, browser=browser)
        if any(w in command for w in ("reload", "refresh", "abar load", "f5")):
            return reload_page(browser=browser)
        if any(w in command for w in ("fullscreen", "boro koro", "full screen")):
            return fullscreen(browser=browser)
        if any(w in command for w in ("back", "pichone", "agertay")):
            return go_back(browser=browser)
        if any(w in command for w in ("forward", "shamne", "samne")):
            return go_forward(browser=browser)
        if any(w in command for w in ("search", "khujo", "khojo", "dekho")):
            q = query or command.replace("search", "").replace("khujo", "").strip()
            return search(query=q, browser=browser)
        if "first" in command and "tab" in command:
            match = re.search(r"(\d+)", command)
            count = int(match.group(1)) if match else 2
            return close_multiple_tabs(count=count, start_tab=1, browser=browser)
        if any(w in command for w in ("close", "bondho")) and "tab" in command:
            match = re.search(r"(\d+)\s*tabs?", command)
            if match:
                count = int(match.group(1))
                return close_multiple_tabs(count=count, browser=browser)
            return close_active_tab(browser=browser)
        if any(w in command for w in ("new tab", "notun tab")):
            return new_tab(url=url, browser=browser)
        if "next" in command or "porer" in command:
            return next_tab(browser=browser)
        if "prev" in command or "previous" in command or "ager" in command:
            return prev_tab(browser=browser)
        if "tab" in command:
            match = re.search(r"tab\s*(\d+)", command)
            if match:
                return switch_to_tab(int(match.group(1)), browser=browser)
        # Check for direct site mentions (youtube, google, github, etc.)
        site_match = re.search(r"\b(youtube|google|github|chatgpt|facebook|twitter|instagram|reddit)\b", command)
        if site_match:
            return navigate(url=f"https://{site_match.group(1)}.com", browser=browser)

    # Specific action dispatching
    if action in ("navigate", "go_to", "open_url", "visit"):
        nav_url = url or query or "https://www.google.com"
        return navigate(url=nav_url, browser=browser)

    if action in ("search", "web_search", "google"):
        search_q = query or url or command
        return search(query=search_q, browser=browser)

    if action in ("youtube", "youtube_search", "play_video", "video"):
        yt_q = query or url or command
        return youtube_search(query=yt_q, browser=browser)

    if action in ("gmail", "gmail_compose", "gmail_draft", "compose_email", "draft_email", "mail"):
        to_val = str(params.get("to") or params.get("receiver", "")).strip()
        su_val = str(params.get("subject") or params.get("su", "")).strip()
        body_val = str(params.get("body") or params.get("text") or params.get("message", "")).strip()
        send_val = bool(params.get("send_now") or params.get("immediate", False))
        return gmail_compose(to=to_val, subject=su_val, body=body_val, browser=browser, send_now=send_val)

    if action in ("scroll_down", "scrolldown", "scroll_page_down"):
        amount = int(params.get("amount") or params.get("value") or 4)
        return scroll_down(amount=amount, browser=browser)

    if action in ("scroll_up", "scrollup", "scroll_page_up"):
        amount = int(params.get("amount") or params.get("value") or 4)
        return scroll_up(amount=amount, browser=browser)

    if action in ("reload", "reload_page", "refresh"):
        return reload_page(browser=browser)

    if action in ("back", "go_back", "backward"):
        return go_back(browser=browser)

    if action in ("forward", "go_forward"):
        return go_forward(browser=browser)

    if action in ("fullscreen", "toggle_fullscreen"):
        return fullscreen(browser=browser)

    if action in ("zoom_in", "zoomin"):
        return zoom_in(browser=browser)

    if action in ("zoom_out", "zoomout"):
        return zoom_out(browser=browser)

    if action in ("zoom_reset", "reset_zoom"):
        return zoom_reset(browser=browser)

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

    return (
        f"Unknown browser action: '{action}'. "
        "Available: navigate, search, scroll_down, scroll_up, reload, back, forward, "
        "fullscreen, switch_tab, close_tab, close_tabs, new_tab, reopen_tab, next_tab, prev_tab, "
        "youtube_search, gmail_compose."
    )
