from __future__ import annotations

import json
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

_lock = threading.RLock()


def get_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR = get_base_dir()
ANALYTICS_FILE = BASE_DIR / "memory" / "analytics.json"


def _empty_analytics() -> dict[str, Any]:
    return {
        "total_commands": 0,
        "tool_counts": {},
        "recent_activity": [],
        "daily_counts": {},
        "created_at": datetime.now().strftime("%Y-%m-%d"),
    }


def load_analytics() -> dict[str, Any]:
    with _lock:
        if not ANALYTICS_FILE.exists():
            return _empty_analytics()
        try:
            data = json.loads(ANALYTICS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
            return _empty_analytics()
        except Exception:
            return _empty_analytics()


def save_analytics(data: dict[str, Any]) -> None:
    with _lock:
        ANALYTICS_FILE.parent.mkdir(parents=True, exist_ok=True)
        ANALYTICS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def log_tool_usage(tool_name: str) -> None:
    """Increment tool call counter and log recent activity."""
    if not tool_name:
        return
    clean_name = str(tool_name).strip().lower()
    today = datetime.now().strftime("%Y-%m-%d")
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with _lock:
        data = load_analytics()
        data["total_commands"] = data.get("total_commands", 0) + 1

        tool_counts = data.get("tool_counts", {})
        tool_counts[clean_name] = tool_counts.get(clean_name, 0) + 1
        data["tool_counts"] = tool_counts

        daily_counts = data.get("daily_counts", {})
        daily_counts[today] = daily_counts.get(today, 0) + 1
        data["daily_counts"] = daily_counts

        recent = data.get("recent_activity", [])
        recent.insert(0, {"tool": clean_name, "time": now_str})
        data["recent_activity"] = recent[:50]  # keep latest 50

        save_analytics(data)


def get_analytics_summary() -> dict[str, Any]:
    """Return structured stats for UI dashboards and charts."""
    with _lock:
        data = load_analytics()
        total = data.get("total_commands", 0)
        tool_counts = data.get("tool_counts", {})
        # Sort top tools
        sorted_tools = sorted(tool_counts.items(), key=lambda x: x[1], reverse=True)
        today = datetime.now().strftime("%Y-%m-%d")
        today_count = data.get("daily_counts", {}).get(today, 0)

        return {
            "total_commands": total,
            "today_commands": today_count,
            "tool_counts": tool_counts,
            "top_tools": sorted_tools[:8],
            "recent_activity": data.get("recent_activity", [])[:15],
            "daily_counts": data.get("daily_counts", {}),
        }
