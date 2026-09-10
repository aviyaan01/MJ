import json
import sys
import threading
from pathlib import Path

_lock = threading.RLock()
_cache = None

def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent

BASE_DIR    = get_base_dir()
CONFIG_DIR  = BASE_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "api_keys.json"

def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

def config_exists() -> bool:
    env_file = BASE_DIR / ".env"
    return CONFIG_FILE.exists() or env_file.exists()

def load_api_keys() -> dict:
    """Load combined configuration with .env and os.environ precedence."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache.copy()

        data = {}
        # 1. Base from config/api_keys.json if present
        if CONFIG_FILE.exists():
            try:
                data.update(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
            except Exception as e:
                print(f"⚠️ Failed to load api_keys.json: {e}")

        # 2. Overlay from utils.env (which parses .env and os.environ)
        try:
            from utils.env import load_config as env_load_config
            env_cfg = env_load_config()
            for k, v in env_cfg.items():
                data[k] = v
                data[k.lower()] = v
        except Exception:
            pass

        _cache = data.copy()
        return _cache.copy()

def clear_cache() -> None:
    global _cache
    with _lock:
        _cache = None
        try:
            from utils.env import load_config as env_load_config
            env_load_config.cache_clear()
        except Exception:
            pass

def save_api_keys(gemini_api_key: str) -> None:
    global _cache
    with _lock:
        ensure_config_dir()
        data = load_api_keys()
        clean_key = gemini_api_key.strip()
        data["gemini_api_key"] = clean_key
        CONFIG_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        _cache = data.copy()
        try:
            from utils.env import update_env_file
            update_env_file("GEMINI_API_KEY", clean_key)
        except Exception:
            pass
        clear_cache()

def get_gemini_key() -> str | None:
    try:
        from utils.env import get_api_key
        key = get_api_key("gemini_api_key")
        if key:
            return key
    except Exception:
        pass
    return load_api_keys().get("gemini_api_key")

def is_configured() -> bool:
    key = get_gemini_key()
    return bool(key and len(key) > 15 and key != "YOUR_GEMINI_API_KEY_HERE")


def get_assistant_name() -> str:
    """Return the configured assistant name, or 'MJ' if not set."""
    try:
        from utils.env import get_api_key
        name = get_api_key("assistant_name")
        if name:
            return name
    except Exception:
        pass
    return load_api_keys().get("assistant_name", "MJ") or "MJ"


def get_user_name() -> str:
    """Return the configured user name for addressing."""
    try:
        from utils.env import get_api_key
        uname = get_api_key("user_name")
        if uname:
            return uname
    except Exception:
        pass
    return load_api_keys().get("user_name", "")


def save_assistant_config(assistant_name: str, user_name: str) -> None:
    """Persist assistant name and user name to config and .env."""
    global _cache
    with _lock:
        ensure_config_dir()
        data = load_api_keys()
        a_name = assistant_name.strip() or "MJ"
        u_name = user_name.strip()
        data["assistant_name"] = a_name
        data["user_name"] = u_name
        CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")
        _cache = data.copy()
        try:
            from utils.env import update_env_file
            update_env_file("ASSISTANT_NAME", a_name)
            update_env_file("USER_NAME", u_name)
        except Exception:
            pass
        clear_cache()


def get_brief_enabled() -> bool:
    val = load_api_keys().get("morning_brief_enabled", True)
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return bool(val)


def get_followup_listen_seconds() -> float:
    """Seconds to keep the mic open after each assistant reply (default 7)."""
    try:
        raw = load_api_keys().get("followup_listen_seconds", 7.0)
        return max(1.0, min(float(raw), 60.0))
    except Exception:
        return 7.0


def get_barge_in_threshold() -> float:
    """RMS amplitude threshold for mic barge-in over TTS playback (default 1400)."""
    try:
        raw = load_api_keys().get("barge_in_rms_threshold", 1400.0)
        return max(500.0, min(float(raw), 8000.0))
    except Exception:
        return 1400.0


def save_brief_enabled(enabled: bool) -> None:
    global _cache
    with _lock:
        ensure_config_dir()
        data = load_api_keys()
        data["morning_brief_enabled"] = enabled
        CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")
        _cache = data.copy()
        try:
            from utils.env import update_env_file
            update_env_file("MORNING_BRIEF_ENABLED", str(enabled).lower())
        except Exception:
            pass
        clear_cache()


def load_config() -> dict:
    """Convenience alias for loading the full configuration dictionary."""
    return load_api_keys()


def save_config(updates: dict) -> None:
    """Convenience helper to merge and persist arbitrary configuration updates."""
    global _cache
    with _lock:
        ensure_config_dir()
        data = load_api_keys()
        data.update(updates)
        CONFIG_FILE.write_text(json.dumps(data, indent=4), encoding="utf-8")
        _cache = data.copy()
        try:
            from utils.env import update_env_file
            for k, v in updates.items():
                if isinstance(v, (str, int, float, bool)):
                    update_env_file(k.upper(), str(v))
        except Exception:
            pass
        clear_cache()