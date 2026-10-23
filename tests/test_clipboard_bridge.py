import unittest
from unittest.mock import MagicMock, patch

from actions.clipboard_bridge import (
    clear_scratchpad,
    clipboard_bridge,
    copy_to_clipboard,
    cross_app_transfer,
    get_scratchpad,
    paste_from_clipboard,
    set_scratchpad,
    verify_target_window_active,
)
from actions.computer_control import computer_control


class TestClipboardBridge(unittest.TestCase):
    def setUp(self):
        clear_scratchpad("test")
        clear_scratchpad("main")

    def tearDown(self):
        clear_scratchpad("test")
        clear_scratchpad("main")

    # -------------------------------------------------------------------------
    # Step 2: Working Scratchpad in Memory
    # -------------------------------------------------------------------------
    def test_scratchpad_set_and_get(self):
        saved = set_scratchpad(
            content="Summary of Quantum Computing paper",
            source_app="Brave",
            target_app="WhatsApp",
            key="test",
        )
        self.assertEqual(saved["content"], "Summary of Quantum Computing paper")
        self.assertEqual(saved["source_app"], "Brave")
        self.assertEqual(saved["target_app"], "WhatsApp")

        retrieved = get_scratchpad("test")
        self.assertEqual(retrieved["content"], "Summary of Quantum Computing paper")
        self.assertEqual(retrieved["source_app"], "Brave")
        self.assertEqual(retrieved["target_app"], "WhatsApp")

    def test_scratchpad_clear(self):
        set_scratchpad(content="Temporary buffer", key="test")
        self.assertTrue(bool(get_scratchpad("test")))
        clear_scratchpad("test")
        self.assertFalse(bool(get_scratchpad("test")))

    # -------------------------------------------------------------------------
    # Step 3: Target Window Verification
    # -------------------------------------------------------------------------
    @patch("actions.clipboard_bridge.get_foreground_window_title", return_value="WhatsApp - Google Chrome")
    def test_verify_target_window_active_match(self, mock_title):
        is_active, title = verify_target_window_active("whatsapp")
        self.assertTrue(is_active)
        self.assertIn("WhatsApp", title)

    @patch("actions.clipboard_bridge.get_foreground_window_title", return_value="app.py - Visual Studio Code")
    def test_verify_target_window_vscode_match(self, mock_title):
        is_active, title = verify_target_window_active("vscode")
        self.assertTrue(is_active)
        self.assertIn("Visual Studio Code", title)

    @patch("actions.clipboard_bridge.get_foreground_window_title", return_value="Calculator")
    def test_verify_target_window_mismatch(self, mock_title):
        is_active, title = verify_target_window_active("whatsapp")
        self.assertFalse(is_active)
        self.assertEqual(title, "Calculator")

    # -------------------------------------------------------------------------
    # Step 1 & 3: Paste and Cross-App Transfer Pipeline
    # -------------------------------------------------------------------------
    @patch("actions.clipboard_bridge.verify_target_window_active", return_value=(True, "WhatsApp"))
    @patch("actions.clipboard_bridge.pyautogui.press")
    @patch("actions.clipboard_bridge.pyautogui.hotkey")
    @patch("actions.clipboard_bridge.pyperclip.copy")
    def test_cross_app_transfer_success(self, mock_copy, mock_hotkey, mock_press, mock_verify):
        res = cross_app_transfer(
            text="Here is the summarized research note.",
            target_app="whatsapp",
            source_app="brave",
            press_enter=True,
        )
        self.assertIn("[ClipboardBridge] Transferred", res)
        self.assertIn("whatsapp", res.lower())
        self.assertIn("Source: brave", res)
        mock_copy.assert_called_once_with("Here is the summarized research note.")
        mock_hotkey.assert_called_with("ctrl", "v")
        mock_press.assert_called_with("enter")

        # Verify scratchpad was preserved
        pad = get_scratchpad("main")
        self.assertEqual(pad["content"], "Here is the summarized research note.")
        self.assertEqual(pad["source_app"], "brave")
        self.assertEqual(pad["target_app"], "whatsapp")

    @patch("actions.clipboard_bridge.focus_app_window", return_value=False)
    @patch("actions.clipboard_bridge.verify_target_window_active", return_value=(False, "Calculator"))
    @patch("actions.clipboard_bridge.pyautogui.hotkey")
    @patch("actions.clipboard_bridge.pyperclip.copy")
    def test_cross_app_transfer_blocked_on_mismatch(self, mock_copy, mock_hotkey, mock_verify, mock_focus):
        res = cross_app_transfer(
            text="Sensitive data destined for WhatsApp",
            target_app="whatsapp",
            source_app="brave",
            verify_window=True,
        )
        self.assertIn("[BLOCKED]", res)
        self.assertIn("NOT active in foreground", res)
        # Hotkey paste must NOT have been called to prevent data spill
        mock_hotkey.assert_not_called()

        # Context must still be preserved safely in scratchpad
        pad = get_scratchpad("main")
        self.assertEqual(pad["content"], "Sensitive data destined for WhatsApp")

    # -------------------------------------------------------------------------
    # Integration with computer_control
    # -------------------------------------------------------------------------
    @patch("actions.clipboard_bridge.verify_target_window_active", return_value=(True, "Visual Studio Code"))
    @patch("actions.clipboard_bridge.pyautogui.hotkey")
    @patch("actions.clipboard_bridge.pyperclip.copy")
    def test_computer_control_cross_app_transfer(self, mock_copy, mock_hotkey, mock_verify):
        res = computer_control({
            "action": "cross_app_transfer",
            "text": "Fixed error: ZeroDivisionError resolved",
            "target_app": "vscode",
            "source_app": "terminal",
        })
        self.assertIn("[ClipboardBridge] Transferred", res)
        mock_copy.assert_called_once_with("Fixed error: ZeroDivisionError resolved")
        mock_hotkey.assert_called_with("ctrl", "v")

    def test_clipboard_bridge_dispatch_scratchpad(self):
        set_res = clipboard_bridge({
            "action": "set_scratchpad",
            "text": "test buffer content",
            "key": "test",
        })
        self.assertIn("Stored 19 chars in Scratchpad", set_res)

        get_res = clipboard_bridge({
            "action": "get_scratchpad",
            "key": "test",
        })
        self.assertIn("Scratchpad [test]: 19 chars", get_res)


if __name__ == "__main__":
    unittest.main()
