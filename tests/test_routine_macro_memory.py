import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from actions.computer_control import computer_control
from actions.routine import (
    execute_action_step,
    execute_macro_sequence,
    routine_manager,
)
from memory.routines_manager import (
    WORKSPACE_PRESETS,
    delete_routine,
    find_routine_or_preset,
    get_workspace_presets,
    list_routines,
    load_routines,
    record_routine_execution,
    save_routine,
    save_skill_macro,
)


class TestSkillMacroMemory(unittest.TestCase):
    """
    Test suite for [MODULE: SKILL & MACRO MEMORY]
    Step 1: Workspace routine execution sequence
    Step 2: Saving to Conversational Memory and local JSON storage
    Step 3: Fast direct macro loading without replanning
    """

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.routines_file = os.path.join(self.temp_dir.name, "routines.json")
        self.memory_file = os.path.join(self.temp_dir.name, "long_term.json")

        with open(self.routines_file, "w", encoding="utf-8") as f:
            json.dump([], f)

        with open(self.memory_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "identity": {},
                    "preferences": {},
                    "projects": {},
                    "relationships": {},
                    "wishes": {},
                    "notes": {},
                },
                f,
            )

        from pathlib import Path
        self.patch_routines_file = patch("memory.routines_manager.ROUTINES_FILE", new=Path(self.routines_file))
        # Ensure fresh cache
        import memory.routines_manager as rm
        rm._cache = None

        self.patch_memory_file = patch("memory.memory_manager.MEMORY_PATH", new=Path(self.memory_file))

        self.patch_routines_file.start()
        self.patch_memory_file.start()

    def tearDown(self):
        import memory.routines_manager as rm
        rm._cache = None
        self.patch_routines_file.stop()
        self.patch_memory_file.stop()
        self.temp_dir.cleanup()

    def test_workspace_presets_exist(self):
        """Step 1: Verify pre-defined workspace routines exist with valid steps."""
        presets = get_workspace_presets()
        self.assertIn("Start Coding Mode", presets)
        self.assertIn("Start Gaming Mode", presets)
        self.assertIn("Prepare Project Setup", presets)

        coding_mode = presets["Start Coding Mode"]
        self.assertGreaterEqual(len(coding_mode["steps"]), 3)
        tools = [s["tool"] for s in coding_mode["steps"]]
        self.assertIn("open_app", tools)
        self.assertIn("youtube_video", tools)
        self.assertIn("computer_settings", tools)

    def test_fast_lookup_by_name_and_alias(self):
        """Step 3: Direct loading of routine without needing to plan from scratch."""
        # Exact name
        match1 = find_routine_or_preset("Start Coding Mode")
        self.assertIsNotNone(match1)
        self.assertEqual(match1["name"], "Start Coding Mode")

        # Alias match
        match2 = find_routine_or_preset("coding mode")
        self.assertIsNotNone(match2)
        self.assertEqual(match2["name"], "Start Coding Mode")

        # Banglish alias match
        match3 = find_routine_or_preset("coding mode chalu koro")
        self.assertIsNotNone(match3)
        self.assertEqual(match3["name"], "Start Coding Mode")

        # Gaming mode
        match4 = find_routine_or_preset("start gaming mode")
        self.assertIsNotNone(match4)
        self.assertEqual(match4["name"], "Start Gaming Mode")

        # Project setup
        match5 = find_routine_or_preset("prepare project setup")
        self.assertIsNotNone(match5)
        self.assertEqual(match5["name"], "Prepare Project Setup")

    @patch("actions.open_app.open_app", return_value="Opened vscode.")
    @patch("actions.youtube_video.youtube_video", return_value="Playing Lo-Fi beats.")
    @patch("actions.computer_settings.computer_settings", return_value="Volume set to 25%.")
    @patch("actions.code_helper.code_helper", return_value="Dev workspace initialized.")
    def test_execute_workspace_coding_mode(self, mock_code, mock_vol, mock_yt, mock_open):
        """Step 1: Execute full sequence of actions for 'Start Coding Mode'."""
        result = execute_macro_sequence("Start Coding Mode")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["name"], "Start Coding Mode")
        self.assertEqual(result["steps_count"], 4)
        self.assertEqual(result["successful_steps"], 4)
        self.assertIn("Successfully executed routine 'Start Coding Mode'", result["report"])

    def test_save_skill_macro_persists_to_json_and_conversational_memory(self):
        """Step 2: Save successful multi-step action sequence into Conversational Memory & local JSON."""
        steps = [
            {"tool": "open_app", "args": {"app_name": "notepad"}, "description": "Open Notepad"},
            {"tool": "computer_settings", "args": {"action": "volume_set", "value": "15"}, "description": "Lower audio"},
        ]

        saved = save_skill_macro(
            name="Late Night Writing",
            steps=steps,
            description="Focus writing session",
            sync_conversational_memory=True,
        )

        self.assertEqual(saved["name"], "Late Night Writing")
        self.assertEqual(len(saved["steps"]), 2)

        # Check local JSON storage
        loaded = load_routines()
        names = [r["name"] for r in loaded]
        self.assertIn("Late Night Writing", names)

        # Check Conversational Memory sync
        from memory.memory_manager import load_memory
        mem = load_memory()
        prefs = mem.get("preferences", {})
        self.assertIn("macro_late_night_writing", prefs)
        self.assertIn("Late Night Writing", prefs["macro_late_night_writing"]["value"])

    @patch("actions.open_app.open_app", return_value="Opened notepad.")
    @patch("actions.computer_settings.computer_settings", return_value="Audio lowered.")
    def test_load_saved_macro_directly(self, mock_vol, mock_open):
        """Step 3: Load saved macro steps directly without replanning from scratch."""
        steps = [
            {"tool": "open_app", "args": {"app_name": "notepad"}},
            {"tool": "computer_settings", "args": {"action": "volume_set", "value": "15"}},
        ]
        save_skill_macro("Study Mode", steps=steps)

        # Query and run via routine_manager directly
        out = routine_manager({"action": "execute", "name": "study mode"})
        self.assertIn("Successfully executed routine 'Study Mode'", out)
        self.assertIn("Step 1 (open_app)", out)
        self.assertIn("Step 2 (computer_settings)", out)

    def test_routine_manager_learn_action(self):
        """Step 2: Learn action creates reusable skill with user parameters."""
        steps_json = json.dumps([
            {"tool": "browser_control", "args": {"action": "open_tab", "url": "https://news.ycombinator.com"}},
            {"tool": "computer_settings", "args": {"action": "volume_set", "value": "30"}}
        ])

        res = routine_manager({
            "action": "learn",
            "name": "Morning Briefing",
            "steps": steps_json,
        })

        self.assertIn("successfully learned and saved to Conversational Memory", res)

        # Check it can now be retrieved
        found = find_routine_or_preset("morning briefing")
        self.assertIsNotNone(found)
        self.assertEqual(len(found["steps"]), 2)

    def test_routine_manager_list_action(self):
        """Verify routine_manager list returns both presets and saved routines."""
        save_skill_macro("Custom Routine 1", steps=[{"tool": "open_app", "args": {"app_name": "calc"}}])
        output = routine_manager({"action": "list"})
        self.assertIn("Built-in Workspace Presets", output)
        self.assertIn("Start Coding Mode", output)
        self.assertIn("Custom Routine 1", output)

    def test_routine_manager_rejects_dangerous_power_action(self):
        """Safety invariant: Disallow shutdown, restart, sleep in automated routines."""
        dangerous_steps = [
            {"tool": "shutdown_ultron", "args": {}},
        ]
        res = routine_manager({
            "action": "learn",
            "name": "Self Destruct",
            "steps": dangerous_steps,
        })
        self.assertIn("Cannot save dangerous power action", res)

    @patch("actions.open_app.open_app", return_value="Opened discord.")
    @patch("actions.open_app.close_app", return_value="Closed chrome.")
    @patch("actions.computer_settings.computer_settings", return_value="Volume set to 70.")
    def test_computer_control_macro_dispatch(self, mock_vol, mock_close, mock_open):
        """Verify computer_control(action='macro') triggers routine execution."""
        res = computer_control({
            "action": "macro",
            "name": "Start Gaming Mode",
        })
        self.assertIn("Successfully executed routine 'Start Gaming Mode'", res)

    def test_record_routine_execution(self):
        """Verify execution tracking increments counter and updates timestamp."""
        save_skill_macro("Tracker Test", steps=[{"tool": "open_app", "args": {"app_name": "calc"}}])
        r1 = find_routine_or_preset("Tracker Test")
        self.assertEqual(r1.get("success_count", 0), 1)

        record_routine_execution("Tracker Test", success=True)
        r2 = find_routine_or_preset("Tracker Test")
        self.assertEqual(r2.get("success_count"), 2)
        self.assertIsNotNone(r2.get("last_run"))


if __name__ == "__main__":
    unittest.main()
