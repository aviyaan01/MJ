# actions/smart_home.py
"""Smart Home IoT controller for MJ — Home Assistant, IFTTT, and Tuya webhook support."""
import json
import os
from pathlib import Path
from typing import Any

from utils.env import get_api_key, get_base_dir

# ── Device mapping config ────────────────────────────────────────────────────
_DEVICE_MAP_FILE = get_base_dir() / "config" / "smart_home_devices.json"

# Default device map (created on first run if missing)
_DEFAULT_DEVICE_MAP = {
    "_comment": "Map natural-language device names to entity IDs. Edit this file to add your devices.",
    "devices": {
        "bedroom light": {"entity_id": "light.bedroom", "type": "light", "platform": "home_assistant"},
        "living room light": {"entity_id": "light.living_room", "type": "light", "platform": "home_assistant"},
        "desk lamp": {"entity_id": "light.desk_lamp", "type": "light", "platform": "home_assistant"},
        "ac": {"entity_id": "climate.bedroom_ac", "type": "climate", "platform": "home_assistant"},
        "bedroom ac": {"entity_id": "climate.bedroom_ac", "type": "climate", "platform": "home_assistant"},
        "fan": {"entity_id": "fan.bedroom", "type": "fan", "platform": "home_assistant"},
        "smart plug": {"entity_id": "switch.smart_plug_1", "type": "switch", "platform": "home_assistant"},
        "tv": {"entity_id": "media_player.living_room_tv", "type": "media_player", "platform": "home_assistant"},
    }
}

_SETUP_MSG = (
    "Smart Home is not configured yet.\n\n"
    "To set it up:\n"
    "1. Add these keys to your .env file:\n"
    "   HOME_ASSISTANT_URL=http://your-ha-ip:8123\n"
    "   HOME_ASSISTANT_TOKEN=your_long_lived_access_token\n"
    "   (Optional) IFTTT_WEBHOOK_KEY=your_ifttt_key\n"
    "   (Optional) TUYA_BASE_URL=https://openapi.tuyaus.com\n"
    "   (Optional) TUYA_ACCESS_TOKEN=your_tuya_token\n"
    "2. Edit the device map at:\n"
    f"   {_DEVICE_MAP_FILE}\n"
    "   to match your actual device entity IDs.\n"
    "3. Say 'turn on the bedroom light' to test!"
)


def _load_device_map() -> dict:
    """Load device name -> entity mapping from config file."""
    if not _DEVICE_MAP_FILE.exists():
        # Create default template
        _DEVICE_MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
        _DEVICE_MAP_FILE.write_text(
            json.dumps(_DEFAULT_DEVICE_MAP, indent=4, ensure_ascii=False),
            encoding="utf-8",
        )
        return _DEFAULT_DEVICE_MAP.get("devices", {})

    try:
        data = json.loads(_DEVICE_MAP_FILE.read_text(encoding="utf-8"))
        return data.get("devices", data)
    except Exception:
        return {}


def _resolve_device(name: str) -> dict | None:
    """Fuzzy-match a natural language device name to a configured device entry."""
    devices = _load_device_map()
    name_lower = name.lower().strip()

    # Exact match
    if name_lower in devices:
        return devices[name_lower]

    # Partial / substring match
    for key, val in devices.items():
        if name_lower in key or key in name_lower:
            return val

    # Word overlap scoring
    name_words = set(name_lower.split())
    best_match = None
    best_score = 0
    for key, val in devices.items():
        key_words = set(key.lower().split())
        overlap = len(name_words & key_words)
        if overlap > best_score:
            best_score = overlap
            best_match = val

    return best_match if best_score > 0 else None


# ── Home Assistant API ───────────────────────────────────────────────────────

def _ha_call_service(entity_id: str, service: str, domain: str = None) -> str:
    """Call a Home Assistant service via REST API."""
    try:
        import requests
    except ImportError:
        return "Missing 'requests' library. Install with: pip install requests"

    base_url = get_api_key("HOME_ASSISTANT_URL") or os.environ.get("HOME_ASSISTANT_URL", "")
    token = get_api_key("HOME_ASSISTANT_TOKEN") or os.environ.get("HOME_ASSISTANT_TOKEN", "")

    if not base_url or not token:
        return _SETUP_MSG

    base_url = base_url.rstrip("/")
    if not domain:
        domain = entity_id.split(".")[0] if "." in entity_id else "switch"

    url = f"{base_url}/api/services/{domain}/{service}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {"entity_id": entity_id}

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
        if resp.status_code in (200, 201):
            return f"OK: {domain}/{service} executed on {entity_id}."
        else:
            return f"Home Assistant error ({resp.status_code}): {resp.text[:200]}"
    except requests.ConnectionError:
        return f"Cannot connect to Home Assistant at {base_url}. Is it running?"
    except requests.Timeout:
        return f"Home Assistant request timed out ({base_url})."
    except Exception as e:
        return f"Home Assistant request failed: {e}"


def _ha_get_state(entity_id: str) -> str:
    """Get entity state from Home Assistant."""
    try:
        import requests
    except ImportError:
        return "Missing 'requests' library. Install with: pip install requests"

    base_url = get_api_key("HOME_ASSISTANT_URL") or os.environ.get("HOME_ASSISTANT_URL", "")
    token = get_api_key("HOME_ASSISTANT_TOKEN") or os.environ.get("HOME_ASSISTANT_TOKEN", "")

    if not base_url or not token:
        return _SETUP_MSG

    base_url = base_url.rstrip("/")
    url = f"{base_url}/api/states/{entity_id}"
    headers = {"Authorization": f"Bearer {token}"}

    try:
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            state = data.get("state", "unknown")
            friendly = data.get("attributes", {}).get("friendly_name", entity_id)
            attrs = data.get("attributes", {})

            info_parts = [f"{friendly}: {state}"]
            if "brightness" in attrs:
                pct = round(attrs["brightness"] / 255 * 100)
                info_parts.append(f"Brightness: {pct}%")
            if "temperature" in attrs:
                info_parts.append(f"Temperature: {attrs['temperature']}°C")
            if "current_temperature" in attrs:
                info_parts.append(f"Current: {attrs['current_temperature']}°C")

            return " | ".join(info_parts)
        elif resp.status_code == 404:
            return f"Entity '{entity_id}' not found in Home Assistant."
        else:
            return f"Home Assistant error ({resp.status_code}): {resp.text[:200]}"
    except Exception as e:
        return f"Failed to get device state: {e}"


# ── IFTTT Webhook ────────────────────────────────────────────────────────────

def _ifttt_trigger(event_name: str, value1: str = "", value2: str = "", value3: str = "") -> str:
    """Trigger an IFTTT webhook event."""
    try:
        import requests
    except ImportError:
        return "Missing 'requests' library."

    key = get_api_key("IFTTT_WEBHOOK_KEY") or os.environ.get("IFTTT_WEBHOOK_KEY", "")
    if not key:
        return "IFTTT webhook key not configured. Add IFTTT_WEBHOOK_KEY to your .env file."

    url = f"https://maker.ifttt.com/trigger/{event_name}/with/key/{key}"
    payload = {}
    if value1:
        payload["value1"] = value1
    if value2:
        payload["value2"] = value2
    if value3:
        payload["value3"] = value3

    try:
        resp = requests.post(url, json=payload, timeout=10)
        if resp.status_code == 200:
            return f"IFTTT event '{event_name}' triggered successfully."
        else:
            return f"IFTTT error ({resp.status_code}): {resp.text[:200]}"
    except Exception as e:
        return f"IFTTT request failed: {e}"


# ── Actions ──────────────────────────────────────────────────────────────────

def _toggle_device(params: dict) -> str:
    """Toggle a smart home device on or off."""
    device_name = params.get("device") or params.get("device_name") or params.get("name", "")
    state = str(params.get("state", "toggle")).lower().strip()

    if not device_name:
        return "Please specify which device to control (e.g., 'bedroom light', 'AC', 'fan')."

    device = _resolve_device(device_name)
    if not device:
        available = ", ".join(_load_device_map().keys())
        return (
            f"Device '{device_name}' not found in the smart home config.\n"
            f"Available devices: {available or 'none configured'}.\n"
            f"Edit {_DEVICE_MAP_FILE} to add it."
        )

    entity_id = device.get("entity_id", "")
    platform = device.get("platform", "home_assistant").lower()
    device_type = device.get("type", "switch")

    if platform == "ifttt":
        event = device.get("ifttt_event", f"toggle_{device_name.replace(' ', '_')}")
        return _ifttt_trigger(event, value1=state)

    # Home Assistant
    if state in ("on", "turn_on", "enable", "start", "chalao", "on_koro"):
        service = "turn_on"
    elif state in ("off", "turn_off", "disable", "stop", "bondho", "off_koro"):
        service = "turn_off"
    else:
        service = "toggle"

    return _ha_call_service(entity_id, service, domain=device_type)


def _check_status(params: dict) -> str:
    """Check the current state of a smart home device."""
    device_name = params.get("device") or params.get("device_name") or params.get("name", "")

    if not device_name:
        # Return status of all configured devices
        devices = _load_device_map()
        if not devices:
            return _SETUP_MSG

        results = ["Smart Home Device Status:"]
        for name, dev in devices.items():
            entity_id = dev.get("entity_id", "")
            if dev.get("platform", "home_assistant") == "home_assistant":
                status = _ha_get_state(entity_id)
                results.append(f"  - {name}: {status}")
            else:
                results.append(f"  - {name}: (non-HA platform)")
        return "\n".join(results)

    device = _resolve_device(device_name)
    if not device:
        return f"Device '{device_name}' not found. Check your smart_home_devices.json config."

    entity_id = device.get("entity_id", "")
    return _ha_get_state(entity_id)


def _list_devices(params: dict) -> str:
    """List all configured smart home devices."""
    devices = _load_device_map()
    if not devices:
        return "No devices configured. " + _SETUP_MSG

    lines = [f"Configured Smart Home Devices ({len(devices)}):"]
    for name, dev in devices.items():
        entity = dev.get("entity_id", "?")
        dtype = dev.get("type", "?")
        platform = dev.get("platform", "home_assistant")
        lines.append(f"  - {name}: {entity} ({dtype}, {platform})")
    return "\n".join(lines)


# ── Main dispatcher ──────────────────────────────────────────────────────────

def smart_home(parameters: dict, player: Any = None) -> str:
    """Main entry point for the smart_home tool."""
    action = str(parameters.get("action", "toggle_device")).lower().strip()

    if action in ("toggle", "toggle_device", "turn_on", "turn_off", "switch", "on", "off"):
        return _toggle_device(parameters)
    elif action in ("status", "check_status", "check", "state", "get_state"):
        return _check_status(parameters)
    elif action in ("list", "list_devices", "devices", "show_devices"):
        return _list_devices(parameters)
    elif action in ("ifttt", "trigger_ifttt", "webhook"):
        event = parameters.get("event", parameters.get("device", ""))
        return _ifttt_trigger(event, parameters.get("value1", ""), parameters.get("value2", ""))
    elif action in ("setup", "configure"):
        return _SETUP_MSG
    else:
        return (
            f"Unknown smart home action: '{action}'. "
            "Available: toggle_device, check_status, list_devices, ifttt, setup."
        )
