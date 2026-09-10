import os
import unittest
from pathlib import Path
from unittest.mock import patch

from utils.env import PlatformStr, get_api_key, get_os, is_linux, is_mac, is_windows, load_config
import memory.config_manager as cm


class TestEnvAndConfig(unittest.TestCase):
    def test_platform_str(self):
        p_win = PlatformStr("windows")
        self.assertTrue(p_win == "windows")
        self.assertTrue(p_win == "Windows")
        self.assertTrue(p_win.is_windows)
        self.assertFalse(p_win.is_mac)

        p_mac = PlatformStr("mac")
        self.assertTrue(p_mac == "mac")
        self.assertTrue(p_mac == "Darwin")
        self.assertTrue(p_mac == "darwin")
        self.assertTrue(p_mac.is_mac)
        self.assertFalse(p_mac.is_windows)

        p_linux = PlatformStr("linux")
        self.assertTrue(p_linux == "linux")
        self.assertTrue(p_linux == "Linux")
        self.assertTrue(p_linux.is_linux)

    def test_get_api_key_env_precedence(self):
        with patch.dict(os.environ, {"TEST_KEY_FOR_UNIT_TEST": "test_secret_123"}):
            self.assertEqual(get_api_key("TEST_KEY_FOR_UNIT_TEST"), "test_secret_123")
            self.assertEqual(get_api_key("test_key_for_unit_test"), "test_secret_123")

    def test_config_manager_helpers(self):
        cm.clear_cache()
        # Verify assistant name returns configured name or MJ
        name = cm.get_assistant_name()
        self.assertTrue(bool(name))

        # Verify followup seconds returns float between 1.0 and 60.0
        sec = cm.get_followup_listen_seconds()
        self.assertTrue(1.0 <= sec <= 60.0)

        # Verify barge-in threshold returns float
        thresh = cm.get_barge_in_threshold()
        self.assertTrue(500.0 <= thresh <= 8000.0)


if __name__ == "__main__":
    unittest.main()
