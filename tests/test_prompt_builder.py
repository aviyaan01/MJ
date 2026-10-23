import tempfile
import unittest
from pathlib import Path

from core.prompt_builder import build_mj_full_prompt as core_build_prompt
from mj_trainer import build_mj_full_prompt as trainer_build_prompt


class TestPromptBuilder(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.jsonl_file = Path(self.temp_dir.name) / "test_data.jsonl"
        with open(self.jsonl_file, "w", encoding="utf-8") as f:
            for i in range(5):
                f.write(f'{{"example_id": {i}, "action": "click_{i}"}}\n')

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_build_mj_full_prompt_structure(self):
        master = "You are MJ (ULTRON), an autonomous desktop agent."
        command = "Downloads er shob PDF Invoices folder e nao"
        
        prompt = core_build_prompt(
            user_command=command,
            master_prompt=master,
            jsonl_path=str(self.jsonl_file)
        )

        # Check master prompt inclusion
        self.assertIn("You are MJ (ULTRON), an autonomous desktop agent.", prompt)
        
        # Check Reference section header
        self.assertIn("### REFERENCE OS INTERACTION EXAMPLES (FROM JEDI DATASET):", prompt)
        
        # Check exactly 3 examples loaded
        self.assertIn('"example_id": 0', prompt)
        self.assertIn('"example_id": 1', prompt)
        self.assertIn('"example_id": 2', prompt)
        self.assertNotIn('"example_id": 3', prompt)
        self.assertNotIn('"example_id": 4', prompt)

        # Check current user command section
        self.assertIn('### CURRENT USER COMMAND:\n"Downloads er shob PDF Invoices folder e nao"', prompt)
        self.assertIn("Respond with your step-by-step plan and execute the required tool calls:", prompt)

    def test_missing_jsonl_graceful_handling(self):
        prompt = trainer_build_prompt(
            user_command="volume 50 koro",
            master_prompt="Master Prompt",
            jsonl_path="non_existent_file.jsonl"
        )
        self.assertIn("Master Prompt", prompt)
        self.assertIn('"volume 50 koro"', prompt)
        self.assertIn("### REFERENCE OS INTERACTION EXAMPLES (FROM JEDI DATASET):", prompt)

    def test_default_jedi_dataset_loading(self):
        # When default jedi_training_data.jsonl exists in project root
        prompt = core_build_prompt(
            user_command="Brave open koro",
            master_prompt="Master prompt test"
        )
        self.assertIn("Master prompt test", prompt)
        self.assertIn('"Brave open koro"', prompt)
        self.assertIn("### REFERENCE OS INTERACTION EXAMPLES (FROM JEDI DATASET):", prompt)

    def test_mj_prompts_master_prompt_modules(self):
        from mj_prompts import MASTER_SYSTEM_PROMPT
        expected_modules = [
            "[VISION & GROUNDING]",
            "[WEB & OFFICE]",
            "[MESSAGING]",
            "[CODING & VSCODE]",
            "[FILE & OS]",
            "[CROSS-APP & CLIPBOARD]",
            "[SELF-HEALING]",
            "[PRIVACY SHIELD]",
            "[SKILL & MACRO MEMORY]",
            "[PROACTIVE WATCHER]",
        ]
        for mod in expected_modules:
            self.assertIn(mod, MASTER_SYSTEM_PROMPT)

    def test_get_mj_prompt_with_jedi(self):
        from mj_prompts import get_mj_prompt_with_jedi
        prompt = get_mj_prompt_with_jedi(
            user_command="Start Coding Mode",
            jsonl_path=str(self.jsonl_file)
        )
        self.assertIn("You are MJ (ULTRON)", prompt)
        self.assertIn("### JEDI OS DATASET REFERENCE EXAMPLES:", prompt)
        self.assertIn('"example_id": 0', prompt)
        self.assertIn('### USER COMMAND:\n"Start Coding Mode"', prompt)


if __name__ == "__main__":
    unittest.main()

