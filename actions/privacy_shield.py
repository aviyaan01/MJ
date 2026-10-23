# actions/privacy_shield.py
"""
MJ (ULTRON) — Privacy Shield & Local Routing Module
===================================================
Protects sensitive user data during continuous Screen Vision, OS automation, and file operations:
- Step 1: Detects sensitive content (.env files, API keys, password fields, banking portals,
    private credentials) and strictly prevents echoing raw secrets aloud or storing them
    in plain text logs.
- Step 2: Routes sensitive local file manipulations and system credential tasks strictly
    through the local offline model (mj-os-agent on Ollama) rather than external cloud calls.
- Step 3: Enforces guardrails to never auto-fill or modify passwords/API keys unless
    explicitly instructed by the user in the current turn.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Tuple

from utils.env import get_base_dir

# ============================================================================
# SENSITIVE PATTERNS & REGEX RECOGNITION
# ============================================================================

# Known sensitive file names and extensions
SENSITIVE_FILE_PATTERNS = (
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "api_keys.json",
    "credentials.json",
    "client_secret.json",
    "service_account.json",
    "secrets.yaml",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
    ".netrc",
    "passwd",
    "shadow",
)

# Common credential and API key regex patterns
_REGEX_GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z\-_]{35}")
_REGEX_OPENAI_KEY = re.compile(r"sk-[a-zA-Z0-9_\-]{20,}")
_REGEX_GITHUB_PAT = re.compile(r"gh[pousr]_[0-9a-zA-Z]{36}")
_REGEX_AWS_KEY    = re.compile(r"AKIA[0-9A-Z]{16}")
_REGEX_BEARER_TOKEN = re.compile(r"(?i)bearer\s+[a-zA-Z0-9_\-\.]{25,}")
_REGEX_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")
_REGEX_CREDIT_CARD = re.compile(r"\b(?:\d{4}[ -]?){3}\d{4}\b")

# Key-Value assignments in configs/.env: KEY=VALUE or KEY: VALUE
_REGEX_ENV_SECRET = re.compile(
    r"(?i)\b(api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)\b\s*([:=])\s*['\"]?([^\s'\"]{4,})['\"]?"
)

# Keywords indicating password or credential input fields
_PASSWORD_FIELD_KEYWORDS = {
    "password", "passwd", "pin", "cvv", "security code", "api key",
    "token", "secret", "private key", "passcode", "otp"
}

# Keywords indicating banking or sensitive financial context
_BANKING_KEYWORDS = {
    "bank", "banking", "account balance", "routing number",
    "card number", "credit card", "debit card", "transaction pin",
    "net banking", "wire transfer", "swift code", "iban"
}


# ============================================================================
# STEP 1: Redaction & Plain Text Shielding
# ============================================================================

def is_sensitive_path(path: str | Path | None) -> bool:
    """Check if a file path points to a sensitive credential or secret file."""
    if not path:
        return False
    p = Path(path)
    name = p.name.lower()

    for pattern in SENSITIVE_FILE_PATTERNS:
        if pattern.startswith("*.") and name.endswith(pattern[1:]):
            return True
        if name == pattern.lower() or name.startswith(".env"):
            return True

    return False


def contains_sensitive_data(text: str) -> bool:
    """Check if text contains API keys, passwords, private keys, or credentials."""
    if not text:
        return False

    if _REGEX_GOOGLE_KEY.search(text) or _REGEX_OPENAI_KEY.search(text) or _REGEX_GITHUB_PAT.search(text):
        return True
    if _REGEX_AWS_KEY.search(text) or _REGEX_BEARER_TOKEN.search(text) or _REGEX_PRIVATE_KEY.search(text):
        return True
    if _REGEX_CREDIT_CARD.search(text) or _REGEX_ENV_SECRET.search(text):
        return True

    return False


def is_banking_or_financial_context(text: str) -> bool:
    """Check if text relates to banking portals, account numbers, or financial credentials."""
    if not text:
        return False
    lower = text.lower()
    return any(k in lower for k in _BANKING_KEYWORDS)


def mask_secret_value(value: str) -> str:
    """Mask a secret showing only the first 3 and last 3 characters if long enough."""
    v = value.strip()
    if len(v) <= 8:
        return "***REDACTED***"
    return f"{v[:3]}...{v[-3:]} (REDACTED)"


def redact_sensitive_text(text: str) -> str:
    """
    Sanitize text by replacing sensitive API keys, passwords, private keys,
    and credentials with safe masked tokens.
    """
    if not text:
        return text

    # Redact private keys
    sanitized = _REGEX_PRIVATE_KEY.sub("[REDACTED_PRIVATE_KEY]", text)

    # Redact well-known API keys
    sanitized = _REGEX_GOOGLE_KEY.sub("[REDACTED_GOOGLE_API_KEY]", sanitized)
    sanitized = _REGEX_OPENAI_KEY.sub("[REDACTED_OPENAI_API_KEY]", sanitized)
    sanitized = _REGEX_GITHUB_PAT.sub("[REDACTED_GITHUB_TOKEN]", sanitized)
    sanitized = _REGEX_AWS_KEY.sub("[REDACTED_AWS_KEY]", sanitized)
    sanitized = _REGEX_BEARER_TOKEN.sub("Bearer [REDACTED_TOKEN]", sanitized)
    sanitized = _REGEX_CREDIT_CARD.sub("[REDACTED_CARD_NUMBER]", sanitized)

    # Redact generic key=value secrets
    def _mask_env_match(m: re.Match) -> str:
        k_name = m.group(1)
        sep = m.group(2)
        val = m.group(3)
        return f"{k_name}{sep}[REDACTED_{k_name.upper()}]"

    sanitized = _REGEX_ENV_SECRET.sub(_mask_env_match, sanitized)
    return sanitized


def sanitize_spoken_text(text: str) -> str:
    """
    Ensure speech/TTS never echoes raw secrets or passwords aloud.
    If the text attempts to read an API key or password, replace with a privacy-safe notice.
    """
    if not text:
        return text

    if contains_sensitive_data(text):
        redacted = redact_sensitive_text(text)
        # If the text was purely or heavily credential content, inform the user cleanly
        if "[REDACTED_" in redacted and len(text) - len(redacted) > 10:
            return (
                "Sir, sensitive credentials were detected on screen. Under the Privacy Shield policy, "
                "I will not read raw API keys or passwords aloud."
            )
        return redacted

    return text


def sanitize_log_message(message: str) -> str:
    """Ensure plain text logs and console messages never store raw credentials."""
    return redact_sensitive_text(message)


# ============================================================================
# STEP 2: Local Offline Routing (mj-os-agent on Ollama)
# ============================================================================

def should_route_locally(task_description: str, file_path: str | None = None) -> bool:
    """
    Determine if a file manipulation or credential task MUST be routed strictly
    to the local offline model (mj-os-agent) rather than external cloud APIs.
    """
    if file_path and is_sensitive_path(file_path):
        return True

    lower = (task_description or "").lower()
    triggers = (
        ".env", "api_key", "api key", "password", "credential",
        "secret", "private key", "banking", "token", "auth token"
    )
    return any(t in lower for t in triggers)


def query_local_mj_agent(prompt: str, timeout: int = 15) -> str:
    """
    Strictly query the local offline model (mj-os-agent on Ollama) without
    making any external cloud network requests.
    """
    try:
        import urllib.request
        data = json.dumps({
            "model": "mj-os-agent",
            "prompt": prompt,
            "stream": False
        }).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:11434/api/generate",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("response", "").strip()
    except Exception as e:
        print(f"[PrivacyShield] Local model query exception: {e}")
        return ""


def execute_local_env_task(
    action: str,
    key: str,
    value: str | None = None,
    env_path: Path | str | None = None,
) -> dict[str, Any]:
    """
    Local, deterministic, zero-cloud .env manipulation:
    - action='get': Safely reads a key and returns masked representation.
    - action='set': Safely sets key=value in .env file locally.
    - action='delete': Safely removes a key from .env file locally.
    Never transmits raw values to cloud APIs or logs.
    """
    p = Path(env_path) if env_path else get_base_dir() / ".env"
    act = action.lower().strip()

    if not p.exists():
        if act == "set":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(f"{key}={value or ''}\n", encoding="utf-8")
            return {
                "success": True,
                "action": "set",
                "key": key,
                "masked_value": mask_secret_value(value or ""),
                "message": f"[PrivacyShield] Created local .env and set '{key}' securely.",
            }
        return {"success": False, "message": f".env file not found at {p}"}

    lines = p.read_text(encoding="utf-8").splitlines()
    found = False
    new_lines = []

    if act == "get":
        for line in lines:
            if line.strip().startswith(f"{key}="):
                _, raw_val = line.split("=", 1)
                return {
                    "success": True,
                    "key": key,
                    "masked_value": mask_secret_value(raw_val.strip().strip("'\"")),
                    "message": f"[PrivacyShield] '{key}' is present in local .env ({mask_secret_value(raw_val)}).",
                }
        return {"success": False, "message": f"Key '{key}' not found in local .env"}

    if act == "set":
        for line in lines:
            if line.strip().startswith(f"{key}="):
                new_lines.append(f"{key}={value or ''}")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"{key}={value or ''}")
        p.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        return {
            "success": True,
            "action": "set",
            "key": key,
            "masked_value": mask_secret_value(value or ""),
            "message": f"[PrivacyShield] Updated '{key}' securely in local .env without cloud exposure.",
        }

    if act == "delete":
        for line in lines:
            if not line.strip().startswith(f"{key}="):
                new_lines.append(line)
        p.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        return {
            "success": True,
            "action": "delete",
            "key": key,
            "message": f"[PrivacyShield] Removed '{key}' from local .env.",
        }

    return {"success": False, "message": f"Unknown env action: '{action}'"}


# ============================================================================
# STEP 3: Anti-Autofill / Modification Guardrail
# ============================================================================

def is_password_or_credential_field(description: str = "", field_name: str = "") -> bool:
    """Check if the UI element is a password or credential input field."""
    combined = f"{description} {field_name}".lower().replace("_", " ").replace("-", " ")
    return any(kw in combined for kw in _PASSWORD_FIELD_KEYWORDS)


def verify_credential_modification_allowed(
    user_turn_command: str,
    field_description: str = "password",
) -> Tuple[bool, str]:
    """
    Guardrail: Never auto-fill or modify passwords/API keys unless explicitly
    instructed by the user in the current turn.
    Returns (is_allowed, reason_or_warning).
    """
    cmd = (user_turn_command or "").lower().strip()
    field_lower = field_description.lower().strip()

    # Check if user explicitly asked to type/fill password or update API key
    explicit_indicators = (
        "type password", "fill password", "enter password", "password dao",
        "password lekho", "update api key", "set api key", "change password",
        "input password", "password boshaw", "save key", "write key"
    )

    for indicator in explicit_indicators:
        if indicator in cmd:
            return True, "Explicit user instruction confirmed for current turn."

    # If the command does not explicitly mention typing/filling the credential
    return False, (
        f"[PRIVACY SHIELD GUARD] Blocked auto-fill/modification of '{field_description}'. "
        "MJ strictly refuses to auto-fill or mutate passwords/API keys unless explicitly "
        "instructed by the user in the current turn."
    )


# ============================================================================
# Unified Tool Entrypoint
# ============================================================================

def privacy_shield(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Unified entrypoint for Privacy Shield and Local Routing.

    Parameters:
        action: redact | check_sensitive | local_env | local_model | check_autofill
        text: Text to sanitize or check
        file_path: Target file path
        key: Key name for .env operations
        value: Value for .env operations
        env_action: get | set | delete (for local_env)
        user_command: User's instruction to verify explicit permission
        field: Field name/type to verify (e.g. 'password', 'api_key')
    """
    params = parameters or {}
    action = str(params.get("action", "redact")).lower().strip().replace("-", "_")

    if player and hasattr(player, "write_log"):
        player.write_log(f"[PrivacyShield] {action}")

    # Action 1: Redact sensitive text
    if action in ("redact", "sanitize", "mask"):
        raw_text = params.get("text", "")
        return redact_sensitive_text(raw_text)

    # Action 2: Check if text or file contains sensitive content
    if action in ("check_sensitive", "is_sensitive", "detect_secrets"):
        path = params.get("file_path")
        text = params.get("text", "")
        sensitive_path = is_sensitive_path(path) if path else False
        sensitive_content = contains_sensitive_data(text) if text else False
        banking = is_banking_or_financial_context(text) if text else False

        if sensitive_path or sensitive_content or banking:
            return (
                f"[PrivacyShield] SENSITIVE CONTENT DETECTED: path_sensitive={sensitive_path}, "
                f"secrets_detected={sensitive_content}, banking_detected={banking}. "
                "External echoing and plain text logging are blocked."
            )
        return "[PrivacyShield] No sensitive credentials or secret files detected."

    # Action 3: Local offline .env manipulation
    if action in ("local_env", "env_task", "manage_env"):
        env_act = params.get("env_action", "get")
        key = params.get("key", "")
        val = params.get("value")
        p = params.get("file_path")
        res = execute_local_env_task(env_act, key=key, value=val, env_path=p)
        return str(res.get("message", res))

    # Action 4: Query local offline model (mj-os-agent) strictly
    if action in ("local_model", "query_offline", "mj_os_agent"):
        prompt = params.get("prompt") or params.get("text", "")
        resp = query_local_mj_agent(prompt)
        if not resp:
            return "[PrivacyShield] Local offline model 'mj-os-agent' did not return a response or Ollama is offline."
        return resp

    # Action 5: Check auto-fill guardrail permission
    if action in ("check_autofill", "verify_permission", "guardrail"):
        cmd = params.get("user_command", "")
        field = params.get("field", "password")
        allowed, reason = verify_credential_modification_allowed(cmd, field_description=field)
        return f"ALLOWED: {allowed} | {reason}"

    return f"Unknown privacy_shield action: '{action}'. Available: redact, check_sensitive, local_env, local_model, check_autofill."
