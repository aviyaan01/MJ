import json
import os
import platform
import re
import sys
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

_config_lock = threading.Lock()


class PlatformStr(str):
    """
    Case-tolerant OS platform string that simultaneously matches:
    - 'windows', 'Windows', 'win32'
    - 'mac', 'Darwin', 'darwin', 'macos', 'osx'
    - 'linux', 'Linux'
    """
    @property
    def is_windows(self) -> bool:
        return self.lower() in ("windows", "win32")

    @property
    def is_mac(self) -> bool:
        return self.lower() in ("darwin", "mac", "macos", "osx")

    @property
    def is_linux(self) -> bool:
        return self.lower() in ("linux",)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            o = other.lower()
            s = self.lower()
            if o in ("mac", "darwin", "macos", "osx") and s in ("darwin", "mac", "macos", "osx"):
                return True
            if o in ("windows", "win32") and s in ("windows", "win32"):
                return True
            if o in ("linux",) and s in ("linux",):
                return True
            return super().__eq__(other) or s == o
        return super().__eq__(other)


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


def _load_env_file() -> dict[str, str]:
    """Parse key=value pairs from .env file without external dependencies."""
    env_path = get_base_dir() / ".env"
    if not env_path.exists():
        return {}
    res = {}
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            res[k] = v
            # Set in os.environ if not already defined
            if k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass
    return res


@lru_cache(maxsize=1)
def get_os() -> PlatformStr:
    """Returns a PlatformStr that matches 'windows'/'Windows', 'mac'/'Darwin', 'linux'/'Linux'."""
    raw = platform.system()
    norm = "mac" if raw == "Darwin" else raw.lower()
    return PlatformStr(norm)


def is_windows() -> bool:
    return get_os().is_windows


def is_mac() -> bool:
    return get_os().is_mac


def is_linux() -> bool:
    return get_os().is_linux


@lru_cache(maxsize=1)
def load_config() -> dict:
    """
    Load combined configuration from os.environ, .env, and config/api_keys.json.
    Precedence order: os.environ > .env > config/api_keys.json
    """
    data = {}
    # 1. Base from config/api_keys.json if present
    config_path = get_base_dir() / "config" / "api_keys.json"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                raw_json = json.load(f)
                for k, v in raw_json.items():
                    data[k] = v
                    data[k.lower()] = v
        except Exception:
            pass

    # 2. Overlay from .env
    env_vars = _load_env_file()
    for k, v in env_vars.items():
        data[k] = v
        data[k.lower()] = v

    # 3. Overlay from active os.environ for known keys
    for k, v in os.environ.items():
        if k.isupper() or k.lower() in data:
            data[k] = v
            data[k.lower()] = v

    return data


def get_api_key(service_name: str) -> str:
    """Retrieve API key or config string by service name (case-insensitive)."""
    key_upper = service_name.upper()
    key_lower = service_name.lower()

    # 1. Environment variable (highest precedence)
    if key_upper in os.environ and os.environ[key_upper].strip():
        return os.environ[key_upper].strip()
    if key_lower in os.environ and os.environ[key_lower].strip():
        return os.environ[key_lower].strip()

    # 2. Config / .env cache
    config = load_config()
    val = config.get(service_name) or config.get(key_lower) or config.get(key_upper)
    return str(val or "").strip()


def update_env_file(key: str, value: str) -> None:
    """Update or append an environment variable in the root .env file safely."""
    env_path = get_base_dir() / ".env"
    val_str = str(value).strip()
    k_upper = key.strip().upper()

    os.environ[k_upper] = val_str

    if not env_path.exists():
        example_path = get_base_dir() / ".env.example"
        if example_path.exists():
            try:
                env_path.write_text(example_path.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception:
                env_path.write_text("", encoding="utf-8")
        else:
            env_path.write_text("", encoding="utf-8")

    try:
        content = env_path.read_text(encoding="utf-8")
        pattern = rf"^{re.escape(k_upper)}=.*$"
        if re.search(pattern, content, flags=re.MULTILINE):
            new_content = re.sub(pattern, f"{k_upper}={val_str}", content, flags=re.MULTILINE)
        else:
            sep = "\n" if content and not content.endswith("\n") else ""
            new_content = f"{content}{sep}{k_upper}={val_str}\n"

        env_path.write_text(new_content, encoding="utf-8")
    except Exception as e:
        print(f"[env] ⚠️ Failed to update .env: {e}")


def save_config_key(key: str, value: Any) -> None:
    """Persist key into both config/api_keys.json and .env."""
    with _config_lock:
        config_path = get_base_dir() / "config" / "api_keys.json"
        config = {}
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            except Exception:
                config = {}

        config[key] = value
        config_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=4)
        except Exception:
            pass

        # Also sync to .env if key is string or primitive
        if isinstance(value, (str, int, float, bool)):
            update_env_file(key, str(value))

        load_config.cache_clear()
