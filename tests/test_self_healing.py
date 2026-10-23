# tests/test_self_healing.py
"""
Unit tests for actions/self_healing.py:
- Strict MAX_RETRY = 3 limit and Loop Breaker
- Screen Vision visual change detection
- Multi-tier fallback cascade:
    * Attempt A: Esc dismiss overlay + scroll
    * Attempt B: Keyboard navigation (Tab, Enter, Space)
    * Attempt C: Background CLI/script fallback
- Application freeze detection ('Not Responding') and clean restart via taskkill
- Integration with computer_control and unified tool entrypoint
"""

import unittest
from unittest.mock import MagicMock, patch
from PIL import Image, ImageDraw

from actions.self_healing import (
    MAX_RETRY,
    record_attempt,
    get_attempt_count,
    get_no_change_count,
    is_loop_breaker_triggered,
    reset_attempts,
    detect_visual_change,
    execute_self_healing_click,
    execute_self_healing_command,
    check_frozen_applications,
    terminate_frozen_app,
    restart_frozen_app,
    offer_frozen_app_restart,
    self_healing,
)
from actions.computer_control import computer_control


class TestSelfHealingLoopBreaker(unittest.TestCase):

    def setUp(self):
        reset_attempts()

    def tearDown(self):
        reset_attempts()

    def test_max_retry_tracking_and_loop_breaker(self):
        """Step 1: Strict MAX_RETRY = 3 limit halts repeated actions."""
        key = "click:100,200:test_button"
        self.assertEqual(get_attempt_count(key), 0)
        self.assertFalse(is_loop_breaker_triggered(key))

        # Attempt 1
        record_attempt(key, produced_change=False)
        self.assertEqual(get_attempt_count(key), 1)
        self.assertEqual(get_no_change_count(key), 1)
        self.assertFalse(is_loop_breaker_triggered(key))

        # Attempt 2
        record_attempt(key, produced_change=False)
        self.assertEqual(get_attempt_count(key), 2)
        self.assertEqual(get_no_change_count(key), 2)
        self.assertFalse(is_loop_breaker_triggered(key))

        # Attempt 3: Hits MAX_RETRY limit
        record_attempt(key, produced_change=False)
        self.assertEqual(get_attempt_count(key), 3)
        self.assertTrue(is_loop_breaker_triggered(key))

        # Reset
        reset_attempts(key)
        self.assertEqual(get_attempt_count(key), 0)
        self.assertFalse(is_loop_breaker_triggered(key))

    def test_detect_visual_change(self):
        """Step 2: Detect whether screen visual change occurred between two frames."""
        img1 = Image.new("RGB", (200, 200), color=(255, 255, 255))
        img2 = Image.new("RGB", (200, 200), color=(255, 255, 255))

        # Identical images -> No visual change
        self.assertFalse(detect_visual_change(img1, img2, threshold=0.005))

        # Modified image -> Visual change detected
        draw = ImageDraw.Draw(img2)
        draw.rectangle([50, 50, 150, 150], fill=(0, 0, 0))
        self.assertTrue(detect_visual_change(img1, img2, threshold=0.005))

    @patch("actions.self_healing.capture_screen_image")
    @patch("actions.self_healing.pyautogui.click")
    def test_click_succeeds_on_visual_change(self, mock_click, mock_capture):
        """Click succeeds immediately when visual change is detected on first attempt."""
        img1 = Image.new("RGB", (100, 100), color=(255, 255, 255))
        img2 = Image.new("RGB", (100, 100), color=(0, 0, 0))
        mock_capture.side_effect = [img1, img2]

        res = execute_self_healing_click(x=100, y=200, description="Save button")
        self.assertTrue(res["success"])
        self.assertFalse(res["loop_breaker_triggered"])
        self.assertTrue(res["visual_change"])
        self.assertIn("visual change confirmed", res["message"])

    @patch("actions.self_healing.capture_screen_image")
    @patch("actions.self_healing.pyautogui.click")
    @patch("actions.self_healing.pyautogui.scroll")
    @patch("actions.self_healing.pyautogui.press")
    def test_attempt_a_scroll_and_dismiss_modal(self, mock_press, mock_scroll, mock_click, mock_capture):
        """Attempt A: If 2 attempts have no visual change, scroll and press Escape to dismiss invisible overlays."""
        key = "click:100,200:submit_button"
        # Seed 1 prior failed attempt
        record_attempt(key, produced_change=False)

        # On the 2nd attempt, regular click has no change, but Attempt A resolves it
        img_same1 = Image.new("RGB", (50, 50), color=(255, 255, 255))
        img_same2 = Image.new("RGB", (50, 50), color=(255, 255, 255))
        img_changed = Image.new("RGB", (50, 50), color=(0, 128, 255))

        mock_capture.side_effect = [img_same1, img_same2, img_changed]

        res = execute_self_healing_click(x=100, y=200, description="submit_button")
        self.assertTrue(res["success"])
        self.assertEqual(res.get("fallback_stage"), "Attempt A (Scroll/Dismiss Modal)")
        mock_press.assert_any_call("escape")
        mock_scroll.assert_called()

    @patch("actions.self_healing.capture_screen_image")
    @patch("actions.self_healing.pyautogui.click")
    @patch("actions.self_healing.pyautogui.scroll")
    @patch("actions.self_healing.pyautogui.press")
    def test_attempt_b_keyboard_navigation(self, mock_press, mock_scroll, mock_click, mock_capture):
        """Attempt B: If Attempt A fails, switch to keyboard navigation (Tab -> Enter)."""
        key = "click:150,250:next_step"
        record_attempt(key, produced_change=False)

        img_same = Image.new("RGB", (50, 50), color=(255, 255, 255))
        img_changed = Image.new("RGB", (50, 50), color=(255, 0, 0))

        # Initial click: same; Attempt A: same; Attempt B: changed!
        mock_capture.side_effect = [img_same, img_same, img_same, img_changed]

        res = execute_self_healing_click(x=150, y=250, description="next_step", keyboard_key="enter")
        self.assertTrue(res["success"])
        self.assertEqual(res.get("fallback_stage"), "Attempt B (Keyboard Navigation)")
        mock_press.assert_any_call("tab")
        mock_press.assert_any_call("enter")

    @patch("actions.self_healing.subprocess.run")
    @patch("actions.self_healing.capture_screen_image")
    @patch("actions.self_healing.pyautogui.click")
    @patch("actions.self_healing.pyautogui.scroll")
    @patch("actions.self_healing.pyautogui.press")
    def test_attempt_c_cli_fallback(self, mock_press, mock_scroll, mock_click, mock_capture, mock_run):
        """Attempt C: If Attempts A & B fail, execute action via background Python/CLI script."""
        key = "click:300,400:deploy"
        record_attempt(key, produced_change=False)

        img_same = Image.new("RGB", (50, 50), color=(255, 255, 255))
        mock_capture.return_value = img_same

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "Background script completed successfully."
        mock_proc.stderr = ""
        mock_run.return_value = mock_proc

        res = execute_self_healing_click(
            x=300,
            y=400,
            description="deploy",
            cli_fallback_cmd="python -m actions.dev_agent deploy",
        )
        self.assertTrue(res["success"])
        self.assertEqual(res.get("fallback_stage"), "Attempt C (CLI/Script)")
        mock_run.assert_called_once()

    @patch("actions.self_healing.capture_screen_image")
    @patch("actions.self_healing.pyautogui.click")
    @patch("actions.self_healing.pyautogui.scroll")
    @patch("actions.self_healing.pyautogui.press")
    def test_loop_breaker_aborts_at_max_retry(self, mock_press, mock_scroll, mock_click, mock_capture):
        """Loop breaker halts execution after MAX_RETRY attempts without visual change."""
        key = "click:500,500:broken_button"
        # Seed 2 previous failed attempts
        record_attempt(key, produced_change=False)
        record_attempt(key, produced_change=False)

        img_same = Image.new("RGB", (50, 50), color=(255, 255, 255))
        mock_capture.return_value = img_same

        # 3rd attempt will hit MAX_RETRY = 3
        res = execute_self_healing_click(x=500, y=500, description="broken_button")
        self.assertFalse(res["success"])
        self.assertTrue(res["loop_breaker_triggered"])
        self.assertEqual(res["attempts"], 3)
        self.assertIn("LOOP BREAKER", res["message"])

        # Any subsequent invocation is immediately aborted before clicking
        subsequent = execute_self_healing_click(x=500, y=500, description="broken_button")
        self.assertTrue(subsequent["loop_breaker_triggered"])
        self.assertEqual(subsequent.get("fallback_stage"), "aborted")

    @patch("actions.self_healing.subprocess.run")
    def test_execute_self_healing_command_loop_breaker(self, mock_run):
        """Terminal commands enforce MAX_RETRY = 3 loop breaker."""
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = ""
        mock_proc.stderr = "Permission denied"
        mock_run.return_value = mock_proc

        cmd = "npm run invalid-script"
        r1 = execute_self_healing_command(cmd)
        self.assertFalse(r1["loop_breaker_triggered"])
        self.assertEqual(r1["attempts"], 1)

        r2 = execute_self_healing_command(cmd)
        self.assertFalse(r2["loop_breaker_triggered"])
        self.assertEqual(r2["attempts"], 2)

        r3 = execute_self_healing_command(cmd)
        self.assertTrue(r3["loop_breaker_triggered"])
        self.assertEqual(r3["attempts"], 3)

        # 4th call is immediately blocked by loop breaker
        r4 = execute_self_healing_command(cmd)
        self.assertTrue(r4["loop_breaker_triggered"])
        self.assertIn("exceeded MAX_RETRY", r4["message"])

    @patch("actions.self_healing.subprocess.check_output")
    def test_check_frozen_applications_windows_tasklist(self, mock_output):
        """Step 3: Detects applications in 'Not Responding' state via tasklist."""
        mock_output.return_value = (
            '"brave.exe","14220","Console","1","154,230 K","Not Responding"\n'
            '"notepad.exe","9920","Console","1","24,100 K","Not Responding"\n'
        )

        with patch("actions.self_healing._get_os", return_value="windows"):
            frozen = check_frozen_applications()
            self.assertEqual(len(frozen), 2)
            self.assertEqual(frozen[0]["name"], "brave.exe")
            self.assertEqual(frozen[0]["pid"], 14220)
            self.assertEqual(frozen[1]["name"], "notepad.exe")

            # Filter by specific app
            brave_only = check_frozen_applications(target_app="brave")
            self.assertEqual(len(brave_only), 1)
            self.assertEqual(brave_only[0]["pid"], 14220)

    @patch("actions.self_healing.subprocess.run")
    def test_terminate_frozen_app_taskkill(self, mock_run):
        """Step 3: Cleanly terminates frozen app via taskkill /F."""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "SUCCESS: The process with PID 14220 has been terminated."
        mock_proc.stderr = ""
        mock_run.return_value = mock_proc

        with patch("actions.self_healing._get_os", return_value="windows"):
            res = terminate_frozen_app(14220, force=True)
            self.assertTrue(res["success"])
            self.assertIn("taskkill /F /PID 14220", res["command"])

    @patch("actions.open_app.open_app")
    @patch("actions.self_healing.terminate_frozen_app")
    def test_restart_frozen_app(self, mock_term, mock_open):
        """Step 3: Kills frozen app and cleanly relaunches it."""
        mock_term.return_value = {"success": True, "command": "taskkill /F /IM notepad.exe /T"}
        mock_open.return_value = "Opened notepad successfully."

        res = restart_frozen_app("notepad.exe", app_name="notepad")
        self.assertTrue(res["success"])
        self.assertEqual(res["target"], "notepad.exe")
        mock_term.assert_called_once_with("notepad.exe", force=True)
        mock_open.assert_called_once_with({"app_name": "notepad"})

    @patch("actions.self_healing.check_frozen_applications")
    def test_offer_frozen_app_restart(self, mock_check):
        """Step 3: Automatically offers clean restart via taskkill when app freezes."""
        mock_check.return_value = [{"name": "excel.exe", "pid": 5512, "status": "Not Responding"}]

        prompt = offer_frozen_app_restart("excel")
        self.assertIn("Not Responding", prompt)
        self.assertIn("taskkill", prompt)
        self.assertIn("excel.exe (PID: 5512)", prompt)

    @patch("actions.self_healing.check_frozen_applications")
    def test_self_healing_unified_entrypoint(self, mock_check):
        """Unified self_healing tool entrypoint dispatches actions cleanly."""
        mock_check.return_value = []
        res = self_healing({"action": "check_frozen"})
        self.assertIn("No frozen", res)

        status_res = self_healing({"action": "status"})
        self.assertIn("Active attempt trackers", status_res)

        reset_res = self_healing({"action": "reset"})
        self.assertIn("Reset attempt trackers", reset_res)

    @patch("actions.self_healing.restart_frozen_app")
    def test_computer_control_integration(self, mock_restart):
        """Integration with computer_control for self-healing actions."""
        mock_restart.return_value = {"message": "Restarted process cleanly."}

        res = computer_control({
            "action": "restart_frozen",
            "target": "chrome.exe",
            "app_name": "chrome",
        })
        self.assertIn("Restarted process cleanly", res)


if __name__ == "__main__":
    unittest.main()
