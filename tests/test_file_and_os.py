import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from actions.file_controller import (
    _get_safe_destination,
    copy_file,
    file_controller,
    move_file,
    organize_files,
)
from actions.computer_settings import (
    brightness_down,
    brightness_up,
    computer_settings,
    sleep_computer,
    shutdown_computer,
    toggle_bluetooth,
    toggle_wifi,
    volume_down,
    volume_mute,
    volume_set,
    volume_up,
)


class TestFileAndOSSystemManagement(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="mj_test_file_os_")
        self.src_dir = Path(self.test_dir) / "source"
        self.dst_dir = Path(self.test_dir) / "destination"
        self.src_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # -------------------------------------------------------------------------
    # Step 1 & 2: Safe collision handling & Destination verification
    # -------------------------------------------------------------------------
    def test_get_safe_destination_new_file(self):
        dest_folder = self.dst_dir / "target"
        safe_path, was_renamed = _get_safe_destination(dest_folder, "report.pdf")
        self.assertFalse(was_renamed)
        self.assertEqual(safe_path.name, "report.pdf")
        self.assertTrue(dest_folder.exists())

    def test_get_safe_destination_collision_rename(self):
        dest_folder = self.dst_dir / "target"
        dest_folder.mkdir(parents=True, exist_ok=True)
        (dest_folder / "report.pdf").write_text("existing content", encoding="utf-8")

        safe_path, was_renamed = _get_safe_destination(dest_folder, "report.pdf")
        self.assertTrue(was_renamed)
        self.assertEqual(safe_path.name, "report (1).pdf")

        # Create report (1).pdf and verify it increments to report (2).pdf
        safe_path.write_text("existing 1", encoding="utf-8")
        safe_path2, was_renamed2 = _get_safe_destination(dest_folder, "report.pdf")
        self.assertTrue(was_renamed2)
        self.assertEqual(safe_path2.name, "report (2).pdf")

    # -------------------------------------------------------------------------
    # Step 1, 2 & 4: File Organization in Background without dragging
    # -------------------------------------------------------------------------
    def test_organize_files_by_extension(self):
        # Create PDFs and text files
        for i in range(3):
            (self.src_dir / f"doc_{i}.pdf").write_text(f"PDF content {i}", encoding="utf-8")
        (self.src_dir / "notes.txt").write_text("text notes", encoding="utf-8")

        report = organize_files(
            path=str(self.src_dir),
            destination=str(self.dst_dir / "PDFs"),
            extension=".pdf"
        )
        self.assertIn("Successfully moved 3 file(s)", report)
        self.assertTrue((self.dst_dir / "PDFs" / "doc_0.pdf").exists())
        self.assertTrue((self.dst_dir / "PDFs" / "doc_1.pdf").exists())
        self.assertTrue((self.dst_dir / "PDFs" / "doc_2.pdf").exists())
        # Text file remains untouched in source
        self.assertTrue((self.src_dir / "notes.txt").exists())

    def test_organize_files_duplicate_collision_avoidance(self):
        # Create destination file already existing
        target_folder = self.dst_dir / "PDFs"
        target_folder.mkdir(parents=True, exist_ok=True)
        (target_folder / "contract.pdf").write_text("existing contract", encoding="utf-8")

        # Source file with identical name
        (self.src_dir / "contract.pdf").write_text("new contract", encoding="utf-8")

        report = organize_files(
            path=str(self.src_dir),
            destination=str(target_folder),
            extension=".pdf"
        )
        self.assertIn("Successfully moved 1 file(s)", report)
        self.assertIn("1 duplicate name(s) renamed without overwriting", report)
        self.assertTrue((target_folder / "contract.pdf").exists())
        self.assertTrue((target_folder / "contract (1).pdf").exists())
        self.assertEqual((target_folder / "contract.pdf").read_text(encoding="utf-8"), "existing contract")
        self.assertEqual((target_folder / "contract (1).pdf").read_text(encoding="utf-8"), "new contract")

    def test_organize_files_by_type(self):
        (self.src_dir / "paper.pdf").write_text("doc", encoding="utf-8")
        (self.src_dir / "photo.png").write_text("image", encoding="utf-8")
        (self.src_dir / "script.py").write_text("code", encoding="utf-8")

        report = organize_files(path=str(self.src_dir), by_type=True)
        self.assertIn("3 file(s) moved across categories", report)
        self.assertTrue((self.src_dir / "Documents" / "paper.pdf").exists())
        self.assertTrue((self.src_dir / "Images" / "photo.png").exists())
        self.assertTrue((self.src_dir / "Code" / "script.py").exists())

    def test_file_controller_dispatch_organize(self):
        (self.src_dir / "test1.pdf").write_text("p1", encoding="utf-8")
        (self.src_dir / "test2.pdf").write_text("p2", encoding="utf-8")

        res = file_controller({
            "action": "organize_files",
            "path": str(self.src_dir),
            "destination": str(self.dst_dir / "Invoices"),
            "extension": ".pdf"
        })
        self.assertIn("Successfully moved 2 file(s)", res)
        self.assertTrue((self.dst_dir / "Invoices" / "test1.pdf").exists())

    def test_move_file_collision_rename(self):
        (self.src_dir / "file.txt").write_text("source file", encoding="utf-8")
        self.dst_dir.mkdir(parents=True, exist_ok=True)
        (self.dst_dir / "file.txt").write_text("dest file", encoding="utf-8")

        res = move_file(path=str(self.src_dir), name="file.txt", destination=str(self.dst_dir))
        self.assertIn("file (1).txt", res)
        self.assertTrue((self.dst_dir / "file.txt").exists())
        self.assertTrue((self.dst_dir / "file (1).txt").exists())

    def test_copy_file_collision_rename(self):
        (self.src_dir / "copy_me.txt").write_text("original", encoding="utf-8")
        self.dst_dir.mkdir(parents=True, exist_ok=True)
        (self.dst_dir / "copy_me.txt").write_text("already here", encoding="utf-8")

        res = copy_file(path=str(self.src_dir), name="copy_me.txt", destination=str(self.dst_dir))
        self.assertIn("copy_me (1).txt", res)
        self.assertTrue((self.dst_dir / "copy_me.txt").exists())
        self.assertTrue((self.dst_dir / "copy_me (1).txt").exists())

    # -------------------------------------------------------------------------
    # Step 3 & 4: Native OS Settings Execution & State Reporting
    # -------------------------------------------------------------------------
    @patch("actions.computer_settings.volume_get", return_value=60)
    @patch("actions.computer_settings.pyautogui.press")
    def test_volume_controls_report_state(self, mock_press, mock_get_vol):
        res_up = volume_up()
        self.assertEqual(res_up, "Volume increased to 60%.")

        res_down = volume_down()
        self.assertEqual(res_down, "Volume decreased to 60%.")

        res_mute = volume_mute()
        self.assertEqual(res_mute, "Volume mute toggled.")

    @patch("actions.computer_settings.get_brightness", return_value=75)
    def test_brightness_controls_report_state(self, mock_brightness):
        with patch("actions.computer_settings.subprocess.run"):
            res_up = brightness_up()
            self.assertEqual(res_up, "Brightness increased to 75%.")

            res_down = brightness_down()
            self.assertEqual(res_down, "Brightness decreased to 75%.")

    @patch("actions.computer_settings.subprocess.run")
    def test_toggle_wifi_reports_state(self, mock_subproc):
        mock_res = MagicMock()
        mock_res.stdout = "Wi-Fi turned ON\n"
        mock_subproc.return_value = mock_res

        res = toggle_wifi()
        self.assertIn("Wi-Fi turned ON", res)

    @patch("actions.advanced_settings.toggle_bluetooth", return_value="Bluetooth is now turned ON.")
    def test_toggle_bluetooth_reports_state(self, mock_adv_bt):
        res = toggle_bluetooth(state="on")
        self.assertEqual(res, "Bluetooth is now turned ON.")

    @patch("actions.computer_settings.toggle_bluetooth", return_value="Bluetooth is now turned OFF.")
    def test_computer_settings_bluetooth_dispatch(self, mock_bt):
        res = computer_settings({"action": "bluetooth_off"})
        self.assertEqual(res, "Bluetooth is now turned OFF.")

    @patch("actions.computer_settings.toggle_wifi", return_value="Wi-Fi turned ON")
    def test_computer_settings_wifi_dispatch(self, mock_wifi):
        res = computer_settings({"action": "toggle_wifi"})
        self.assertEqual(res, "Wi-Fi turned ON")

    @patch("actions.computer_settings.subprocess.run")
    def test_power_commands_require_confirmation(self, mock_run):
        # Unconfirmed shutdown should block
        res = computer_settings({"action": "shutdown"})
        self.assertIn("The assistant must obtain an explicit yes", res)

        # Confirmed shutdown executes native call and reports state
        res_confirmed = computer_settings({"action": "shutdown", "confirmed": "yes"})
        self.assertEqual(res_confirmed, "System shutdown initiated (5s timer).")

    @patch("actions.computer_settings.subprocess.run")
    def test_sleep_computer_confirmed(self, mock_run):
        res_sleep = computer_settings({"action": "sleep_computer", "confirmed": "yes"})
        self.assertEqual(res_sleep, "Computer entered Sleep state.")


if __name__ == "__main__":
    unittest.main()
