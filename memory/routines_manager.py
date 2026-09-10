from __future__ import annotations

import json
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

_lock = threading.RLock()
_cache: list[dict[str, Any]] | None = None


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR = get_base_dir()
ROUTINES_FILE = BASE_DIR / "memory" / "routines.json"


def _ensure_file() -> None:
    ROUTINES_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not ROUTINES_FILE.exists():
        ROUTINES_FILE.write_text("[]", encoding="utf-8")


def load_routines() -> list[dict[str, Any]]:
    global _cache
    with _lock:
        if _cache is not None:
            return [r.copy() for r in _cache]
        _ensure_file()
        try:
            data = json.loads(ROUTINES_FILE.read_text(encoding="utf-8"))
            _cache = data if isinstance(data, list) else []
            return [r.copy() for r in _cache]
        except Exception as e:
            print(f"❌ Failed to load routines.json: {e}")
            _cache = []
            return []


def save_routines(routines: list[dict[str, Any]]) -> None:
    global _cache
    with _lock:
        _ensure_file()
        ROUTINES_FILE.write_text(json.dumps(routines, indent=2), encoding="utf-8")
        _cache = [r.copy() for r in routines]


def save_routine(routine: dict[str, Any]) -> dict[str, Any]:
    """Insert or update a routine by name."""
    name = (routine.get("name") or "").strip()
    if not name:
        raise ValueError("Routine name cannot be empty.")

    normalized_routine = {
        "name": name,
        "trigger_type": str(routine.get("trigger_type", "phrase")).strip().lower(),
        "trigger_value": str(routine.get("trigger_value", "")).strip(),
        "steps": routine.get("steps", []) if isinstance(routine.get("steps"), list) else [],
        "enabled": bool(routine.get("enabled", True)),
        "last_run": routine.get("last_run", None),
    }

    with _lock:
        routines = load_routines()
        updated = False
        target_name_lower = name.lower()
        for idx, r in enumerate(routines):
            if str(r.get("name", "")).strip().lower() == target_name_lower:
                routines[idx] = normalized_routine
                updated = True
                break

        if not updated:
            routines.append(normalized_routine)

        save_routines(routines)
        return normalized_routine.copy()


def delete_routine(name: str) -> bool:
    """Delete a routine by name (case-insensitive)."""
    target = name.strip().lower()
    if not target:
        return False

    with _lock:
        routines = load_routines()
        initial_len = len(routines)
        filtered = [
            r for r in routines if str(r.get("name", "")).strip().lower() != target
        ]
        if len(filtered) < initial_len:
            save_routines(filtered)
            return True
        return False


def list_routines() -> list[dict[str, Any]]:
    """Return all saved routines."""
    return load_routines()


def get_routine(name: str) -> dict[str, Any] | None:
    """Find a routine by name (case-insensitive)."""
    target = name.strip().lower()
    for r in load_routines():
        if str(r.get("name", "")).strip().lower() == target:
            return r.copy()
    return None


def update_routine_last_run(name: str, last_run: str | None = None) -> bool:
    """Update the last_run timestamp/date for a routine."""
    target = name.strip().lower()
    if last_run is None:
        last_run = datetime.now().strftime("%Y-%m-%d %H:%M")

    with _lock:
        routines = load_routines()
        found = False
        for r in routines:
            if str(r.get("name", "")).strip().lower() == target:
                r["last_run"] = last_run
                found = True
                break
        if found:
            save_routines(routines)
            return True
        return False
