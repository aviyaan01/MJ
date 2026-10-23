# tests/test_browser_manager.py
import unittest
from unittest.mock import patch, MagicMock

from actions.browser_manager import (
    browser_manager,
    navigate,
    search,
    youtube_search,
    gmail_compose,
    scroll_down,
    scroll_up,
    reload_page,
    go_back,
    go_forward,
    fullscreen,
    switch_to_tab,
    close_active_tab,
    close_multiple_tabs,
    new_tab,
    reopen_closed_tab,
    next_tab,
    prev_tab,
    _normalize_url,
)
from actions.open_app import open_app, _normalize, get_known_exes, KNOWN_EXES


class TestBrowserManager(unittest.TestCase):

    def test_normalize_url(self):
        self.assertEqual(_normalize_url("youtube.com"), "https://youtube.com")
        self.assertEqual(_normalize_url("https://github.com"), "https://github.com")
        self.assertEqual(_normalize_url("google"), "https://www.google.com")
        self.assertEqual(_normalize_url(""), "https://www.google.com")

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.hotkey")
    @patch("pyautogui.press")
    @patch("pyperclip.copy")
    def test_navigate(self, mock_copy, mock_press, mock_hotkey, mock_focus):
        res = navigate("youtube.com", browser="brave")
        self.assertIn("Navigated brave to https://youtube.com", res)
        mock_focus.assert_called_with("brave")
        mock_press.assert_called_with("enter")

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.hotkey")
    @patch("pyautogui.press")
    @patch("pyperclip.copy")
    def test_search(self, mock_copy, mock_press, mock_hotkey, mock_focus):
        res = search("python tutorials", browser="brave")
        self.assertIn("Searched 'python tutorials' in brave", res)
        mock_focus.assert_called_with("brave")
        mock_copy.assert_called_with("python tutorials")

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.press")
    def test_scroll_down_and_up(self, mock_press, mock_focus):
        res_down = scroll_down(amount=2, browser="brave")
        self.assertIn("Scrolled down in brave", res_down)
        self.assertEqual(mock_press.call_count, 2)
        mock_press.assert_called_with("pagedown")

        mock_press.reset_mock()
        res_up = scroll_up(amount=3, browser="brave")
        self.assertIn("Scrolled up in brave", res_up)
        self.assertEqual(mock_press.call_count, 3)
        mock_press.assert_called_with("pageup")

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.hotkey")
    def test_reload_and_tabs(self, mock_hotkey, mock_focus):
        res_reload = reload_page("brave")
        self.assertIn("Reloaded active page in brave", res_reload)

        res_switch = switch_to_tab(3, "brave")
        self.assertIn("Switched to tab 3 in brave", res_switch)

        res_close = close_active_tab("brave")
        self.assertIn("Closed active tab in brave", res_close)

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.hotkey")
    def test_close_multiple_tabs(self, mock_hotkey, mock_focus):
        res = close_multiple_tabs(count=3, start_tab=1, browser="brave")
        self.assertIn("Closed 3 tab(s) in brave", res)

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("pyautogui.hotkey")
    def test_tab_navigation(self, mock_hotkey, mock_focus):
        res_next = next_tab("brave")
        self.assertIn("Navigated to next tab in brave", res_next)

        res_prev = prev_tab("brave")
        self.assertIn("Navigated to previous tab in brave", res_prev)

        res_reopen = reopen_closed_tab("brave")
        self.assertIn("Reopened last closed tab in brave", res_reopen)

    @patch("actions.browser_manager.navigate")
    def test_browser_manager_natural_language_bengali(self, mock_nav):
        mock_nav.return_value = "Navigated brave to https://youtube.com."

        res = browser_manager({"command": "Brave e youtube open koro", "browser": "brave"})
        self.assertIn("youtube", res.lower())

    @patch("actions.browser_manager.scroll_down")
    def test_browser_manager_scroll_bengali(self, mock_scroll):
        mock_scroll.return_value = "Scrolled down in brave."
        res = browser_manager({"command": "Brave e niche scroll koro", "browser": "brave"})
        self.assertIn("Scrolled down", res)

    @patch("actions.browser_manager.scroll_up")
    def test_browser_manager_scroll_up_bengali(self, mock_scroll_up):
        mock_scroll_up.return_value = "Scrolled up in brave."
        res = browser_manager({"command": "Brave e upore scroll koro", "browser": "brave"})
        self.assertIn("Scrolled up", res)

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("actions.browser_manager.navigate")
    @patch("pyautogui.press")
    def test_youtube_search(self, mock_press, mock_nav, mock_focus):
        mock_nav.return_value = "Navigated"
        res = youtube_search(query="lofi beats", browser="brave", play_first=True)
        self.assertIn("Searched YouTube for 'lofi beats'", res)
        self.assertIn("opened the first valid video", res)
        mock_focus.assert_called_with("brave")
        mock_nav.assert_called_once()
        self.assertIn("search_query=lofi+beats", mock_nav.call_args[0][0])
        self.assertIn("sp=EgIQAQ%3D%3D", mock_nav.call_args[0][0])
        mock_press.assert_any_call("tab")
        mock_press.assert_any_call("enter")

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("actions.browser_manager.navigate")
    def test_gmail_compose_draft_stage(self, mock_nav, mock_focus):
        mock_nav.return_value = "Navigated"
        res = gmail_compose(
            to="test@example.com",
            subject="Project Update",
            body="Hello boss, the build passed.",
            browser="brave",
            send_now=False,
        )
        self.assertIn("[DRAFT PREPARED]", res)
        self.assertIn("Stopping at draft stage for user review", res)
        self.assertIn("test@example.com", res)
        self.assertIn("Project Update", res)
        mock_focus.assert_called_with("brave")
        nav_url = mock_nav.call_args[0][0]
        self.assertIn("to=test%40example.com", nav_url)
        self.assertIn("su=Project+Update", nav_url)
        self.assertIn("body=Hello+boss%2C+the+build+passed.", nav_url)

    @patch("actions.browser_manager._focus_browser", return_value=True)
    @patch("actions.browser_manager.navigate")
    @patch("pyautogui.hotkey")
    def test_gmail_compose_send_now(self, mock_hotkey, mock_nav, mock_focus):
        mock_nav.return_value = "Navigated"
        res = gmail_compose(
            to="test@example.com",
            subject="Urgent",
            body="Go",
            browser="brave",
            send_now=True,
        )
        self.assertIn("Sent email to 'test@example.com'", res)
        mock_hotkey.assert_called_with("ctrl", "enter")

    @patch("actions.browser_manager.youtube_search")
    def test_browser_manager_youtube_dispatch(self, mock_yt):
        mock_yt.return_value = "Searched YouTube for 'rabindra sangeet' and opened the first valid video in brave."
        res = browser_manager({"action": "youtube_search", "query": "rabindra sangeet", "browser": "brave"})
        self.assertIn("rabindra sangeet", res)
        mock_yt.assert_called_with(query="rabindra sangeet", browser="brave")

    @patch("actions.browser_manager.gmail_compose")
    def test_browser_manager_gmail_dispatch(self, mock_gmail):
        mock_gmail.return_value = "[DRAFT PREPARED] Email draft created in brave at draft stage"
        res = browser_manager({
            "action": "gmail_compose",
            "to": "boss@google.com",
            "subject": "Review",
            "body": "Ready",
            "browser": "brave"
        })
        self.assertIn("[DRAFT PREPARED]", res)
        mock_gmail.assert_called_with(to="boss@google.com", subject="Review", body="Ready", browser="brave", send_now=False)

    @patch("actions.browser_manager.youtube_search")
    def test_browser_manager_youtube_natural_language(self, mock_yt):
        mock_yt.return_value = "Searched YouTube"
        res = browser_manager({"command": "Brave e youtube e guitar lesson play koro", "browser": "brave"})
        self.assertEqual(res, "Searched YouTube")
        mock_yt.assert_called_once()

    @patch("actions.browser_manager.gmail_compose")
    def test_browser_manager_gmail_natural_language(self, mock_gmail):
        mock_gmail.return_value = "[DRAFT PREPARED]"
        res = browser_manager({
            "command": "gmail e draft koro",
            "to": "john@doe.com",
            "subject": "Hi",
            "body": "Hello",
            "browser": "brave"
        })
        self.assertEqual(res, "[DRAFT PREPARED]")
        mock_gmail.assert_called_with(to="john@doe.com", subject="Hi", body="Hello", browser="brave", send_now=False)


class TestVsCodeVsCursorResolution(unittest.TestCase):

    def test_vscode_and_cursor_separate_aliases(self):
        # Verify that 'vscode' and 'code' normalize to 'vscode'
        self.assertEqual(_normalize("vscode"), "vscode")
        self.assertEqual(_normalize("vs code"), "vscode")
        self.assertEqual(_normalize("code"), "vscode")

        # Verify that 'cursor' normalizes to 'cursor'
        self.assertEqual(_normalize("cursor"), "cursor")

    def test_known_exes_path_isolation(self):
        # Real VS Code MUST NOT point to Cursor
        vscode_candidates = get_known_exes("vscode")
        for path in vscode_candidates:
            self.assertNotIn("cursor", str(path).lower(), f"VS Code candidate contains cursor: {path}")

        # Real Cursor MUST NOT point to VS Code
        cursor_candidates = get_known_exes("cursor")
        for path in cursor_candidates:
            self.assertIn("cursor", str(path).lower(), f"Cursor candidate does not contain cursor: {path}")

    @patch("actions.open_app._launch_windows", return_value=True)
    def test_open_app_signatures(self, mock_launcher):
        # Test open_app with string parameter
        res_str = open_app("vscode")
        self.assertIn("Opened vscode", res_str)

        # Test open_app with dict parameter
        res_dict = open_app({"app_name": "brave"})
        self.assertIn("Opened brave", res_dict)


if __name__ == "__main__":
    unittest.main()
