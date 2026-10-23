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
    p = Path(ROUTINES_FILE)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text("[]", encoding="utf-8")


def load_routines() -> list[dict[str, Any]]:
    global _cache
    with _lock:
        if _cache is not None:
            return [r.copy() for r in _cache]
        _ensure_file()
        try:
            p = Path(ROUTINES_FILE)
            data = json.loads(p.read_text(encoding="utf-8"))
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
        p = Path(ROUTINES_FILE)
        p.write_text(json.dumps(routines, indent=2), encoding="utf-8")
        _cache = [r.copy() for r in routines]


# Predefined workspace routines (Step 1 presets)
WORKSPACE_PRESETS: dict[str, dict[str, Any]] = {
    "Start Coding Mode": {
        "name": "Start Coding Mode",
        "aliases": [
            "start coding mode",
            "coding mode",
            "code mode",
            "coding routine",
            "developer mode",
            "coding mode chalu koro",
            "start coding",
        ],
        "trigger_type": "phrase",
        "trigger_value": "start coding mode",
        "description": "Opens VS Code, initializes dev workspace, plays background Lo-Fi coding beats, and sets volume for focus.",
        "steps": [
            {"tool": "open_app", "args": {"app_name": "vscode"}, "description": "Open VS Code IDE"},
            {"tool": "code_helper", "args": {"action": "explain", "text": "Starting coding session workspace"}, "description": "Initialize dev environment"},
            {"tool": "youtube_video", "args": {"action": "play", "query": "lofi hip hop radio coding beats"}, "description": "Play background coding music"},
            {"tool": "computer_settings", "args": {"action": "volume_set", "value": "25"}, "description": "Set comfortable background volume"},
        ],
        "enabled": True,
        "is_preset": True,
        "success_count": 0,
    },
    "Start Gaming Mode": {
        "name": "Start Gaming Mode",
        "aliases": [
            "start gaming mode",
            "gaming mode",
            "game mode",
            "play game",
            "gaming routine",
            "gaming mode on koro",
            "start gaming",
        ],
        "trigger_type": "phrase",
        "trigger_value": "start gaming mode",
        "description": "Opens Discord, minimizes distractions by closing browser, and optimizes audio for immersive gaming.",
        "steps": [
            {"tool": "open_app", "args": {"app_name": "discord"}, "description": "Launch Discord voice client"},
            {"tool": "close_app", "args": {"app_name": "chrome"}, "description": "Close browser to free RAM & reduce distraction"},
            {"tool": "computer_settings", "args": {"action": "volume_set", "value": "70"}, "description": "Set audio to immersive gaming volume"},
        ],
        "enabled": True,
        "is_preset": True,
        "success_count": 0,
    },
    "Prepare Project Setup": {
        "name": "Prepare Project Setup",
        "aliases": [
            "prepare project setup",
            "project setup",
            "setup project",
            "start project",
            "setup workspace",
            "project setup koro",
            "prepare project",
        ],
        "trigger_type": "phrase",
        "trigger_value": "prepare project setup",
        "description": "Inspects project files, launches VS Code workspace, and opens browser dev tab.",
        "steps": [
            {"tool": "file_controller", "args": {"action": "list", "path": "."}, "description": "Inspect project workspace files"},
            {"tool": "open_app", "args": {"app_name": "vscode"}, "description": "Open project workspace in VS Code"},
            {"tool": "browser_control", "args": {"action": "open_tab", "url": "http://localhost:3000"}, "description": "Open development browser tab"},
        ],
        "enabled": True,
        "is_preset": True,
        "success_count": 0,
    },
}


def _normalize_name(name: str) -> str:
    """Normalize a name for robust matching (removes symbols, lowers, collapses spaces)."""
    import re
    cleaned = re.sub(r"[^a-zA-Z0-9\s]", " ", (name or "").lower())
    return " ".join(cleaned.split())


def get_workspace_presets() -> dict[str, dict[str, Any]]:
    """Return all built-in workspace routine presets."""
    return {k: v.copy() for k, v in WORKSPACE_PRESETS.items()}


def save_routine(routine: dict[str, Any]) -> dict[str, Any]:
    """Insert or update a routine by name."""
    name = (routine.get("name") or "").strip()
    if not name:
        raise ValueError("Routine name cannot be empty.")

    raw_aliases = routine.get("aliases") or []
    if isinstance(raw_aliases, list):
        aliases = [str(a).strip().lower() for a in raw_aliases if str(a).strip()]
    else:
        aliases = []
    if name.lower() not in aliases:
        aliases.append(name.lower())

    normalized_routine = {
        "name": name,
        "trigger_type": str(routine.get("trigger_type", "phrase")).strip().lower(),
        "trigger_value": str(routine.get("trigger_value", name.lower())).strip(),
        "aliases": aliases,
        "description": str(routine.get("description", "")).strip(),
        "steps": routine.get("steps", []) if isinstance(routine.get("steps"), list) else [],
        "enabled": bool(routine.get("enabled", True)),
        "success_count": int(routine.get("success_count", 0)),
        "last_run": routine.get("last_run", None),
        "is_preset": bool(routine.get("is_preset", False)),
    }

    with _lock:
        routines = load_routines()
        updated = False
        target_norm = _normalize_name(name)
        for idx, r in enumerate(routines):
            if _normalize_name(str(r.get("name", ""))) == target_norm:
                # Retain success count if already present
                if normalized_routine["success_count"] == 0 and r.get("success_count"):
                    normalized_routine["success_count"] = r["success_count"]
                routines[idx] = normalized_routine
                updated = True
                break

        if not updated:
            routines.append(normalized_routine)

        save_routines(routines)
        return normalized_routine.copy()


def save_skill_macro(
    name: str,
    steps: list[dict[str, Any]],
    description: str = "",
    aliases: list[str] | None = None,
    sync_conversational_memory: bool = True,
) -> dict[str, Any]:
    """
    Step 2: Save successful multi-step action sequences into local JSON storage AND
    Conversational Memory as a reusable skill.
    """
    clean_name = (name or "").strip()
    if not clean_name:
        raise ValueError("Routine/Skill name cannot be empty.")
    if not isinstance(steps, list) or not steps:
        raise ValueError("Steps must be a non-empty list of action dicts.")

    alias_list = aliases or [
        clean_name.lower(),
        clean_name.lower().replace(" ", "_"),
        f"start {clean_name.lower()}",
    ]

    saved = save_routine({
        "name": clean_name,
        "trigger_type": "phrase",
        "trigger_value": clean_name.lower(),
        "aliases": alias_list,
        "description": description or f"Multi-step skill macro with {len(steps)} action(s).",
        "steps": steps,
        "enabled": True,
        "success_count": 1,
        "last_run": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "is_preset": False,
    })

    if sync_conversational_memory:
        try:
            from memory.memory_manager import update_memory
            import re
            slug = re.sub(r"[^a-zA-Z0-9_]", "_", clean_name.lower()).strip("_")
            tools_summary = ", ".join(s.get("tool", "action") for s in steps[:4])
            pref_val = f"Routine '{clean_name}': {len(steps)} steps ({tools_summary})"
            update_memory({"preferences": {f"macro_{slug}": {"value": pref_val}}})
        except Exception as e:
            print(f"[RoutineManager] ⚠️ Could not sync to conversational memory: {e}")

    return saved


def delete_routine(name: str) -> bool:
    """Delete a routine by name (case-insensitive)."""
    target = _normalize_name(name)
    if not target:
        return False

    with _lock:
        routines = load_routines()
        initial_len = len(routines)
        filtered = [
            r for r in routines if _normalize_name(str(r.get("name", ""))) != target
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
    target = _normalize_name(name)
    for r in load_routines():
        if _normalize_name(str(r.get("name", ""))) == target:
            return r.copy()
    return None


def find_routine_or_preset(query: str) -> dict[str, Any] | None:
    """
    Step 3: Fast lookup for saved macros and built-in workspace presets
    by name, trigger phrase, or alias without planning from scratch.
    """
    clean_q = (query or "").strip().lower()
    norm_q = _normalize_name(clean_q)
    if not norm_q:
        return None

    # 1. Search user saved routines first (User preferences take priority)
    for r in load_routines():
        r_name_norm = _normalize_name(str(r.get("name", "")))
        r_trigger_norm = _normalize_name(str(r.get("trigger_value", "")))
        if norm_q in (r_name_norm, r_trigger_norm):
            return r.copy()

        # Check aliases
        for a in r.get("aliases", []):
            if norm_q == _normalize_name(str(a)):
                return r.copy()

        # Substring / keyword match if query specifically mentions the name
        if r_name_norm in norm_q or norm_q in r_name_norm:
            return r.copy()

    # 2. Search built-in workspace presets
    for p_name, preset in WORKSPACE_PRESETS.items():
        p_name_norm = _normalize_name(p_name)
        p_trigger_norm = _normalize_name(str(preset.get("trigger_value", "")))
        if norm_q in (p_name_norm, p_trigger_norm):
            return preset.copy()

        for a in preset.get("aliases", []):
            if norm_q == _normalize_name(str(a)):
                return preset.copy()

        if p_name_norm in norm_q or norm_q in p_name_norm:
            return preset.copy()

    return None


def update_routine_last_run(name: str, last_run: str | None = None) -> bool:
    """Update the last_run timestamp/date for a routine."""
    target = _normalize_name(name)
    if last_run is None:
        last_run = datetime.now().strftime("%Y-%m-%d %H:%M")

    with _lock:
        routines = load_routines()
        found = False
        for r in routines:
            if _normalize_name(str(r.get("name", ""))) == target:
                r["last_run"] = last_run
                found = True
                break
        if found:
            save_routines(routines)
            return True
        return False


def record_routine_execution(name: str, success: bool = True) -> bool:
    """Record execution completion, timestamp, and success counter for a routine."""
    target = _normalize_name(name)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")

    with _lock:
        routines = load_routines()
        found = False
        for r in routines:
            if _normalize_name(str(r.get("name", ""))) == target:
                r["last_run"] = timestamp
                if success:
                    r["success_count"] = int(r.get("success_count", 0)) + 1
                found = True
                break

        # If it was a preset running for the first time, persist it into user routines
        if not found:
            preset = find_routine_or_preset(name)
            if preset:
                preset_copy = preset.copy()
                preset_copy["last_run"] = timestamp
                preset_copy["success_count"] = 1 if success else 0
                preset_copy["is_preset"] = True
                routines.append(preset_copy)
                found = True

        if found:
            save_routines(routines)
            return True
        return False

