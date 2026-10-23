import unittest
from unittest.mock import patch, MagicMock

from actions.send_message import send_message, _is_active_chat

class TestSendMessageLogic(unittest.TestCase):
    def test_is_active_chat(self):
        self.assertTrue(_is_active_chat(""))
        self.assertTrue(_is_active_chat("take"))
        self.assertTrue(_is_active_chat("তাকে"))
        self.assertTrue(_is_active_chat("him"))
        self.assertTrue(_is_active_chat("current"))
        self.assertTrue(_is_active_chat("active"))
        self.assertFalse(_is_active_chat("Abir"))
        self.assertFalse(_is_active_chat("+8801700000000"))

    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    @patch("actions.send_message._open_app")
    def test_send_message_active_chat_pronoun(self, mock_open_app, mock_press, mock_paste):
        # User says "take message dao 'ami ashchi'"
        result = send_message({"receiver": "take", "message": "ami ashchi", "platform": "whatsapp"})
        self.assertIn("Message sent", result)
        mock_paste.assert_called_with("ami ashchi")
        mock_press.assert_called_with("enter")

    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    def test_send_message_missing_receiver(self, mock_press, mock_paste):
        # User says "msg pathao 'hello'"
        result = send_message({"message_text": "hello"})
        self.assertIn("Message sent", result)
        mock_paste.assert_called_with("hello")
        mock_press.assert_called_with("enter")

    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    @patch("os.startfile")
    def test_send_message_phone_number(self, mock_startfile, mock_press, mock_paste):
        # User gives a phone number
        result = send_message({"receiver": "+8801712345678", "message": "Hello via phone"})
        self.assertIn("Message sent to +8801712345678 via WhatsApp", result)
        mock_startfile.assert_called()
        self.assertIn("+8801712345678", mock_startfile.call_args[0][0])
        mock_press.assert_called_with("enter")

    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    @patch("pyautogui.hotkey")
    @patch("actions.send_message._open_app")
    def test_send_message_contact_name(self, mock_open_app, mock_hotkey, mock_press, mock_paste):
        # User gives a contact name
        result = send_message({"receiver": "Rahim", "message": "Ki khobor"})
        self.assertIn("Message sent to Rahim via WhatsApp", result)
        mock_open_app.assert_called_with("WhatsApp")
        mock_paste.assert_called_with("Ki khobor")

    def test_send_message_empty_content(self):
        result = send_message({})
        self.assertEqual(result, "Please specify the message content.")

    @patch("actions.send_message._edit_whatsapp_message")
    def test_send_message_edit(self, mock_edit):
        mock_edit.return_value = "WhatsApp message edited to: 'corrected msg'"
        result = send_message({"action": "edit", "message_text": "corrected msg"})
        self.assertIn("edited", result)
        mock_edit.assert_called_with("corrected msg")

    @patch("actions.send_message._delete_whatsapp_message")
    def test_send_message_delete(self, mock_delete):
        mock_delete.return_value = "WhatsApp delete message command executed"
        result = send_message({"action": "delete"})
        self.assertIn("delete", result)
        mock_delete.assert_called_with(for_everyone=True)

    @patch("actions.send_message._detect_whatsapp_chat")
    def test_send_message_detect_chat(self, mock_detect):
        mock_detect.return_value = {
            "found": True,
            "type": "WhatsApp Web",
            "contact": "Rahim",
            "title": "Rahim - WhatsApp - Brave"
        }
        result = send_message({"action": "detect_chat"})
        self.assertIn("Rahim", result)
        self.assertIn("WhatsApp Web", result)

    @patch("actions.send_message._open_browser_url", return_value=True)
    @patch("actions.send_message._search_in_app")
    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    def test_send_messenger(self, mock_press, mock_paste, mock_search, mock_browser):
        result = send_message({
            "platform": "messenger",
            "receiver": "Alex Smith",
            "message": "Hey Alex!"
        })
        self.assertIn("Message sent to Alex Smith via Messenger", result)
        mock_browser.assert_called_with("https://www.messenger.com/")
        mock_search.assert_called_with("Alex Smith")
        mock_paste.assert_called_with("Hey Alex!")
        mock_press.assert_any_call("enter")

    @patch("actions.send_message._open_browser_url", return_value=True)
    @patch("actions.send_message._search_in_app")
    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    def test_send_facebook(self, mock_press, mock_paste, mock_search, mock_browser):
        result = send_message({
            "platform": "facebook",
            "receiver": "Sarah Connor",
            "message": "Checking in"
        })
        self.assertIn("Message sent to Sarah Connor via Facebook", result)
        mock_browser.assert_called_with("https://www.facebook.com/messages/t/")
        mock_search.assert_called_with("Sarah Connor")
        mock_paste.assert_called_with("Checking in")
        mock_press.assert_any_call("enter")

    @patch("actions.send_message._open_browser_url", return_value=True)
    @patch("actions.send_message._search_in_app")
    @patch("actions.send_message._paste_text")
    @patch("pyautogui.press")
    def test_send_linkedin(self, mock_press, mock_paste, mock_search, mock_browser):
        result = send_message({
            "platform": "linkedin",
            "receiver": "John Recruiter",
            "message": "Thanks for the connection!"
        })
        self.assertIn("Message sent to John Recruiter via LinkedIn", result)
        mock_browser.assert_called_with("https://www.linkedin.com/messaging/")
        mock_search.assert_called_with("John Recruiter")
        mock_paste.assert_called_with("Thanks for the connection!")
        mock_press.assert_any_call("enter")

    @patch("actions.send_message._detect_active_chat")
    @patch("actions.send_message._clear_and_paste")
    @patch("pyautogui.press")
    def test_edit_message_generic(self, mock_press, mock_clear_paste, mock_detect):
        mock_detect.return_value = {"found": True, "type": "Messenger", "contact": "Alex", "hwnd": 123}
        result = send_message({
            "action": "edit",
            "message_text": "Updated text",
            "platform": "messenger"
        })
        self.assertIn("edited", result)
        self.assertIn("Updated text", result)
        mock_press.assert_any_call("escape")
        mock_press.assert_any_call("up")
        mock_clear_paste.assert_called_with("Updated text")
        mock_press.assert_any_call("enter")

    @patch("actions.send_message._detect_active_chat")
    @patch("pyautogui.hotkey")
    @patch("pyautogui.press")
    def test_delete_message_generic(self, mock_press, mock_hotkey, mock_detect):
        mock_detect.return_value = {"found": True, "type": "LinkedIn", "contact": "John", "hwnd": 123}
        result = send_message({
            "action": "delete",
            "platform": "linkedin"
        })
        self.assertIn("delete command executed", result)
        mock_press.assert_any_call("escape")
        mock_hotkey.assert_called_with("shift", "f10")
        mock_press.assert_any_call("d")
        mock_press.assert_any_call("enter")


if __name__ == "__main__":
    unittest.main()

