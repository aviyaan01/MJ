import os
import unittest
from unittest.mock import MagicMock, patch

from actions.computer_control import computer_control
from actions.proactive_watcher import (
    PROTECTED_PROCESS_NAMES,
    ProactiveWatcher,
    WatchedTask,
    proactive_watcher,
)


class TestProactiveWatcherAndSystemGuard(unittest.TestCase):
    """
    Test suite for [MODULE: PROACTIVE WATCHER & SYSTEM GUARD]
    Step 1: Long process monitoring via terminal / progress bar
    Step 2: Proactive voice/UI alerts on completion or fatal error
    Step 3: Critical CPU/RAM spikes (>90%) with heavy process identification & user confirmation
    """

    def setUp(self):
        self.watcher = ProactiveWatcher()

    def test_start_and_get_watched_task(self):
        """Step 1: Successfully registers a long process to watch."""
        task = self.watcher.start_watch("model training", "training")
        self.assertEqual(task["task_name"], "model training")
        self.assertEqual(task["task_type"], "training")
        self.assertEqual(task["status"], "running")

        all_tasks = self.watcher.get_tasks()
        self.assertEqual(len(all_tasks), 1)
        self.assertEqual(all_tasks[0]["task_name"], "model training")

    def test_analyze_output_progress_bar(self):
        """Step 1: Parses ongoing progress percentages and epochs."""
        output1 = "Epoch 45/100 [==============>.............] - ETA: 02:15 - loss: 0.123"
        analysis1 = self.watcher.analyze_output_for_status(output1)
        self.assertEqual(analysis1["status"], "running")
        self.assertEqual(analysis1["progress"], 45.0)

        output2 = "Downloading dataset: 78.5% of 10.2GB completed"
        analysis2 = self.watcher.analyze_output_for_status(output2)
        self.assertEqual(analysis2["status"], "running")
        self.assertEqual(analysis2["progress"], 78.5)

    def test_analyze_output_task_completed(self):
        """Step 2: Proactively notifies 'Boss, your task is finished' on completion."""
        # 100% completion
        out1 = "100% completed - Training finished successfully in 45.2s"
        analysis1 = self.watcher.analyze_output_for_status(out1)
        self.assertEqual(analysis1["status"], "completed")
        self.assertIn("Boss, your task is finished", analysis1["voice_alert"])

        # Download complete
        out2 = "Successfully downloaded and extracted jedi_training_data.jsonl"
        analysis2 = self.watcher.analyze_output_for_status(out2)
        self.assertEqual(analysis2["status"], "completed")
        self.assertIn("Boss, your task is finished", analysis2["voice_alert"])

        # Process exit 0
        out3 = "Process finished with exit code 0"
        analysis3 = self.watcher.analyze_output_for_status(out3)
        self.assertEqual(analysis3["status"], "completed")

    def test_analyze_output_fatal_error(self):
        """Step 2: Proactively notifies 'Boss, the script stopped with an error—should I fix it?'."""
        error_trace = (
            "Epoch 12/100\n"
            "Traceback (most recent call last):\n"
            "  File 'train.py', line 54, in <module>\n"
            "    ZeroDivisionError: division by zero"
        )
        analysis = self.watcher.analyze_output_for_status(error_trace)
        self.assertEqual(analysis["status"], "error")
        self.assertTrue(analysis["should_fix"])
        self.assertIn("Boss, the script stopped with an error—should I fix it?", analysis["voice_alert"])
        self.assertIn("Traceback", analysis["error_snippet"])

    def test_inspect_active_task_voice_and_ui_trigger(self):
        """Step 2: Full inspect loop updates task status and triggers alert."""
        self.watcher.start_watch("server deployment", "deployment")
        mock_player = MagicMock()

        res_complete = self.watcher.inspect_active_task(
            task_name="server deployment",
            screen_text="Deployment finished successfully. Done in 12.3s",
            player=mock_player,
        )
        self.assertEqual(res_complete["status"], "completed")
        self.assertIn("Boss, your task is finished", res_complete["voice_alert"])
        mock_player.write_log.assert_called()

    @patch("psutil.cpu_percent", return_value=94.5)
    @patch("psutil.virtual_memory")
    def test_check_system_spikes_identifies_heavy_process(self, mock_vm, mock_cpu):
        """Step 3: Detects spike >90%, identifies heavy process, and asks user to terminate."""
        mock_vm.return_value = MagicMock(percent=75.0)

        fake_proc = MagicMock()
        fake_proc.info = {
            "pid": 8844,
            "name": "render_daemon.exe",
            "cpu_percent": 88.0,
            "memory_percent": 30.0,
            "memory_info": MagicMock(rss=1024 * 1024 * 1500),  # 1500 MB
        }

        with patch("psutil.process_iter", return_value=[fake_proc]):
            spikes = self.watcher.check_system_spikes(cpu_threshold=90.0, ram_threshold=90.0)
            self.assertTrue(spikes["spiked"])
            self.assertEqual(spikes["cpu"], 94.5)
            self.assertIsNotNone(spikes["heavy_process"])
            self.assertEqual(spikes["heavy_process"]["name"], "render_daemon.exe")
            self.assertEqual(spikes["heavy_process"]["pid"], 8844)
            self.assertIn("Would you like me to terminate it", spikes["user_prompt"])

    @patch("psutil.cpu_percent", return_value=35.0)
    @patch("psutil.virtual_memory")
    def test_check_system_spikes_normal_load(self, mock_vm, mock_cpu):
        """Step 3: Normal CPU/RAM usage produces no false spike warnings."""
        mock_vm.return_value = MagicMock(percent=45.0)
        spikes = self.watcher.check_system_spikes(cpu_threshold=90.0, ram_threshold=90.0)
        self.assertFalse(spikes["spiked"])
        self.assertIsNone(spikes["heavy_process"])

    def test_terminate_heavy_process_safety_guards(self):
        """Safety invariant: Never terminates current PID or system-critical processes."""
        # Current python PID
        my_pid = os.getpid()
        res_self = self.watcher.terminate_heavy_process(pid=my_pid, confirmed=True)
        self.assertEqual(res_self["status"], "error")
        self.assertIn("core system process", res_self["message"])

        # PID 0
        res_zero = self.watcher.terminate_heavy_process(pid=0, confirmed=True)
        self.assertEqual(res_zero["status"], "error")

        # Unconfirmed termination is blocked
        res_unconfirmed = self.watcher.terminate_heavy_process(pid=12345, confirmed=False)
        self.assertEqual(res_unconfirmed["status"], "blocked")

    @patch("actions.proactive_watcher.psutil.Process")
    @patch("actions.proactive_watcher.psutil.wait_procs", return_value=([MagicMock()], []))
    def test_terminate_heavy_process_success(self, mock_wait, mock_proc_cls):
        """Step 3: Terminate confirmed heavy process."""
        mock_proc = MagicMock()
        mock_proc.name.return_value = "rogue_task.exe"
        mock_proc_cls.return_value = mock_proc

        res = self.watcher.terminate_heavy_process(pid=9999, name="rogue_task.exe", confirmed=True)
        self.assertEqual(res["status"], "success")
        self.assertIn("Successfully terminated", res["message"])
        mock_proc.terminate.assert_called_once()

    def test_proactive_watcher_tool_interface(self):
        """Verify unified tool handler operations."""
        # Watch
        w_res = proactive_watcher({"action": "watch", "task_name": "large file download"})
        self.assertIn("monitoring 'large file download'", w_res)

        # Inspect completed
        c_res = proactive_watcher({
            "action": "inspect",
            "task_name": "large file download",
            "screen_text": "Download finished successfully 100%",
        })
        self.assertIn("Boss, your task is finished", c_res)

        # Inspect fatal error
        e_res = proactive_watcher({
            "action": "inspect",
            "task_name": "large file download",
            "screen_text": "Traceback (most recent call last):\n  ImportError: No module named 'torch'",
        })
        self.assertIn("Boss, the script stopped with an error—should I fix it?", e_res)

        # Status
        s_res = proactive_watcher({"action": "status"})
        self.assertIn("Proactive Watcher Status", s_res)

    def test_computer_control_integration(self):
        """Verify computer_control dispatches proactive_watcher actions."""
        res = computer_control({
            "action": "check_spikes",
        })
        self.assertTrue("System load is normal" in res or "spiked critically" in res)


if __name__ == "__main__":
    unittest.main()
