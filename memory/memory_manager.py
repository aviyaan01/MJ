import json
import sys
from datetime import datetime
from pathlib import Path
from threading import RLock


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR         = get_base_dir()
MEMORY_PATH      = BASE_DIR / "memory" / "long_term.json"
_lock            = RLock()
MAX_VALUE_LENGTH = 380
MEMORY_MAX_CHARS = 2200

def _empty_memory() -> dict:
    return {
        "identity":      {},
        "preferences":   {},
        "projects":      {},
        "relationships": {},
        "wishes":        {},
        "notes":         {},
    }

def load_memory() -> dict:
    if not MEMORY_PATH.exists():
        return _empty_memory()
    with _lock:
        try:
            data = json.loads(MEMORY_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                base = _empty_memory()
                for key in base:
                    if key not in data:
                        data[key] = {}
                return data
            return _empty_memory()
        except Exception as e:
            print(f"[Memory] ⚠️ Load error: {e}")
            return _empty_memory()

def _all_entries(memory: dict) -> list[tuple]:
    entries = []
    for cat, items in memory.items():
        if not isinstance(items, dict):
            continue
        for key, entry in items.items():
            if isinstance(entry, dict) and "value" in entry:
                entries.append((cat, key, entry))
    return entries


def _trim_to_limit(memory: dict) -> dict:
    current_len = len(json.dumps(memory, ensure_ascii=False))
    if current_len <= MEMORY_MAX_CHARS:
        return memory
    entries = _all_entries(memory)
    entries.sort(key=lambda t: t[2].get("updated", "0000-00-00"))
    for cat, key, entry in entries:
        if current_len <= MEMORY_MAX_CHARS:
            break
        del memory[cat][key]
        print(f"[Memory] Trimmed {cat}/{key}")
        current_len -= len(json.dumps(key, ensure_ascii=False)) + len(json.dumps(entry, ensure_ascii=False)) + 4
    return memory

def save_memory(memory: dict) -> None:
    if not isinstance(memory, dict):
        return
    memory = _trim_to_limit(memory)
    MEMORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        MEMORY_PATH.write_text(
            json.dumps(memory, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def _truncate_value(val: str) -> str:
    if isinstance(val, str) and len(val) > MAX_VALUE_LENGTH:
        return val[:MAX_VALUE_LENGTH].rstrip() + "..."
    return val


def _recursive_update(target: dict, updates: dict) -> bool:
    changed = False
    for key, value in updates.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, dict) and "value" not in value:
            if key not in target or not isinstance(target[key], dict):
                target[key] = {}
                changed = True
            if _recursive_update(target[key], value):
                changed = True
        else:
            new_val  = _truncate_value(str(value["value"] if isinstance(value, dict) else value))
            entry    = {"value": new_val, "updated": datetime.now().strftime("%Y-%m-%d")}
            existing = target.get(key, {})
            if not isinstance(existing, dict) or existing.get("value") != new_val:
                target[key] = entry
                changed = True
    return changed


def update_memory(memory_update: dict) -> dict:
    if not isinstance(memory_update, dict) or not memory_update:
        return load_memory()
    with _lock:
        memory = load_memory()
        if _recursive_update(memory, memory_update):
            save_memory(memory)
            print(f"[Memory] Saved: {list(memory_update.keys())}")
        return memory

def format_memory_for_prompt(memory: dict | None) -> str:
    if not memory:
        return ""

    lines = []

    identity  = memory.get("identity", {})
    id_fields = ["name", "age", "birthday", "city", "job", "language", "school", "nationality"]
    for field in id_fields:
        entry = identity.get(field)
        if entry:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"{field.title()}: {val}")
    for key, entry in identity.items():
        if key in id_fields:
            continue
        val = entry.get("value") if isinstance(entry, dict) else entry
        if val:
            lines.append(f"{key.replace('_', ' ').title()}: {val}")

    prefs = memory.get("preferences", {})
    if prefs:
        lines.append("")
        lines.append("Preferences:")
        for key, entry in list(prefs.items())[:15]:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"  - {key.replace('_', ' ').title()}: {val}")

    projects = memory.get("projects", {})
    if projects:
        lines.append("")
        lines.append("Active Projects / Goals:")
        for key, entry in list(projects.items())[:8]:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"  - {key.replace('_', ' ').title()}: {val}")

    rels = memory.get("relationships", {})
    if rels:
        lines.append("")
        lines.append("People in their life:")
        for key, entry in list(rels.items())[:10]:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"  - {key.replace('_', ' ').title()}: {val}")

    wishes = memory.get("wishes", {})
    if wishes:
        lines.append("")
        lines.append("Wishes / Plans / Wants:")
        for key, entry in list(wishes.items())[:8]:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"  - {key.replace('_', ' ').title()}: {val}")

    notes = memory.get("notes", {})
    if notes:
        lines.append("")
        lines.append("Other notes:")
        for key, entry in list(notes.items())[:8]:
            val = entry.get("value") if isinstance(entry, dict) else entry
            if val:
                lines.append(f"  - {key}: {val}")

    if not lines:
        return ""

    header = "[WHAT YOU KNOW ABOUT THIS PERSON — use naturally, never recite like a list]\n"
    result = header + "\n".join(lines)
    if len(result) > 2000:
        result = result[:1997] + "…"

    return result + "\n"

def remember(key: str, value: str, category: str = "notes") -> str:
    valid = {"identity", "preferences", "projects", "relationships", "wishes", "notes"}
    if category not in valid:
        category = "notes"
    update_memory({category: {key: {"value": value}}})
    return f"Remembered: {category}/{key} = {value}"


def forget(key: str, category: str = "notes") -> str:
    memory = load_memory()
    cat    = memory.get(category, {})
    if key in cat:
        del cat[key]
        memory[category] = cat
        save_memory(memory)
        return f"Forgotten: {category}/{key}"
    return f"Not found: {category}/{key}"


forget_memory = forget


def get_notes() -> list[dict]:
    """Return all notes and task items from memory."""
    memory = load_memory()
    notes_dict = memory.get("notes", {})
    results = []
    for k, v in notes_dict.items():
        val = v.get("value", "") if isinstance(v, dict) else str(v)
        updated = v.get("updated", "") if isinstance(v, dict) else ""
        results.append({"id": k, "text": val, "updated": updated})
    return results


def add_note(text: str, key: str | None = None) -> dict:
    """Add a new note/task to memory."""
    clean_text = text.strip()
    if not clean_text:
        return {}
    if not key:
        import uuid
        key = f"note_{str(uuid.uuid4())[:8]}"
    update_memory({"notes": {key: {"value": clean_text}}})
    return {"id": key, "text": clean_text, "updated": datetime.now().strftime("%Y-%m-%d")}


def delete_note(note_id: str | dict) -> bool:
    """Delete a note/task by its key ID or note dict."""
    if isinstance(note_id, dict):
        note_id = note_id.get("id", "")
    if not note_id or not isinstance(note_id, str):
        return False
    res = forget(note_id, category="notes")
    return "Forgotten:" in res


CONVERSATION_HISTORY_PATH = BASE_DIR / "memory" / "conversation_history.jsonl"


def record_conversation_turn(user_text: str, assistant_text: str) -> None:
    """Persist conversation dialogue turn so MJ remembers ongoing spoken interactions."""
    u = (user_text or "").strip()
    a = (assistant_text or "").strip()
    if not u and not a:
        return
    CONVERSATION_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "timestamp": datetime.now().isoformat(),
        "user": u,
        "assistant": a,
    }
    with _lock:
        try:
            with open(CONVERSATION_HISTORY_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as e:
            print(f"[Memory] ⚠️ Could not log conversation turn: {e}")


def get_recent_conversations(max_turns: int = 6) -> list[dict]:
    """Retrieve the most recent conversation exchanges from persistent memory."""
    if not CONVERSATION_HISTORY_PATH.exists():
        return []
    turns = []
    with _lock:
        try:
            lines = CONVERSATION_HISTORY_PATH.read_text(encoding="utf-8").strip().splitlines()
            for line in lines[-max_turns:]:
                if line.strip():
                    try:
                        turns.append(json.loads(line))
                    except Exception:
                        pass
        except Exception as e:
            print(f"[Memory] ⚠️ Could not read conversation history: {e}")
    return turns


def format_conversation_for_prompt(max_turns: int = 6) -> str:
    """Format recent turns for LLM prompt context injection."""
    turns = get_recent_conversations(max_turns=max_turns)
    if not turns:
        return ""
    lines = [
        "[RECENT SPOKEN CONVERSATIONS — Context of what was recently discussed with the user]",
        "Use this context to recall previous topics, instructions, or questions seamlessly."
    ]
    for t in turns:
        u = t.get("user", "")
        a = t.get("assistant", "")
        if u:
            lines.append(f"User: {u}")
        if a:
            lines.append(f"MJ: {a}")
    return "\n".join(lines) + "\n\n"


def clear_conversation_history() -> str:
    """Clear conversation history log."""
    with _lock:
        try:
            if CONVERSATION_HISTORY_PATH.exists():
                CONVERSATION_HISTORY_PATH.unlink()
            return "Conversation history cleared."
        except Exception as e:
            return f"Error clearing conversation history: {e}"