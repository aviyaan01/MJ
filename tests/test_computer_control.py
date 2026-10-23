import unittest
from unittest.mock import patch, MagicMock
from actions.computer_control import computer_control

class TestComputerControlVisionGrounding(unittest.TestCase):

    @patch("actions.computer_control._click")
    def test_smart_click_with_coords(self, mock_click):
        mock_click.return_value = "Clicked (500, 300)"
        res = computer_control({"action": "smart_click", "x": 500, "y": 300})
        self.assertIn("Clicked", res)
        mock_click.assert_called_with(500, 300, "left", 1)

    @patch("actions.computer_control._screen_find")
    @patch("actions.computer_control._click")
    def test_smart_click_with_description(self, mock_click, mock_find):
        mock_find.return_value = (640, 480)
        mock_click.return_value = "Clicked (640, 480)"
        res = computer_control({"action": "smart_click", "description": "Login button"})
        self.assertIn("Smart-clicked", res)
        mock_find.assert_called_with("Login button")
        mock_click.assert_called_with(640, 480, "left", 1)

    @patch("actions.computer_control._click")
    @patch("actions.computer_control._smart_type")
    def test_smart_type_with_coords(self, mock_smart_type, mock_click):
        mock_click.return_value = "Clicked (200, 150)"
        mock_smart_type.return_value = "Smart-typed: admin"
        res = computer_control({
            "action": "smart_type",
            "x": 200,
            "y": 150,
            "text": "admin",
            "clear_first": True
        })
        self.assertIn("Smart-typed", res)
        mock_click.assert_called_with(200, 150, "left", 1)
        mock_smart_type.assert_called_with("admin", clear_first=True)

    @patch("actions.computer_control._press")
    def test_dismiss_popup(self, mock_press):
        res = computer_control({"action": "dismiss_popup"})
        self.assertIn("dismissal", res)
        mock_press.assert_called_with("escape")

if __name__ == "__main__":
    unittest.main()
