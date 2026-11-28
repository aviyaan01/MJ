use serde::Serialize;
use std::path::Path;
use sysinfo::System;
use tauri::{AppHandle, State};

use crate::audit::append_audit_entry;
use crate::permissions::{
    has_shell_metachars, is_exe_in_allowlist, load_permissions, normalize_exe_key,
    validate_approved_exe_path, DesktopAllowlistState, DesktopPermissions,
};
use crate::system_monitor::{collect_battery_cpu_ram_status, BatteryCpuRamStatus};

pub const ALLOWLISTED_SHORTCUTS: &[&str] = &[
    "Ctrl+C",
    "Ctrl+V",
    "Ctrl+X",
    "Ctrl+Z",
    "Ctrl+Y",
    "Ctrl+A",
    "Ctrl+S",
    "Ctrl+W",
    "Ctrl+Tab",
    "Alt+Tab",
    "Alt+Left",
    "Alt+Right",
    "Win+M",
    "Win+D",
    "MediaPlayPause",
    "MediaNextTrack",
    "MediaPreviousTrack",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmActionGateError {
    PermissionDisabled,
    ConfirmationRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAppSummary {
    pub target: String,
    pub closed_count: usize,
}

/// Validates percentage inputs (volume 0..=100, brightness 0..=100).
pub fn validate_percentage_level(level: i64) -> Result<u8, String> {
    if !(0..=100).contains(&level) {
        return Err(format!("Level must be between 0 and 100 (received {level})."));
    }
    Ok(level as u8)
}

/// Validates window control action enum without accepting arbitrary shell strings or args.
pub fn validate_window_action(action: &str) -> Result<&'static str, String> {
    match action.trim() {
        "minimize_all" => Ok("minimize_all"),
        "maximize" => Ok("maximize"),
        "switch" => Ok("switch"),
        "close_tab" => Ok("close_tab"),
        _ => Err(format!("Unsupported window action: {}", action.trim())),
    }
}

/// Validates power control action enum without accepting arbitrary shell strings or args.
pub fn validate_power_action(action: &str) -> Result<&'static str, String> {
    match action.trim() {
        "shutdown" => Ok("shutdown"),
        "restart" => Ok("restart"),
        "sleep" => Ok("sleep"),
        "logoff" => Ok("logoff"),
        _ => Err(format!("Unsupported power action: {}", action.trim())),
    }
}

/// Validates allowlisted desktop keyboard shortcuts, blocking dangerous combinations
/// like `Alt+F4`, `Win+R`, `Ctrl+Alt+Del`, or arbitrary shell characters.
pub fn normalize_allowlisted_shortcut(raw: &str) -> Result<&'static str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || has_shell_metachars(trimmed) {
        return Err("Shortcut is empty or contains forbidden characters.".to_string());
    }
    ALLOWLISTED_SHORTCUTS
        .iter()
        .copied()
        .find(|allowed| allowed.eq_ignore_ascii_case(trimmed))
        .ok_or_else(|| format!("Shortcut \"{trimmed}\" is not in the Rust allowlist."))
}

/// Validates text passed to `desktop_type_text`:
/// - Non-empty and at most 500 Unicode scalar values
/// - Rejects NUL (`\0`) and ASCII control characters `< 0x20` to prevent hidden command injection
pub fn validate_type_text_payload(text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err("Text payload cannot be empty.".to_string());
    }
    if text.chars().count() > 500 {
        return Err("Text payload exceeds the 500-character safety limit.".to_string());
    }
    if text.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return Err("Control characters (including Enter/Tab/ESC/NUL) are forbidden in type_text.".to_string());
    }
    Ok(text.to_string())
}

pub fn check_power_permission(perms: &DesktopPermissions, action: &str) -> bool {
    match action {
        "shutdown" => perms.pc_shutdown,
        "restart" => perms.pc_restart,
        "sleep" => perms.pc_sleep,
        "logoff" => perms.pc_logoff,
        _ => false,
    }
}

pub fn power_permission_key(action: &str) -> Option<&'static str> {
    match action {
        "shutdown" => Some("pcShutdown"),
        "restart" => Some("pcRestart"),
        "sleep" => Some("pcSleep"),
        "logoff" => Some("pcLogoff"),
        _ => None,
    }
}

/// Pure confirmation gate helper testable without a running Tauri AppHandle.
pub fn check_confirmed_capability_gate(
    capability_enabled: bool,
    confirmed: bool,
) -> Result<(), ConfirmActionGateError> {
    if !capability_enabled {
        return Err(ConfirmActionGateError::PermissionDisabled);
    }
    if !confirmed {
        return Err(ConfirmActionGateError::ConfirmationRequired);
    }
    Ok(())
}

/// Pure case-insensitive executable identity matcher for closing allowlisted processes cleanly.
pub fn exe_matches_allowlisted_target(
    process_exe: Option<&Path>,
    canonical_target: &Path,
) -> bool {
    let Some(exe) = process_exe else {
        return false;
    };
    normalize_exe_key(exe) == normalize_exe_key(canonical_target)
}

#[cfg(windows)]
mod win32_impl {
    use super::{validate_window_action, ALLOWLISTED_SHORTCUTS};
    use std::mem::size_of;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows_sys::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
        SE_SHUTDOWN_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Power::SetSuspendState;
    use windows_sys::Win32::System::Shutdown::{
        ExitWindowsEx, LockWorkStation, EWX_LOGOFF, EWX_POWEROFF, EWX_REBOOT, EWX_SHUTDOWN,
        SHTDN_REASON_MAJOR_APPLICATION,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VK_A, VK_C, VK_CONTROL, VK_D, VK_LEFT, VK_LWIN, VK_M, VK_MEDIA_NEXT_TRACK,
        VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MENU, VK_RIGHT, VK_S, VK_TAB, VK_V,
        VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP, VK_W, VK_X, VK_Y, VK_Z,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, PostMessageW, ShowWindow, HWND_BROADCAST,
        SC_MONITORPOWER, SW_MAXIMIZE, WM_SYSCOMMAND,
    };

    fn make_vk_input(vk: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn tap_vk(vk: u16) -> Result<(), String> {
        let inputs = [make_vk_input(vk, 0), make_vk_input(vk, KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err("Win32 SendInput failed to inject virtual key.".to_string());
        }
        Ok(())
    }

    fn send_chord(modifiers: &[u16], key: u16) -> Result<(), String> {
        let mut seq: Vec<INPUT> = Vec::with_capacity(modifiers.len() * 2 + 2);
        for &m in modifiers {
            seq.push(make_vk_input(m, 0));
        }
        seq.push(make_vk_input(key, 0));
        seq.push(make_vk_input(key, KEYEVENTF_KEYUP));
        for &m in modifiers.iter().rev() {
            seq.push(make_vk_input(m, KEYEVENTF_KEYUP));
        }
        let sent = unsafe { SendInput(seq.len() as u32, seq.as_ptr(), size_of::<INPUT>() as i32) };
        if sent != seq.len() as u32 {
            return Err("Win32 SendInput failed to dispatch keyboard chord.".to_string());
        }
        Ok(())
    }

    pub fn set_volume_percent(level: u8) -> Result<(), String> {
        // Windows 10/11 volume step is 2% per VK_VOLUME_UP/DOWN key press.
        for _ in 0..50 {
            tap_vk(VK_VOLUME_DOWN)?;
        }
        let steps = (level as usize + 1) / 2;
        for _ in 0..steps {
            tap_vk(VK_VOLUME_UP)?;
        }
        Ok(())
    }

    pub fn toggle_volume_mute() -> Result<(), String> {
        tap_vk(VK_VOLUME_MUTE)
    }

    pub fn set_brightness_percent(level: u8) -> Result<(), String> {
        let hmon = unsafe {
            let fg = GetForegroundWindow();
            let target = if fg.is_null() { GetDesktopWindow() } else { fg };
            MonitorFromWindow(target, MONITOR_DEFAULTTOPRIMARY)
        };
        if hmon.is_null() {
            return Err("No display monitor handle could be resolved.".to_string());
        }

        let mut count: u32 = 0;
        let ok_count = unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut count) };
        if ok_count == 0 || count == 0 {
            return Err("No DDC/CI physical monitors reported for brightness control.".to_string());
        }

        let mut monitors = vec![
            PHYSICAL_MONITOR {
                hPhysicalMonitor: null_mut(),
                szPhysicalMonitorDescription: [0u16; 128],
            };
            count as usize
        ];
        let ok_list = unsafe {
            GetPhysicalMonitorsFromHMONITOR(hmon, count, monitors.as_mut_ptr())
        };
        if ok_list == 0 {
            return Err("Failed retrieving physical monitor handles.".to_string());
        }

        let mut any_succeeded = false;
        for m in &monitors {
            let res = unsafe { SetMonitorBrightness(m.hPhysicalMonitor, level as u32) };
            if res != 0 {
                any_succeeded = true;
            }
        }
        unsafe {
            DestroyPhysicalMonitors(count, monitors.as_ptr());
        }

        if !any_succeeded {
            return Err(
                "Display hardware did not accept DDC/CI SetMonitorBrightness (e.g. built-in panel without DDC/CI)."
                    .to_string(),
            );
        }
        Ok(())
    }

    pub fn lock_workstation() -> Result<(), String> {
        let ok = unsafe { LockWorkStation() };
        if ok == 0 {
            return Err("Win32 LockWorkStation failed.".to_string());
        }
        Ok(())
    }

    pub fn sleep_display() -> Result<(), String> {
        let ok = unsafe { PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER as usize, 2) };
        if ok == 0 {
            return Err("Win32 PostMessageW monitor standby failed.".to_string());
        }
        Ok(())
    }

    pub fn perform_window_action(action: &str) -> Result<(), String> {
        match validate_window_action(action)? {
            "minimize_all" => send_chord(&[VK_LWIN], VK_M),
            "maximize" => {
                let fg = unsafe { GetForegroundWindow() };
                if fg.is_null() {
                    return Err("No active foreground window to maximize.".to_string());
                }
                unsafe {
                    ShowWindow(fg, SW_MAXIMIZE);
                }
                Ok(())
            }
            "switch" => send_chord(&[VK_MENU], VK_TAB),
            "close_tab" => send_chord(&[VK_CONTROL], VK_W),
            other => Err(format!("Unsupported window action: {other}")),
        }
    }

    pub fn dispatch_allowlisted_shortcut(canonical_shortcut: &str) -> Result<(), String> {
        debug_assert!(ALLOWLISTED_SHORTCUTS.contains(&canonical_shortcut));
        match canonical_shortcut {
            "Ctrl+C" => send_chord(&[VK_CONTROL], VK_C),
            "Ctrl+V" => send_chord(&[VK_CONTROL], VK_V),
            "Ctrl+X" => send_chord(&[VK_CONTROL], VK_X),
            "Ctrl+Z" => send_chord(&[VK_CONTROL], VK_Z),
            "Ctrl+Y" => send_chord(&[VK_CONTROL], VK_Y),
            "Ctrl+A" => send_chord(&[VK_CONTROL], VK_A),
            "Ctrl+S" => send_chord(&[VK_CONTROL], VK_S),
            "Ctrl+W" => send_chord(&[VK_CONTROL], VK_W),
            "Ctrl+Tab" => send_chord(&[VK_CONTROL], VK_TAB),
            "Alt+Tab" => send_chord(&[VK_MENU], VK_TAB),
            "Alt+Left" => send_chord(&[VK_MENU], VK_LEFT),
            "Alt+Right" => send_chord(&[VK_MENU], VK_RIGHT),
            "Win+M" => send_chord(&[VK_LWIN], VK_M),
            "Win+D" => send_chord(&[VK_LWIN], VK_D),
            "MediaPlayPause" => tap_vk(VK_MEDIA_PLAY_PAUSE),
            "MediaNextTrack" => tap_vk(VK_MEDIA_NEXT_TRACK),
            "MediaPreviousTrack" => tap_vk(VK_MEDIA_PREV_TRACK),
            other => Err(format!("Shortcut \"{other}\" is not allowlisted.")),
        }
    }

    pub fn type_unicode_text(text: &str) -> Result<(), String> {
        let mut inputs: Vec<INPUT> = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err("Win32 SendInput failed to type complete text payload.".to_string());
        }
        Ok(())
    }

    fn enable_shutdown_privilege() -> Result<(), String> {
        let mut token: HANDLE = null_mut();
        let ok_token = unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                &mut token,
            )
        };
        if ok_token == 0 || token.is_null() {
            return Err("Failed opening process token for SeShutdownPrivilege.".to_string());
        }

        let mut luid = LUID {
            LowPart: 0,
            HighPart: 0,
        };
        let ok_luid = unsafe { LookupPrivilegeValueW(null(), SE_SHUTDOWN_NAME, &mut luid) };
        if ok_luid == 0 {
            unsafe {
                CloseHandle(token);
            }
            return Err("Failed looking up SeShutdownPrivilege LUID.".to_string());
        }

        let mut tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };

        let ok_adj = unsafe {
            AdjustTokenPrivileges(token, 0, &mut tp, 0, null_mut(), null_mut())
        };
        unsafe {
            CloseHandle(token);
        }
        if ok_adj == 0 {
            return Err("Failed adjusting SeShutdownPrivilege.".to_string());
        }
        Ok(())
    }

    pub fn perform_power_action(action: &str) -> Result<(), String> {
        match action {
            "logoff" => {
                let ok = unsafe { ExitWindowsEx(EWX_LOGOFF, SHTDN_REASON_MAJOR_APPLICATION) };
                if ok == 0 {
                    return Err("Win32 ExitWindowsEx(EWX_LOGOFF) failed.".to_string());
                }
                Ok(())
            }
            "sleep" => {
                let ok = unsafe { SetSuspendState(0, 0, 0) };
                if ok == 0 {
                    return Err("Win32 SetSuspendState failed.".to_string());
                }
                Ok(())
            }
            "shutdown" => {
                enable_shutdown_privilege()?;
                let ok = unsafe {
                    ExitWindowsEx(EWX_SHUTDOWN | EWX_POWEROFF, SHTDN_REASON_MAJOR_APPLICATION)
                };
                if ok == 0 {
                    return Err("Win32 ExitWindowsEx(EWX_SHUTDOWN | EWX_POWEROFF) failed.".to_string());
                }
                Ok(())
            }
            "restart" => {
                enable_shutdown_privilege()?;
                let ok = unsafe { ExitWindowsEx(EWX_REBOOT, SHTDN_REASON_MAJOR_APPLICATION) };
                if ok == 0 {
                    return Err("Win32 ExitWindowsEx(EWX_REBOOT) failed.".to_string());
                }
                Ok(())
            }
            other => Err(format!("Unsupported power action: {other}")),
        }
    }
}

#[cfg(not(windows))]
mod win32_impl {
    pub fn set_volume_percent(_level: u8) -> Result<(), String> {
        Err("System volume control is only supported on Windows desktop.".to_string())
    }
    pub fn toggle_volume_mute() -> Result<(), String> {
        Err("System volume mute is only supported on Windows desktop.".to_string())
    }
    pub fn set_brightness_percent(_level: u8) -> Result<(), String> {
        Err("Display brightness control is only supported on Windows desktop.".to_string())
    }
    pub fn lock_workstation() -> Result<(), String> {
        Err("Screen lock is only supported on Windows desktop.".to_string())
    }
    pub fn sleep_display() -> Result<(), String> {
        Err("Display sleep is only supported on Windows desktop.".to_string())
    }
    pub fn perform_window_action(_action: &str) -> Result<(), String> {
        Err("Window actions are only supported on Windows desktop.".to_string())
    }
    pub fn dispatch_allowlisted_shortcut(_canonical_shortcut: &str) -> Result<(), String> {
        Err("Keyboard shortcut injection is only supported on Windows desktop.".to_string())
    }
    pub fn type_unicode_text(_text: &str) -> Result<(), String> {
        Err("Text typing is only supported on Windows desktop.".to_string())
    }
    pub fn perform_power_action(_action: &str) -> Result<(), String> {
        Err("Power actions are only supported on Windows desktop.".to_string())
    }
}

#[tauri::command]
pub fn desktop_get_battery_cpu_ram_status(app: AppHandle) -> Result<BatteryCpuRamStatus, String> {
    let perms = load_permissions(&app);
    if !perms.system_monitoring {
        let _ = append_audit_entry(
            &app,
            "systemMonitoring",
            "Blocked battery/CPU/RAM status read",
            "battery_cpu_ram",
            "denied",
            Some("systemMonitoring capability is OFF"),
        );
        return Err("systemMonitoring capability is OFF.".to_string());
    }
    let status = collect_battery_cpu_ram_status();
    let _ = append_audit_entry(
        &app,
        "systemMonitoring",
        "Read native battery, CPU, and RAM status",
        "battery_cpu_ram",
        "allowed",
        None,
    );
    Ok(status)
}

#[tauri::command]
pub fn desktop_volume_set(app: AppHandle, level: i64) -> Result<u8, String> {
    let perms = load_permissions(&app);
    if !perms.volume_control {
        let _ = append_audit_entry(
            &app,
            "volumeControl",
            "Blocked system volume change",
            &format!("{level}%"),
            "denied",
            Some("volumeControl capability is OFF"),
        );
        return Err("volumeControl capability is OFF.".to_string());
    }
    let valid_level = validate_percentage_level(level)?;
    win32_impl::set_volume_percent(valid_level)?;
    let _ = append_audit_entry(
        &app,
        "volumeControl",
        "Set system volume level",
        &format!("{valid_level}%"),
        "allowed",
        None,
    );
    Ok(valid_level)
}

#[tauri::command]
pub fn desktop_volume_mute(app: AppHandle, muted: Option<bool>) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.volume_control {
        let _ = append_audit_entry(
            &app,
            "volumeControl",
            "Blocked system volume mute",
            "mute",
            "denied",
            Some("volumeControl capability is OFF"),
        );
        return Err("volumeControl capability is OFF.".to_string());
    }
    win32_impl::toggle_volume_mute()?;
    let target_label = match muted {
        Some(true) => "mute",
        Some(false) => "unmute",
        None => "toggle_mute",
    };
    let _ = append_audit_entry(
        &app,
        "volumeControl",
        "Toggled system audio mute",
        target_label,
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_brightness_set(app: AppHandle, level: i64) -> Result<u8, String> {
    let perms = load_permissions(&app);
    if !perms.brightness_control {
        let _ = append_audit_entry(
            &app,
            "brightnessControl",
            "Blocked display brightness adjustment",
            &format!("{level}%"),
            "denied",
            Some("brightnessControl capability is OFF"),
        );
        return Err("brightnessControl capability is OFF.".to_string());
    }
    let valid_level = validate_percentage_level(level)?;
    win32_impl::set_brightness_percent(valid_level)?;
    let _ = append_audit_entry(
        &app,
        "brightnessControl",
        "Set display brightness",
        &format!("{valid_level}%"),
        "allowed",
        None,
    );
    Ok(valid_level)
}

#[tauri::command]
pub fn desktop_lock_screen(app: AppHandle) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.lock_screen {
        let _ = append_audit_entry(
            &app,
            "lockScreen",
            "Blocked lock workstation",
            "workstation",
            "denied",
            Some("lockScreen capability is OFF"),
        );
        return Err("lockScreen capability is OFF.".to_string());
    }
    win32_impl::lock_workstation()?;
    let _ = append_audit_entry(
        &app,
        "lockScreen",
        "Locked Windows session",
        "workstation",
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_sleep_display(app: AppHandle) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.sleep_display {
        let _ = append_audit_entry(
            &app,
            "sleepDisplay",
            "Blocked monitor sleep",
            "display",
            "denied",
            Some("sleepDisplay capability is OFF"),
        );
        return Err("sleepDisplay capability is OFF.".to_string());
    }
    win32_impl::sleep_display()?;
    let _ = append_audit_entry(
        &app,
        "sleepDisplay",
        "Turned display to low-power standby",
        "display",
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_window_action(app: AppHandle, action: String) -> Result<String, String> {
    let perms = load_permissions(&app);
    if !perms.window_control {
        let _ = append_audit_entry(
            &app,
            "windowControl",
            "Blocked window action",
            action.trim(),
            "denied",
            Some("windowControl capability is OFF"),
        );
        return Err("windowControl capability is OFF.".to_string());
    }
    let canonical = match validate_window_action(&action) {
        Ok(a) => a,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "windowControl",
                "Rejected invalid window action",
                action.trim(),
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };
    win32_impl::perform_window_action(canonical)?;
    let _ = append_audit_entry(
        &app,
        "windowControl",
        "Executed desktop window action",
        canonical,
        "allowed",
        None,
    );
    Ok(canonical.to_string())
}

#[tauri::command]
pub fn desktop_close_app(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    executable_path: String,
) -> Result<CloseAppSummary, String> {
    let perms = load_permissions(&app);
    if !perms.app_closing {
        let _ = append_audit_entry(
            &app,
            "appClosing",
            "Blocked closing application",
            &executable_path,
            "denied",
            Some("appClosing capability is OFF"),
        );
        return Err("appClosing capability is OFF.".to_string());
    }

    let canonical_exe = match validate_approved_exe_path(&executable_path) {
        Ok(p) => p,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "appClosing",
                "Blocked forbidden or invalid application close target",
                &executable_path,
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };

    let approved_apps = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        guard.approved_apps.clone()
    };

    if !is_exe_in_allowlist(&canonical_exe, &approved_apps) {
        let _ = append_audit_entry(
            &app,
            "appClosing",
            "Blocked closing unapproved application",
            &canonical_exe.to_string_lossy(),
            "denied",
            Some("Executable not in Rust native allowlist"),
        );
        return Err("Application is not in the native desktop allowlist.".to_string());
    }

    let mut sys = System::new_all();
    sys.refresh_all();
    let mut closed_count = 0usize;
    for process in sys.processes().values() {
        if exe_matches_allowlisted_target(process.exe(), &canonical_exe) && process.kill() {
            closed_count += 1;
        }
    }

    let target_str = canonical_exe.to_string_lossy().to_string();
    let _ = append_audit_entry(
        &app,
        "appClosing",
        "Closed allowlisted desktop application processes",
        &target_str,
        "allowed",
        Some(&format!("Terminated {closed_count} matching process(es)")),
    );
    Ok(CloseAppSummary {
        target: target_str,
        closed_count,
    })
}

#[tauri::command]
pub fn desktop_type_text(app: AppHandle, text: String, confirmed: bool) -> Result<usize, String> {
    let perms = load_permissions(&app);
    if !perms.text_typing {
        let _ = append_audit_entry(
            &app,
            "textTyping",
            "Blocked desktop text typing",
            "keyboard_input",
            "denied",
            Some("textTyping capability is OFF"),
        );
        return Err("textTyping capability is OFF.".to_string());
    }

    let valid_text = match validate_type_text_payload(&text) {
        Ok(t) => t,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "textTyping",
                "Rejected unsafe text typing payload",
                "keyboard_input",
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };

    if !confirmed {
        let _ = append_audit_entry(
            &app,
            "textTyping",
            "Cancelled unconfirmed desktop text typing",
            &format!("{} chars", valid_text.chars().count()),
            "cancelled",
            Some("Explicit user confirmation is required before typing text"),
        );
        return Err("Explicit confirmation is required before typing text.".to_string());
    }

    win32_impl::type_unicode_text(&valid_text)?;
    let char_count = valid_text.chars().count();
    let _ = append_audit_entry(
        &app,
        "textTyping",
        "Typed confirmed text on desktop",
        &format!("{char_count} chars"),
        "allowed",
        None,
    );
    Ok(char_count)
}

#[tauri::command]
pub fn desktop_press_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    let perms = load_permissions(&app);
    if !perms.shortcut_press {
        let _ = append_audit_entry(
            &app,
            "shortcutPress",
            "Blocked allowlisted shortcut press",
            shortcut.trim(),
            "denied",
            Some("shortcutPress capability is OFF"),
        );
        return Err("shortcutPress capability is OFF.".to_string());
    }

    let canonical = match normalize_allowlisted_shortcut(&shortcut) {
        Ok(s) => s,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "shortcutPress",
                "Blocked non-allowlisted desktop shortcut",
                shortcut.trim(),
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };

    win32_impl::dispatch_allowlisted_shortcut(canonical)?;
    let _ = append_audit_entry(
        &app,
        "shortcutPress",
        "Pressed allowlisted desktop shortcut",
        canonical,
        "allowed",
        None,
    );
    Ok(canonical.to_string())
}

#[tauri::command]
pub fn desktop_power_action(
    app: AppHandle,
    action: String,
    confirmed: bool,
) -> Result<String, String> {
    let canonical = validate_power_action(&action)?;
    let perm_key = power_permission_key(canonical).unwrap_or("pcShutdown");
    let perms = load_permissions(&app);

    match check_confirmed_capability_gate(check_power_permission(&perms, canonical), confirmed) {
        Err(ConfirmActionGateError::PermissionDisabled) => {
            let _ = append_audit_entry(
                &app,
                perm_key,
                "Blocked desktop power action",
                canonical,
                "denied",
                Some(&format!("{perm_key} capability is OFF")),
            );
            return Err(format!("{perm_key} capability is OFF."));
        }
        Err(ConfirmActionGateError::ConfirmationRequired) => {
            let _ = append_audit_entry(
                &app,
                perm_key,
                "Cancelled unconfirmed desktop power action",
                canonical,
                "cancelled",
                Some("Explicit spoken or UI confirmation is required for power actions"),
            );
            return Err("Explicit confirmation is required before running power action.".to_string());
        }
        Ok(()) => {}
    }

    let _ = append_audit_entry(
        &app,
        perm_key,
        "Executed confirmed desktop power action",
        canonical,
        "allowed",
        None,
    );
    win32_impl::perform_power_action(canonical)?;
    Ok(canonical.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_volume_and_brightness_bounds() {
        assert_eq!(validate_percentage_level(0), Ok(0));
        assert_eq!(validate_percentage_level(45), Ok(45));
        assert_eq!(validate_percentage_level(100), Ok(100));
        assert!(validate_percentage_level(-1).is_err());
        assert!(validate_percentage_level(101).is_err());
    }

    #[test]
    fn enforces_allowlisted_shortcuts_only() {
        assert_eq!(normalize_allowlisted_shortcut("ctrl+c"), Ok("Ctrl+C"));
        assert_eq!(normalize_allowlisted_shortcut("Ctrl+W"), Ok("Ctrl+W"));
        assert_eq!(normalize_allowlisted_shortcut("Alt+Tab"), Ok("Alt+Tab"));
        assert_eq!(normalize_allowlisted_shortcut("MediaPlayPause"), Ok("MediaPlayPause"));

        for blocked in [
            "",
            "Alt+F4",
            "Win+R",
            "Ctrl+Alt+Del",
            "Ctrl+Shift+Esc",
            "Ctrl+C && calc.exe",
            "powershell.exe",
        ] {
            assert!(
                normalize_allowlisted_shortcut(blocked).is_err(),
                "expected rejection for shortcut {blocked}"
            );
        }
    }

    #[test]
    fn rejects_control_chars_and_oversized_type_text() {
        assert_eq!(
            validate_type_text_payload("Hello MJ Assistant!"),
            Ok("Hello MJ Assistant!".to_string())
        );
        assert!(validate_type_text_payload("").is_err());
        assert!(validate_type_text_payload(&"a".repeat(501)).is_err());
        assert!(validate_type_text_payload("rm -rf\n").is_err());
        assert!(validate_type_text_payload("hello\rworld").is_err());
        assert!(validate_type_text_payload("null\0byte").is_err());
        assert!(validate_type_text_payload("esc\x1b").is_err());
    }

    #[test]
    fn validates_window_and_power_actions_and_confirmation_gate() {
        for ok_w in ["minimize_all", "maximize", "switch", "close_tab"] {
            assert_eq!(validate_window_action(ok_w), Ok(ok_w));
        }
        assert!(validate_window_action("kill_all").is_err());

        for ok_p in ["shutdown", "restart", "sleep", "logoff"] {
            assert_eq!(validate_power_action(ok_p), Ok(ok_p));
        }
        assert!(validate_power_action("shutdown -r -t 0").is_err());

        assert_eq!(
            check_confirmed_capability_gate(false, true),
            Err(ConfirmActionGateError::PermissionDisabled)
        );
        assert_eq!(
            check_confirmed_capability_gate(true, false),
            Err(ConfirmActionGateError::ConfirmationRequired)
        );
        assert_eq!(check_confirmed_capability_gate(true, true), Ok(()));

        let mut perms = DesktopPermissions::default();
        assert!(!check_power_permission(&perms, "sleep"));
        perms.pc_sleep = true;
        assert!(check_power_permission(&perms, "sleep"));
        assert!(!check_power_permission(&perms, "shutdown"));
        assert!(!check_power_permission(&perms, "restart"));
        assert!(!check_power_permission(&perms, "logoff"));
    }

    #[test]
    fn matches_allowlisted_process_executable_case_insensitively() {
        let target = Path::new("C:\\Users\\ASUS\\Apps\\Code.exe");
        assert!(exe_matches_allowlisted_target(
            Some(Path::new("C:\\users\\asus\\apps\\code.exe")),
            target
        ));
        assert!(!exe_matches_allowlisted_target(
            Some(Path::new("C:\\Windows\\System32\\cmd.exe")),
            target
        ));
        assert!(!exe_matches_allowlisted_target(None, target));
    }
}
