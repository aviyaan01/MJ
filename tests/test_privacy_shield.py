# tests/test_privacy_shield.py
"""
Unit tests for actions/privacy_shield.py:
- Step 1: Redaction of API keys, passwords, .env credentials, and speech/log shielding.
- Step 2: Strict local offline routing for sensitive files (.env, credentials) via mj-os-agent.
- Step 3: Anti-autofill guardrails protecting passwords and API keys from unauthorized entry.
- Integration with computer_control and unified tool entrypoint.
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from actions.privacy_shield import (
    is_sensitive_path,
    contains_sensitive_data,
    is_banking_or_financial_context,
    redact_sensitive_text,
    sanitize_spoken_text,
    sanitize_log_message,
    should_route_locally,
    execute_local_env_task,
    query_local_mj_agent,
    is_password_or_credential_field,
    verify_credential_modification_allowed,
    privacy_shield,
)
from actions.computer_control import computer_control


class TestPrivacyShield(unittest.TestCase):

    def test_sensitive_path_detection(self):
        """Step 1: Correctly identifies sensitive files (.env, api_keys, id_rsa)."""
        self.assertTrue(is_sensitive_path(".env"))
        self.assertTrue(is_sensitive_path("/path/to/.env.local"))
        self.assertTrue(is_sensitive_path("C:\\Users\\ASUS\\Desktop\\MJ\\.env"))
        self.assertTrue(is_sensitive_path("config/api_keys.json"))
        self.assertTrue(is_sensitive_path("credentials.json"))
        self.assertTrue(is_sensitive_path("id_rsa"))
        self.assertTrue(is_sensitive_path("secrets.yaml"))

        # Non-sensitive paths
        self.assertFalse(is_sensitive_path("main.py"))
        self.assertFalse(is_sensitive_path("readme.md"))
        self.assertFalse(is_sensitive_path("actions/computer_control.py"))

    def test_contains_sensitive_data(self):
        """Step 1: Accurately flags API keys, passwords, bearer tokens, and private keys."""
        # Google API key
        self.assertTrue(contains_sensitive_data("API_KEY = AIzaSyA1234567890abcdefghijklmnopqrstuvw"))
        # OpenAI key
        self.assertTrue(contains_sensitive_data("OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456"))
        # GitHub PAT
        self.assertTrue(contains_sensitive_data("ghp_123456789012345678901234567890123456"))
        # Password assignment
        self.assertTrue(contains_sensitive_data("PASSWORD=SuperSecretPass123!"))
        # Private key
        self.assertTrue(contains_sensitive_data("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"))

        # Clean text
        self.assertFalse(contains_sensitive_data("Hello, how are you today?"))
        self.assertFalse(contains_sensitive_data("Open VS Code and navigate to line 45."))

    def test_redact_sensitive_text(self):
        """Step 1: Replaces secrets with redaction tokens in text."""
        raw = "My OpenAI key is sk-1234567890abcdefghijklmnop and password is PASSWORD='mySecretPassword99'"
        redacted = redact_sensitive_text(raw)
        self.assertNotIn("sk-1234567890abcdefghijklmnop", redacted)
        self.assertNotIn("mySecretPassword99", redacted)
        self.assertIn("[REDACTED_OPENAI_API_KEY]", redacted)
        self.assertIn("[REDACTED_PASSWORD]", redacted)

    def test_sanitize_spoken_text_blocks_raw_secrets(self):
        """Step 1: Never reads raw passwords or API keys aloud."""
        secret_speech = "Your API key is AIzaSyA1234567890abcdefghijklmnopqrstuvw and your password is pass1234"
        clean_speech = sanitize_spoken_text(secret_speech)
        self.assertNotIn("AIzaSyA1234567890abcdefghijklmnopqrstuvw", clean_speech)
        self.assertIn("under the privacy shield policy", clean_speech.lower())

        # Safe speech remains intact
        safe = "VS Code is open and running on line 20."
        self.assertEqual(sanitize_spoken_text(safe), safe)

    def test_sanitize_log_message(self):
        """Step 1: Ensures plain text logs never store raw secrets."""
        log_line = "[Config] Set GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuvw"
        clean_log = sanitize_log_message(log_line)
        self.assertNotIn("AIzaSyA1234567890abcdefghijklmnopqrstuvw", clean_log)
        self.assertIn("[REDACTED_GOOGLE_API_KEY]", clean_log)

    def test_should_route_locally(self):
        """Step 2: Routes sensitive files and credential tasks to local offline model."""
        self.assertTrue(should_route_locally("Update the API key in configuration", file_path=".env"))
        self.assertTrue(should_route_locally("Read passwords from credentials file"))
        self.assertTrue(should_route_locally("Inspect local .env settings"))

        # Generic tasks do not require local routing
        self.assertFalse(should_route_locally("Search the weather in Dhaka", file_path="weather.py"))
        self.assertFalse(should_route_locally("Open Brave and play a song on YouTube"))

    def test_execute_local_env_task(self):
        """Step 2: Safely reads, sets, and deletes .env variables offline without cloud calls."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_env = Path(tmpdir) / ".env"
            # Set key
            res_set = execute_local_env_task("set", key="MY_SECRET_KEY", value="super_secret_val_123", env_path=test_env)
            self.assertTrue(res_set["success"])
            self.assertIn("REDACTED", res_set["masked_value"])

            # Verify file content on disk
            content = test_env.read_text(encoding="utf-8")
            self.assertIn("MY_SECRET_KEY=super_secret_val_123", content)

            # Get key safely
            res_get = execute_local_env_task("get", key="MY_SECRET_KEY", env_path=test_env)
            self.assertTrue(res_get["success"])
            self.assertIn("REDACTED", res_get["masked_value"])

            # Delete key
            res_del = execute_local_env_task("delete", key="MY_SECRET_KEY", env_path=test_env)
            self.assertTrue(res_del["success"])
            self.assertNotIn("MY_SECRET_KEY", test_env.read_text(encoding="utf-8"))

    @patch("urllib.request.urlopen")
    def test_query_local_mj_agent_offline(self, mock_urlopen):
        """Step 2: Queries local mj-os-agent on Ollama strictly offline."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = b'{"response": "Local offline analysis complete."}'
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        res = query_local_mj_agent("Analyze credentials locally")
        self.assertEqual(res, "Local offline analysis complete.")

    def test_password_field_detection(self):
        """Step 3: Accurately identifies password and credential fields."""
        self.assertTrue(is_password_or_credential_field(description="Enter password here"))
        self.assertTrue(is_password_or_credential_field(description="Confirm PIN code"))
        self.assertTrue(is_password_or_credential_field(field_name="api_key_input"))
        self.assertTrue(is_password_or_credential_field(field_name="user_password"))

        self.assertFalse(is_password_or_credential_field(description="Search Google"))
        self.assertFalse(is_password_or_credential_field(field_name="username"))

    def test_anti_autofill_guardrail(self):
        """Step 3: Never auto-fills passwords without explicit user instruction."""
        # Unauthorized / generic navigation -> BLOCKED
        allowed, reason = verify_credential_modification_allowed(
            user_turn_command="Click login and fill form",
            field_description="password",
        )
        self.assertFalse(allowed)
        self.assertIn("Blocked auto-fill", reason)

        # Explicit user instruction -> ALLOWED
        allowed_explicit, _ = verify_credential_modification_allowed(
            user_turn_command="Please type password in the box",
            field_description="password",
        )
        self.assertTrue(allowed_explicit)

        allowed_banglish, _ = verify_credential_modification_allowed(
            user_turn_command="password dao ebong enter chapo",
            field_description="password",
        )
        self.assertTrue(allowed_banglish)

    def test_computer_control_blocks_unauthorized_password_autofill(self):
        """Step 3: computer_control smart_type blocks password auto-fill if not explicitly confirmed."""
        res = computer_control({
            "action": "smart_type",
            "description": "Password input field",
            "field": "password",
            "text": "SecretPass123",
            # No explicit confirmation
        })
        self.assertIn("PRIVACY SHIELD GUARD", res)
        self.assertIn("Auto-fill blocked", res)

    def test_privacy_shield_unified_tool_entrypoint(self):
        """Unified tool entrypoint dispatches actions cleanly."""
        redacted = privacy_shield({
            "action": "redact",
            "text": "My key is sk-1234567890abcdefghijklmnop",
        })
        self.assertIn("[REDACTED_OPENAI_API_KEY]", redacted)

        sensitive_check = privacy_shield({
            "action": "check_sensitive",
            "file_path": ".env",
        })
        self.assertIn("SENSITIVE CONTENT DETECTED", sensitive_check)

        guardrail_check = privacy_shield({
            "action": "check_autofill",
            "user_command": "navigate to dashboard",
            "field": "password",
        })
        self.assertIn("ALLOWED: False", guardrail_check)


if __name__ == "__main__":
    unittest.main()
