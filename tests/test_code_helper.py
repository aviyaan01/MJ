# tests/test_code_helper.py
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from actions.code_helper import (
    _clean_code,
    _detect_intent,
    _edit_action,
    _explain_action,
    _fix_error_on_screen,
    _has_error,
    _optimize_action,
    _read_file,
    _resolve_save_path,
    _save_file,
    _write_action,
    code_helper,
)


class TestCodeHelper(unittest.TestCase):

    def test_clean_code(self):
        raw = "```python\nprint('hello')\n```"
        self.assertEqual(_clean_code(raw), "print('hello')")
        raw_bare = "print('hello')"
        self.assertEqual(_clean_code(raw_bare), "print('hello')")
        self.assertEqual(_clean_code(None), "")

    def test_resolve_save_path(self):
        p_py = _resolve_save_path("desktop", "python")
        self.assertTrue(str(p_py).endswith(".py"))

        p_js = _resolve_save_path("test_script", "javascript")
        self.assertTrue(str(p_js).endswith(".js"))

    def test_read_and_save_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            file_p = Path(tmpdir) / "sample.py"
            save_msg = _save_file(file_p, "x = 42\n")
            self.assertIn("Saved to", save_msg)

            content, err = _read_file(str(file_p))
            self.assertEqual(err, "")
            self.assertEqual(content, "x = 42\n")

    def test_has_error(self):
        self.assertTrue(_has_error("Traceback (most recent call last):"))
        self.assertTrue(_has_error("ModuleNotFoundError: No module named 'sounddevice'"))
        self.assertFalse(_has_error("Build complete. Everything passed."))

    def test_detect_intent_keywords(self):
        intent = _detect_intent("Fix this error on screen right now", "", "")
        self.assertEqual(intent, "fix_error_on_screen")

        intent_bengali = _detect_intent("screen er error ta fix koro", "", "")
        self.assertEqual(intent_bengali, "fix_error_on_screen")

    @patch("actions.code_helper._open_in_vscode")
    @patch("actions.code_helper._get_gemini")
    def test_write_action(self, mock_gemini, mock_open_vscode):
        mock_model = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "```python\ndef greet():\n    return 'hi'\n```"
        mock_model.generate_content.return_value = mock_resp
        mock_gemini.return_value = mock_model

        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = str(Path(tmpdir) / "greet.py")
            res = _write_action("write a greeting function", "python", out_file, player=None)
            self.assertIn("Code written", res)
            self.assertTrue(Path(out_file).exists())
            self.assertIn("def greet():", Path(out_file).read_text(encoding="utf-8"))
            mock_open_vscode.assert_called_once()

    @patch("actions.code_helper._open_in_vscode")
    @patch("actions.code_helper._get_gemini")
    def test_edit_action(self, mock_gemini, mock_open_vscode):
        mock_model = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "x = 100\n"
        mock_model.generate_content.return_value = mock_resp
        mock_gemini.return_value = mock_model

        with tempfile.TemporaryDirectory() as tmpdir:
            target_f = Path(tmpdir) / "config.py"
            target_f.write_text("x = 10\n", encoding="utf-8")

            res = _edit_action(str(target_f), "change x to 100", player=None)
            self.assertIn("File edited", res)
            self.assertEqual(target_f.read_text(encoding="utf-8").strip(), "x = 100")

    @patch("actions.code_helper._get_gemini")
    def test_explain_action(self, mock_gemini):
        mock_model = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "This code prints numbers from 1 to 10."
        mock_model.generate_content.return_value = mock_resp
        mock_gemini.return_value = mock_model

        res = _explain_action("", "for i in range(1, 11): print(i)", player=None)
        self.assertIn("This code prints numbers", res)

    @patch("actions.code_helper._open_in_vscode")
    @patch("actions.code_helper._get_gemini")
    def test_optimize_action(self, mock_gemini, mock_open_vscode):
        mock_model = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "def total(nums):\n    return sum(nums)\n"
        mock_model.generate_content.return_value = mock_resp
        mock_gemini.return_value = mock_model

        with tempfile.TemporaryDirectory() as tmpdir:
            f = Path(tmpdir) / "calc.py"
            f.write_text("def total(nums):\n    t = 0\n    for n in nums:\n        t += n\n    return t\n", encoding="utf-8")

            res = _optimize_action(str(f), f.read_text(), "python", "", player=None)
            self.assertIn("Code optimized", res)
            self.assertIn("return sum(nums)", f.read_text(encoding="utf-8"))

    @patch("actions.code_helper._run_file")
    @patch("actions.vscode_control.vscode_control")
    @patch("google.genai.Client")
    @patch("actions.code_helper._take_screenshot")
    def test_fix_error_on_screen_full_loop(
        self,
        mock_screenshot,
        mock_genai_client,
        mock_vscode_control,
        mock_run_file
    ):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a buggy file with imports and logic
            target_f = Path(tmpdir) / "app.py"
            target_f.write_text(
                "import os\n"
                "import sys\n\n"
                "def calculate():\n"
                "    result = 10 / 0\n"
                "    return result\n",
                encoding="utf-8"
            )

            # Dummy screenshot path
            shot_file = Path(tmpdir) / "debug.png"
            shot_file.write_bytes(b"\x89PNG\r\n\x1a\nfakeimage")
            mock_screenshot.return_value = shot_file

            # Mock Gemini responses:
            # 1st call: Traceback / error diagnosis JSON
            # 2nd call: Clean fixed code
            diag_json = json.dumps({
                "error_message": "ZeroDivisionError: division by zero in calculate() line 5",
                "file_path": str(target_f),
                "line_number": 5,
                "root_cause": "Division by zero in calculate function",
                "command": "python app.py",
                "fix_suggestion": "Safely handle zero divisor"
            })
            clean_fixed_code = (
                "import os\n"
                "import sys\n\n"
                "def calculate(divisor=2):\n"
                "    result = 10 / (divisor or 1)\n"
                "    return result\n"
            )

            mock_client_instance = MagicMock()
            mock_resp_diag = MagicMock()
            mock_resp_diag.text = diag_json
            mock_resp_fix = MagicMock()
            mock_resp_fix.text = f"```python\n{clean_fixed_code}```"

            mock_client_instance.models.generate_content.side_effect = [
                mock_resp_diag,
                mock_resp_fix,
            ]
            mock_genai_client.return_value = mock_client_instance

            # Mock vscode_control responses
            mock_vscode_control.side_effect = [
                {"success": True, "result": {"message": "Jumped to line 5"}},
                "Ran command in terminal",
            ]

            # Mock run_file output after fix (no error)
            mock_run_file.return_value = "Result: 5.0"

            mock_player = MagicMock()
            report = _fix_error_on_screen(
                description="Fix this error on screen",
                file_path=str(target_f),
                command="python app.py",
                player=mock_player
            )

            # Verify Step 1-5 outputs:
            self.assertIn("[CODING & VSCODE AUTOMATION REPORT]", report)
            self.assertIn("Division by zero", report)
            self.assertIn("VERDICT: PASS", report)

            # Check that vscode_control goto_line was called for line 5 (Step 3)
            mock_vscode_control.assert_any_call(
                {"action": "goto_line", "file_path": str(target_f), "line": 5, "column": 1},
                player=mock_player
            )

            # Check that code was cleanly fixed and preserved imports (Step 4)
            updated_content = target_f.read_text(encoding="utf-8")
            self.assertIn("import os", updated_content)
            self.assertIn("import sys", updated_content)
            self.assertIn("divisor or 1", updated_content)

            # Check terminal re-run command (Step 5)
            mock_vscode_control.assert_any_call(
                {"action": "run_in_terminal", "command": "python app.py"},
                player=mock_player
            )

    @patch("actions.code_helper._take_screenshot", return_value=None)
    def test_fix_error_on_screen_no_screenshot(self, mock_screenshot):
        res = _fix_error_on_screen(description="Fix error on screen")
        self.assertIn("Could not capture screen", res)

    def test_code_helper_unknown_action(self):
        res = code_helper({"action": "fly_to_moon"})
        self.assertIn("Unknown action", res)


if __name__ == "__main__":
    unittest.main()
