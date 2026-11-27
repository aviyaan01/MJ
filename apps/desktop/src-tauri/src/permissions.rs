use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPermissions {
    pub app_opening: bool,
    pub file_read: bool,
    pub file_write: bool,
    pub system_monitoring: bool,
    pub notifications: bool,
    pub clipboard_write: bool,
    pub web_launch: bool,
    pub wake_word_standby: bool,
    pub configurable_shortcuts: bool,
}

impl Default for DesktopPermissions {
    fn default() -> Self {
        // Hardened defaults (Section 14): every OS-level capability ships OFF.
        Self {
            app_opening: false,
            file_read: false,
            file_write: false,
            system_monitoring: false,
            notifications: false,
            clipboard_write: false,
            web_launch: false,
            wake_word_standby: false,
            configurable_shortcuts: false,
        }
    }
}

const FORBIDDEN_SHELLS: &[&str] = &[
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "bash",
    "bash.exe",
    "sh",
    "sh.exe",
    "wsl",
    "wsl.exe",
    "wscript",
    "wscript.exe",
    "cscript",
    "cscript.exe",
    "mshta",
    "mshta.exe",
    "rundll32",
    "rundll32.exe",
    "regsvr32",
    "regsvr32.exe",
];

fn permissions_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve local data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating local data dir: {e}"))?;
    Ok(dir.join("permissions.json"))
}

pub fn load_permissions(app: &AppHandle) -> DesktopPermissions {
    let Ok(path) = permissions_file_path(app) else {
        return DesktopPermissions::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return DesktopPermissions::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_permissions(app: &AppHandle, perms: &DesktopPermissions) -> Result<(), String> {
    let path = permissions_file_path(app)?;
    let json = serde_json::to_string_pretty(perms)
        .map_err(|e| format!("Failed serializing permissions: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed writing permissions: {e}"))
}

pub fn set_single_permission(
    app: &AppHandle,
    key: &str,
    enabled: bool,
) -> Result<DesktopPermissions, String> {
    let mut perms = load_permissions(app);
    match key {
        "appOpening" => perms.app_opening = enabled,
        "fileRead" => perms.file_read = enabled,
        "fileWrite" => perms.file_write = enabled,
        "systemMonitoring" => perms.system_monitoring = enabled,
        "notifications" => perms.notifications = enabled,
        "clipboardWrite" => perms.clipboard_write = enabled,
        "webLaunch" => perms.web_launch = enabled,
        "wakeWordStandby" => perms.wake_word_standby = enabled,
        "configurableShortcuts" => perms.configurable_shortcuts = enabled,
        _ => return Err(format!("Unknown or unsupported single permission key: {key}")),
    }
    save_permissions(app, &perms)?;
    Ok(perms)
}

pub fn revoke_all_permissions(app: &AppHandle) -> Result<DesktopPermissions, String> {
    let perms = DesktopPermissions::default();
    save_permissions(app, &perms)?;
    Ok(perms)
}

pub fn is_forbidden_shell_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return true;
    }
    let meta_chars = ['|', '&', ';', '`', '$', '>', '<', '\r', '\n', '"', '\''];
    if trimmed.chars().any(|c| meta_chars.contains(&c)) {
        return true;
    }
    let lower = trimmed.replace('\\', "/").to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    FORBIDDEN_SHELLS.contains(&base)
}

pub fn is_protected_system_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if normalized.contains("..") {
        return true;
    }
    let blocked = [
        "c:/windows",
        "c:/program files",
        "c:/program files (x86)",
        "c:/programdata",
        "/windows",
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/system",
    ];
    blocked
        .iter()
        .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}/")))
}

pub fn is_path_within_allowlist(candidate: &Path, approved_folders: &[String]) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(candidate)
        .map_err(|e| format!("Target path could not be verified: {e}"))?;
    if is_protected_system_path(&canonical) {
        return Err("Access to protected system folders is forbidden.".to_string());
    }

    for folder in approved_folders {
        if let Ok(approved_canonical) = fs::canonicalize(Path::new(folder)) {
            if canonical == approved_canonical || canonical.starts_with(&approved_canonical) {
                return Ok(canonical);
            }
        }
    }

    Err("Target path is outside user-approved folders.".to_string())
}
