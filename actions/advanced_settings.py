# actions/advanced_settings.py
import ctypes
import json
import os
import re
import subprocess
from typing import Any
from utils.env import get_os

if get_os() == "Windows":
    _WIN_HIDE: dict = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
else:
    _WIN_HIDE = {}


def is_admin() -> bool:
    """Check if the current process is running with Administrator privileges."""
    if get_os() == "Windows":
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    else:
        return os.geteuid() == 0 if hasattr(os, "geteuid") else False


def _run_powershell(command: str, as_admin: bool = False, timeout: int = 10) -> tuple[str, str, int]:
    """Execute a PowerShell command, with optional elevation."""
    if get_os() != "Windows":
        return "", "Advanced settings management is currently configured for Windows.", 1

    if as_admin and not is_admin():
        # Launch elevated PowerShell command
        cmd_escaped = command.replace('"', '`"')
        wrapper = f"Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command \"{cmd_escaped}\"'"
        try:
            res = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", wrapper],
                                 capture_output=True, text=True, timeout=timeout, **_WIN_HIDE)
            return "Elevated command dispatched to administrator prompt.", "", res.returncode
        except Exception as e:
            return "", f"Failed to elevate: {e}", 1

    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True, text=True, timeout=timeout, **_WIN_HIDE
        )
        return res.stdout.strip(), res.stderr.strip(), res.returncode
    except subprocess.TimeoutExpired:
        return "", f"Command timed out after {timeout}s", 1
    except Exception as e:
        return "", str(e), 1


def open_settings_uri(uri: str) -> str:
    """Launch modern Windows Settings URI (e.g., ms-settings:bluetooth)."""
    if get_os() == "Windows":
        try:
            os.system(f"start {uri}")
            return f"Opened Windows Settings page ({uri})."
        except Exception as e:
            return f"Failed to open settings URI: {e}"
    elif get_os() == "Darwin":
        subprocess.Popen(["open", "-a", "System Preferences"])
        return "Opened macOS System Preferences."
    else:
        subprocess.Popen(["gnome-control-center"])
        return "Opened Linux Settings."


def toggle_bluetooth(state: str = "toggle") -> str:
    """Toggle or query Bluetooth state."""
    if get_os() != "Windows":
        return "Bluetooth management currently supported on Windows."

    norm_state = state.lower().strip()
    if norm_state in ("on", "enable", "true", "1"):
        ps_cmd = (
            "[Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime] | Out-Null; "
            "$radios = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult(); "
            "$bt = $radios | Where-Object { $_.Kind -eq 'Bluetooth' }; "
            "if ($bt) { $bt.SetStateAsync('On').GetAwaiter().GetResult() | Out-Null; 'Bluetooth turned ON' } else { 'No Bluetooth radio found' }"
        )
        out, err, code = _run_powershell(ps_cmd, as_admin=False)
        if out and "Bluetooth turned ON" in out:
            return "Bluetooth is now turned ON."
        open_settings_uri("ms-settings:bluetooth")
        return "Opening Bluetooth Settings to turn ON."

    elif norm_state in ("off", "disable", "false", "0"):
        ps_cmd = (
            "[Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime] | Out-Null; "
            "$radios = [Windows.Devices.Radios.Radio]::GetRadiosAsync().GetAwaiter().GetResult(); "
            "$bt = $radios | Where-Object { $_.Kind -eq 'Bluetooth' }; "
            "if ($bt) { $bt.SetStateAsync('Off').GetAwaiter().GetResult() | Out-Null; 'Bluetooth turned OFF' } else { 'No Bluetooth radio found' }"
        )
        out, err, code = _run_powershell(ps_cmd, as_admin=False)
        if out and "Bluetooth turned OFF" in out:
            return "Bluetooth is now turned OFF."
        open_settings_uri("ms-settings:bluetooth")
        return "Opening Bluetooth Settings to turn OFF."

    else:
        # Check Bluetooth device status
        ps_cmd = (
            "$dev = Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue; "
            "if ($dev) { 'Bluetooth is active and devices are connected.' } else { 'Bluetooth is off or no active devices.' }"
        )
        out, _, _ = _run_powershell(ps_cmd)
        open_settings_uri("ms-settings:bluetooth")
        return f"{out or 'Checked Bluetooth status.'} (Opened Bluetooth settings)"


def flush_dns() -> str:
    """Flush DNS cache and reload network resolvers."""
    if get_os() == "Windows":
        out, err, code = _run_powershell("ipconfig /flushdns")
        if code == 0:
            return "DNS Resolver Cache successfully flushed."
        return f"DNS flush status: {out or err}"
    else:
        return "DNS flush is primary on Windows."


def reset_network_adapter(adapter_name: str = "") -> str:
    """Restart network adapter to resolve network connection drops."""
    if get_os() == "Windows":
        cmd = "Restart-NetAdapter -Name (Get-NetAdapter | Where-Object Status -eq 'Up').Name -Confirm:$false"
        if adapter_name:
            cmd = f"Restart-NetAdapter -Name '{adapter_name}' -Confirm:$false"
        out, err, code = _run_powershell(cmd, as_admin=True)
        if code == 0:
            return "Network adapter restart initiated."
        return f"Adapter restart: {out or err}"
    return "Network adapter reset supported on Windows."


def get_network_info() -> str:
    """Retrieve current IP address, default gateway, and active adapter details."""
    if get_os() == "Windows":
        ps_cmd = (
            "$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -notlike '*Loopback*' | Select-Object -First 1).IPAddress; "
            "$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop; "
            "$adapter = (Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1).Name; "
            "\"Adapter: $adapter | IP: $ip | Gateway: $gw\""
        )
        out, err, code = _run_powershell(ps_cmd)
        if out:
            return out
    return "Could not retrieve network info."


def set_power_plan(plan: str = "balanced") -> str:
    """Change Windows Power Plan (high_performance, balanced, power_saver)."""
    if get_os() != "Windows":
        return "Power scheme management supported on Windows."

    plan_norm = plan.lower().strip()
    schemes = {
        "high_performance": "SCHEME_MIN",
        "performance": "SCHEME_MIN",
        "high": "SCHEME_MIN",
        "balanced": "SCHEME_BALANCED",
        "normal": "SCHEME_BALANCED",
        "power_saver": "SCHEME_MAX",
        "saver": "SCHEME_MAX",
        "battery": "SCHEME_MAX",
    }
    target = schemes.get(plan_norm, "SCHEME_BALANCED")
    out, err, code = _run_powershell(f"powercfg /setactive {target}")
    if code == 0:
        return f"Power plan set to {plan_norm.replace('_', ' ').title()}."
    return f"Failed to set power plan: {err or out}"


def get_display_resolution() -> str:
    """Get active primary display resolution and refresh rate."""
    if get_os() == "Windows":
        ps_cmd = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$screen = [System.Windows.Forms.Screen]::PrimaryScreen; "
            "\"Width: $($screen.Bounds.Width)px, Height: $($screen.Bounds.Height)px, BitDepth: $($screen.BitsPerPixel)bit\""
        )
        out, _, _ = _run_powershell(ps_cmd)
        if out:
            return f"Primary Display: {out}"
    return "Display resolution query completed."


def advanced_settings(
    parameters: dict | None = None,
    response: Any = None,
    player: Any = None,
    session_memory: Any = None,
) -> str:
    """
    Main entrypoint for advanced system settings modification.

    parameters:
        action : bluetooth | flush_dns | reset_network | network_info | power_plan | display_resolution | open_settings | run_powershell
        value  : Setting value (e.g. 'on'/'off' for bluetooth, 'high_performance' for power_plan, or custom URI/command)
        command: Raw PowerShell/CMD command for run_powershell
    """
    params = parameters or {}
    action = str(params.get("action", "")).lower().strip().replace(" ", "_").replace("-", "_")
    value = str(params.get("value", "")).strip()
    command = str(params.get("command", "")).strip()

    print(f"[Advanced Settings] Action: '{action}' | Value: '{value}' | Admin: {is_admin()}")
    if player and hasattr(player, "write_log"):
        player.write_log(f"[AdvSettings] {action}")

    # Direct Action Router
    if action in ("bluetooth", "toggle_bluetooth", "bluetooth_on", "bluetooth_off"):
        state = value or ("on" if "on" in action else ("off" if "off" in action else "toggle"))
        return toggle_bluetooth(state)

    if action in ("flush_dns", "dns_flush", "clear_dns"):
        return flush_dns()

    if action in ("reset_network", "restart_adapter", "network_reset"):
        return reset_network_adapter(value)

    if action in ("network_info", "ip_address", "get_ip", "network_status"):
        return get_network_info()

    if action in ("power_plan", "set_power_plan", "power_scheme", "battery_mode"):
        return set_power_plan(value or "balanced")

    if action in ("display_resolution", "resolution", "screen_resolution"):
        if value:
            open_settings_uri("ms-settings:display")
            return f"Opened Display Settings to adjust resolution to {value}."
        return get_display_resolution()

    if action in ("open_settings", "settings_uri", "windows_settings"):
        uri_map = {
            "bluetooth": "ms-settings:bluetooth",
            "display": "ms-settings:display",
            "sound": "ms-settings:sound",
            "network": "ms-settings:network",
            "wifi": "ms-settings:network-wifi",
            "battery": "ms-settings:batterysaver",
            "power": "ms-settings:powersleep",
            "update": "ms-settings:windowsupdate",
            "apps": "ms-settings:appsfeatures",
            "storage": "ms-settings:storagesense",
            "privacy": "ms-settings:privacy",
            "personalization": "ms-settings:personalization",
        }
        target_uri = uri_map.get(value.lower(), value if value.startswith("ms-settings:") else "ms-settings:")
        return open_settings_uri(target_uri)

    if action in ("run_powershell", "powershell", "execute_command"):
        cmd_to_run = command or value
        if not cmd_to_run:
            return "No PowerShell command provided to execute."
        out, err, code = _run_powershell(cmd_to_run, as_admin=False)
        if code == 0:
            return f"Command executed:\n{out or 'Success (no output)'}"
        return f"Command error ({code}):\n{err or out}"

    return f"Unknown advanced settings action: '{action}'. Available: bluetooth, flush_dns, reset_network, network_info, power_plan, display_resolution, open_settings, run_powershell."
