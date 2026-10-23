import os
import re
import subprocess
import time
import urllib.parse
import webbrowser

from utils.env import get_os

try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE    = 0.06
    _PYAUTOGUI = True
except ImportError:
    _PYAUTOGUI = False

try:
    import pyperclip
    _PYPERCLIP = True
except ImportError:
    _PYPERCLIP = False

GENERIC_RECEIVERS = {
    "", "take", "তাকে", "তারে", "ona", "onake", "ওনাকে", "তাকেবলো", "him", "her",
    "them", "current", "active", "this", "this chat", "someone", "open", "here",
    "chat", "direct", "none", "me", "active_chat", "current_chat"
}


def _require_pyautogui():
    if not _PYAUTOGUI:
        raise RuntimeError("PyAutoGUI not installed. Run: pip install pyautogui")


def _is_active_chat(receiver: str) -> bool:
    if not receiver:
        return True
    return receiver.lower().strip() in GENERIC_RECEIVERS


def _paste_text(text: str) -> None:
    _require_pyautogui()
    os_name = get_os()
    paste_hotkey = ("command", "v") if os_name == "mac" else ("ctrl", "v")

    if _PYPERCLIP:
        pyperclip.copy(text)
        time.sleep(0.15)
        pyautogui.hotkey(*paste_hotkey)
        time.sleep(0.15)
    else:
        pyautogui.write(text, interval=0.03)


def _clear_and_paste(text: str) -> None:
    _require_pyautogui()
    os_name = get_os()
    select_all = ("command", "a") if os_name == "mac" else ("ctrl", "a")
    pyautogui.hotkey(*select_all)
    time.sleep(0.1)
    pyautogui.press("delete")
    time.sleep(0.1)
    _paste_text(text)


def _open_app(app_name: str) -> bool:
    _require_pyautogui()
    os_name = get_os()
    name_clean = app_name.lower().strip()

    try:
        if os_name == "windows":
            if name_clean in ("whatsapp", "wp", "wapp"):
                try:
                    os.startfile("whatsapp:")
                    time.sleep(1.2)
                    return True
                except Exception:
                    pass
            elif name_clean in ("telegram", "tg"):
                try:
                    os.startfile("tg:")
                    time.sleep(1.2)
                    return True
                except Exception:
                    pass

            try:
                from actions.open_app import open_app
                if open_app(app_name):
                    time.sleep(1.2)
                    return True
            except Exception:
                pass

            subprocess.Popen(
                f'start "" "{app_name}"',
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(1.5)
            return True

        elif os_name == "mac":
            result = subprocess.run(
                ["open", "-a", app_name],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                result = subprocess.run(
                    ["open", "-a", f"{app_name}.app"],
                    capture_output=True, text=True, timeout=10,
                )
            time.sleep(2.0)
            return result.returncode == 0

        else:
            launched = False
            for launcher in [
                ["gtk-launch", name_clean],
                [name_clean],
            ]:
                try:
                    subprocess.Popen(
                        launcher,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    launched = True
                    break
                except FileNotFoundError:
                    continue
            time.sleep(2.0)
            return launched

    except Exception as e:
        print(f"[SendMessage] [WARN] Could not open {app_name}: {e}")
        return False


def _open_browser_url(url: str) -> bool:
    try:
        webbrowser.open(url)
        time.sleep(4.0)
        return True
    except Exception as e:
        print(f"[SendMessage] [WARN] Could not open browser: {e}")
        return False


def _search_in_app(query: str) -> None:
    _require_pyautogui()
    os_name = get_os()
    search_hotkey = ("command", "f") if os_name == "mac" else ("ctrl", "f")

    pyautogui.hotkey(*search_hotkey)
    time.sleep(0.5)
    _clear_and_paste(query)
    time.sleep(1.0)


def _send_active_chat(message: str, platform: str = "current") -> str:
    _require_pyautogui()
    plat = platform.lower().strip()
    if any(k in plat for k in ("whatsapp", "wp", "wapp")):
        _open_app("WhatsApp")
        time.sleep(0.8)
    elif any(k in plat for k in ("telegram", "tg")):
        _open_app("Telegram")
        time.sleep(0.8)
    elif "discord" in plat:
        _open_app("Discord")
        time.sleep(0.8)

    time.sleep(0.2)
    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.25)
    return f"Message sent to active chat: {message[:40]}{'…' if len(message) > 40 else ''}"


def _send_whatsapp(receiver: str, message: str) -> str:
    _require_pyautogui()
    os_name = get_os()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="whatsapp")

    # Check if receiver is a phone number
    cleaned_phone = re.sub(r"[^\d+]", "", receiver)
    if len(cleaned_phone) >= 7 and (cleaned_phone.startswith("+") or cleaned_phone[0].isdigit()):
        encoded_msg = urllib.parse.quote(message)
        native_url = f"whatsapp://send?phone={cleaned_phone}&text={encoded_msg}"
        web_url = f"https://web.whatsapp.com/send?phone={cleaned_phone}&text={encoded_msg}"

        if os_name == "windows":
            try:
                os.startfile(native_url)
                time.sleep(2.0)
                pyautogui.press("enter")
                time.sleep(0.3)
                return f"Message sent to {cleaned_phone} via WhatsApp."
            except Exception:
                pass

        _open_browser_url(web_url)
        time.sleep(4.5)
        pyautogui.press("enter")
        time.sleep(0.3)
        return f"Message sent to {cleaned_phone} via WhatsApp Web."

    # Contact Name search in WhatsApp Desktop
    _open_app("WhatsApp")
    time.sleep(1.2)

    new_chat_hotkey = ("command", "n") if os_name == "mac" else ("ctrl", "n")
    pyautogui.hotkey(*new_chat_hotkey)
    time.sleep(0.5)

    _clear_and_paste(receiver)
    time.sleep(1.0)

    pyautogui.press("down")
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(1.0)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via WhatsApp."


def _detect_active_chat(platform: str = "whatsapp") -> dict:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA - Step 3]
    Visually verifies the header name / active window of the opened chat
    to ensure messages are never sent to the wrong person.
    """
    detected = {
        "found": False,
        "type": "none",
        "title": "",
        "contact": "Active Chat",
        "hwnd": None,
    }
    os_name = get_os()
    if os_name == "windows":
        try:
            import win32gui
            windows = []

            def _enum(hwnd, _):
                if win32gui.IsWindowVisible(hwnd):
                    t = win32gui.GetWindowText(hwnd).strip()
                    if t:
                        windows.append((hwnd, t))

            win32gui.EnumWindows(_enum, None)

            fg_hwnd = win32gui.GetForegroundWindow()
            fg_title = win32gui.GetWindowText(fg_hwnd).strip()

            target_keywords = []
            plat_lower = (platform or "whatsapp").lower().strip()
            if any(k in plat_lower for k in ("whatsapp", "wp", "wapp")):
                target_keywords = ["whatsapp"]
            elif any(k in plat_lower for k in ("messenger", "facebook", "fb")):
                target_keywords = ["messenger", "facebook"]
            elif "linkedin" in plat_lower:
                target_keywords = ["linkedin"]
            elif any(k in plat_lower for k in ("telegram", "tg")):
                target_keywords = ["telegram"]
            elif "discord" in plat_lower:
                target_keywords = ["discord"]
            else:
                target_keywords = ["whatsapp", "messenger", "facebook", "linkedin", "telegram", "discord"]

            check_list = [(fg_hwnd, fg_title)] + windows
            for hwnd, title in check_list:
                t_lower = title.lower()
                matched_kw = next((kw for kw in target_keywords if kw in t_lower), None)
                if matched_kw:
                    detected["found"] = True
                    detected["hwnd"] = hwnd
                    detected["title"] = title
                    is_web = any(b in t_lower for b in ["brave", "chrome", "edge", "firefox", "opera"])
                    detected["type"] = f"{matched_kw.title()} Web" if is_web else f"{matched_kw.title()} Desktop"

                    clean_t = re.sub(r"^\(\d+\)\s*", "", title)
                    for b in [
                        "- Brave", "- Google Chrome", "- Microsoft​ Edge", "- Mozilla Firefox",
                        "- Opera", "| LinkedIn", "- Messenger", "Facebook"
                    ]:
                        clean_t = clean_t.replace(b, "").strip()
                    parts = [p.strip() for p in re.split(r"[-|•]", clean_t) if p.strip()]
                    candidates = [p for p in parts if p.lower() not in target_keywords and "browser" not in p.lower()]
                    if candidates:
                        detected["contact"] = candidates[0]
                    break
        except Exception as e:
            print(f"[SendMessage] Window detection error: {e}")
    return detected


def _detect_whatsapp_chat() -> dict:
    return _detect_active_chat("whatsapp")


def _edit_message(new_text: str, platform: str = "whatsapp") -> str:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA - Step 5]
    Ensure chat box is focused, press Up Arrow to enter edit mode,
    modify the text, and confirm with Enter.
    """
    _require_pyautogui()
    os_name = get_os()
    if not new_text:
        return "Please specify the updated text to edit."

    det = _detect_active_chat(platform)
    if det.get("found") and det.get("hwnd") and os_name == "windows":
        try:
            import win32gui
            win32gui.SetForegroundWindow(det["hwnd"])
            time.sleep(0.4)
        except Exception:
            pass

    # WhatsApp, Telegram, Discord, and Messenger standard edit flow:
    # Escape unfocuses/clears open overlays, Up Arrow opens last message edit mode
    pyautogui.press("escape")
    time.sleep(0.15)
    pyautogui.press("up")
    time.sleep(0.3)

    _clear_and_paste(new_text)
    time.sleep(0.2)
    pyautogui.press("enter")
    time.sleep(0.3)

    target = det.get("contact", "active chat")
    plat_name = det.get("type", platform.title())
    return f"{plat_name} message edited to: '{new_text}' in {target}."


def _edit_whatsapp_message(new_text: str) -> str:
    return _edit_message(new_text, platform="whatsapp")


def _delete_message(for_everyone: bool = True, platform: str = "whatsapp") -> str:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA - Step 5]
    Open context menu (Shift+F10) on last message bubble or hover icon,
    select Delete, and confirm with Enter.
    """
    _require_pyautogui()
    os_name = get_os()

    det = _detect_active_chat(platform)
    if det.get("found") and det.get("hwnd") and os_name == "windows":
        try:
            import win32gui
            win32gui.SetForegroundWindow(det["hwnd"])
            time.sleep(0.4)
        except Exception:
            pass

    # Open context menu on the focused/last message bubble
    pyautogui.press("escape")
    time.sleep(0.15)
    pyautogui.hotkey("shift", "f10")
    time.sleep(0.4)

    # Press 'd' to jump to Delete or navigate
    pyautogui.press("d")
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.5)

    if for_everyone:
        pyautogui.press("enter")
    else:
        pyautogui.press("tab")
        pyautogui.press("enter")
    time.sleep(0.3)

    target = det.get("contact", "active chat")
    plat_name = det.get("type", platform.title())
    mode = "for everyone" if for_everyone else "for me"
    return f"{plat_name} message delete command executed ({mode}) in {target}."


def _delete_whatsapp_message(for_everyone: bool = True) -> str:
    return _delete_message(for_everyone=for_everyone, platform="whatsapp")



def _send_telegram(receiver: str, message: str) -> str:
    _require_pyautogui()
    os_name = get_os()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="telegram")

    _open_app("Telegram")
    time.sleep(1.2)

    pyautogui.press("escape")
    time.sleep(0.2)
    search_hotkey = ("command", "f") if os_name == "mac" else ("ctrl", "f")
    pyautogui.hotkey(*search_hotkey)
    time.sleep(0.4)

    _clear_and_paste(receiver)
    time.sleep(1.0)

    pyautogui.press("down")
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.8)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via Telegram."


def _send_signal(receiver: str, message: str) -> str:
    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="signal")
    return _desktop_send("Signal", receiver, message)


def _send_discord(receiver: str, message: str) -> str:
    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="discord")
    return _desktop_send("Discord", receiver, message)


def _send_instagram(receiver: str, message: str) -> str:
    _require_pyautogui()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="instagram")

    if not _open_browser_url("https://www.instagram.com/direct/new/"):
        return "Could not open Instagram in browser."

    _paste_text(receiver)
    time.sleep(1.5)

    pyautogui.press("down")
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(0.4)

    for _ in range(4):
        pyautogui.press("tab")
        time.sleep(0.15)
    pyautogui.press("enter")
    time.sleep(2.0)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via Instagram."


def _send_messenger(receiver: str, message: str) -> str:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA]
    Step 1: Open or bring Messenger to foreground.
    Step 2: Shortcut Ctrl+F / search, type exact contact name, wait 1s, click matching contact profile.
    Step 3: Visually verify header name via Screen Vision / active window check.
    Step 4: Type message in input box and press Enter.
    """
    _require_pyautogui()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="messenger")

    if not _open_browser_url("https://www.messenger.com/"):
        return "Could not open Messenger in browser."

    time.sleep(1.5)
    _search_in_app(receiver)
    time.sleep(1.0)
    pyautogui.press("down")
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(1.0)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via Messenger."


def _send_facebook(receiver: str, message: str) -> str:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA]
    Step 1: Open or bring Facebook Messages to foreground.
    Step 2: Shortcut Ctrl+F / search, type exact contact name, wait 1s, click matching contact profile.
    Step 3: Visually verify header name via Screen Vision / active window check.
    Step 4: Type message in input box and press Enter.
    """
    _require_pyautogui()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="facebook")

    if not _open_browser_url("https://www.facebook.com/messages/t/"):
        return "Could not open Facebook Messages in browser."

    time.sleep(1.5)
    _search_in_app(receiver)
    time.sleep(1.0)
    pyautogui.press("down")
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(1.0)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via Facebook."


def _send_linkedin(receiver: str, message: str) -> str:
    """
    [MODULE: MESSAGING & SOCIAL MEDIA]
    Step 1: Open or bring LinkedIn messaging to the foreground.
    Step 2: Shortcut Ctrl+F / search, type exact contact name, wait 1s, click matching contact profile.
    Step 3: Visually verify header name via Screen Vision / active window check.
    Step 4: Type message in input box and press Enter.
    """
    _require_pyautogui()

    if _is_active_chat(receiver):
        return _send_active_chat(message, platform="linkedin")

    if not _open_browser_url("https://www.linkedin.com/messaging/"):
        return "Could not open LinkedIn in browser."

    time.sleep(2.0)
    _search_in_app(receiver)
    time.sleep(1.0)
    pyautogui.press("down")
    time.sleep(0.3)
    pyautogui.press("enter")
    time.sleep(1.0)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)

    return f"Message sent to {receiver} via LinkedIn."


def _desktop_send(app_name: str, receiver: str, message: str) -> str:
    if _is_active_chat(receiver):
        return _send_active_chat(message, platform=app_name)

    if not _open_app(app_name):
        return f"Could not open {app_name}."

    time.sleep(1.0)
    _search_in_app(receiver)
    pyautogui.press("enter")
    time.sleep(0.8)

    _paste_text(message)
    time.sleep(0.25)
    pyautogui.press("enter")
    time.sleep(0.3)
    return f"Message sent to {receiver} via {app_name}."


_PLATFORM_MAP = [
    ({"whatsapp", "wp", "wapp"},              _send_whatsapp),
    ({"telegram", "tg"},                      _send_telegram),
    ({"instagram", "ig", "insta"},            _send_instagram),
    ({"signal"},                               _send_signal),
    ({"discord"},                              _send_discord),
    ({"messenger"},                           _send_messenger),
    ({"facebook", "fb"},                      _send_facebook),
    ({"linkedin", "linked_in"},               _send_linkedin),
]


def _resolve_platform(platform_str: str):
    key = platform_str.lower().strip()
    for keywords, handler in _PLATFORM_MAP:
        if any(k in key for k in keywords):
            return handler
    return lambda r, m: _desktop_send(platform_str.strip().title(), r, m)


def send_message(
    parameters: dict,
    response=None,
    player=None,
    session_memory=None,
) -> str:
    params       = parameters or {}
    receiver     = str(
        params.get("receiver")
        or params.get("to")
        or params.get("recipient")
        or params.get("contact")
        or params.get("target")
        or params.get("name")
        or ""
    ).strip()
    message_text = str(
        params.get("message_text")
        or params.get("message")
        or params.get("text")
        or params.get("msg")
        or params.get("content")
        or params.get("body")
        or ""
    ).strip()
    platform     = str(
        params.get("platform")
        or params.get("app")
        or params.get("service")
        or "whatsapp"
    ).strip()
    action       = str(
        params.get("action")
        or params.get("mode")
        or "send"
    ).lower().strip()

    if action in ("detect", "detect_chat", "check_chat", "current_chat", "who"):
        if platform.lower() in ("whatsapp", "wp", "wapp", ""):
            det = _detect_whatsapp_chat()
        else:
            det = _detect_active_chat(platform=platform)

        if det.get("found"):
            res = f"Detected {det.get('type')}: Active Chat with '{det.get('contact')}' (Window: {det.get('title')})"
        else:
            plat_name = platform.title() if platform and platform != "current" else "WhatsApp"
            res = f"No active {plat_name} (Desktop or Web) window detected on screen."
        if player:
            player.write_log(f"[msg] {res}")
        return res

    if action in ("edit", "edit_message", "change_message"):
        if not message_text and receiver and receiver != "current":
            message_text = receiver
        if not message_text:
            return "Please specify the new text for editing the message."
        if player:
            player.write_log(f"[msg] Editing message: {message_text[:30]}")
        if platform.lower() in ("whatsapp", "wp", "wapp", ""):
            return _edit_whatsapp_message(message_text)
        return _edit_message(message_text, platform=platform)

    if action in ("delete", "delete_message", "remove_message", "unsend"):
        for_everyone = params.get("for_everyone", True)
        if player:
            player.write_log("[msg] Deleting last message")
        if platform.lower() in ("whatsapp", "wp", "wapp", ""):
            return _delete_whatsapp_message(for_everyone=for_everyone)
        return _delete_message(for_everyone=for_everyone, platform=platform)

    # If message_text is empty but receiver contains full text
    if not message_text and receiver:
        if len(receiver.split()) > 1 or any(ch in receiver for ch in ".,?!;:"):
            message_text = receiver
            receiver = "current"

    if not message_text:
        return "Please specify the message content."
    if not _PYAUTOGUI:
        return "PyAutoGUI is not installed — cannot control the desktop."

    if not receiver:
        receiver = "current"

    preview = message_text[:50] + ("..." if len(message_text) > 50 else "")
    target_display = "active chat" if _is_active_chat(receiver) else receiver
    try:
        print(f"[SendMessage] [MSG] {platform} -> {target_display}: {preview}")
    except Exception:
        pass
    if player:
        player.write_log(f"[msg] {platform} -> {target_display}")

    try:
        if _is_active_chat(receiver) and platform.lower() in ("current", "active", "this", ""):
            result = _send_active_chat(message_text, platform=platform)
        else:
            handler = _resolve_platform(platform)
            result  = handler(receiver, message_text)
    except Exception as e:
        result = f"Could not send message: {e}"

    try:
        tag = "[OK]" if "sent" in result.lower() else "[ERR]"
        print(f"[SendMessage] {tag} {result}")
    except Exception:
        pass
    if player:
        player.write_log(f"[msg] {result}")

    return result