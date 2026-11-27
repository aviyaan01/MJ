use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAllowlist {
    pub approved_apps: Vec<String>,
    pub approved_domains: Vec<String>,
    pub approved_folders: Vec<String>,
}

#[derive(Default)]
pub struct DesktopAllowlistState(pub Mutex<DesktopAllowlist>);

/// Shells, script interpreters, and living-off-the-land binaries (LOLBins)
/// that must never be launched or allowlisted. Matched against the filename
/// stem (case-insensitive, with or without `.exe`).
const FORBIDDEN_EXECUTABLE_STEMS: &[&str] = &[
    "cmd",
    "powershell",
    "pwsh",
    "powershell_ise",
    "bash",
    "sh",
    "wsl",
    "conhost",
    "python",
    "pythonw",
    "python3",
    "py",
    "node",
    "deno",
    "bun",
    "certutil",
    "mshta",
    "rundll32",
    "regsvr32",
    "wscript",
    "cscript",
    "bitsadmin",
    "msiexec",
    "forfiles",
    "pcalua",
    "control",
    "hh",
    "infdefaultinstall",
    "odbcconf",
    "installutil",
    "regasm",
    "regsvcs",
    "msxsl",
    "csc",
    "vbc",
    "msbuild",
];

const FORBIDDEN_SCRIPT_EXTENSIONS: &[&str] = &[
    "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "scr",
    "pif", "com", "cpl", "msc", "msi", "msp", "jar",
];

fn permissions_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve local data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating local data dir: {e}"))?;
    Ok(dir.join("permissions.json"))
}

fn allowlist_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve local data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating local data dir: {e}"))?;
    Ok(dir.join("allowlist.json"))
}

pub fn load_allowlist_from_file(path: &Path) -> DesktopAllowlist {
    let Ok(raw) = fs::read_to_string(path) else {
        return DesktopAllowlist::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_allowlist_to_file(path: &Path, allowlist: &DesktopAllowlist) -> Result<(), String> {
    let json = serde_json::to_string_pretty(allowlist)
        .map_err(|e| format!("Failed serializing allowlist: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed writing allowlist: {e}"))
}

pub fn load_allowlist(app: &AppHandle) -> DesktopAllowlist {
    let Ok(path) = allowlist_file_path(app) else {
        return DesktopAllowlist::default();
    };
    load_allowlist_from_file(&path)
}

pub fn save_allowlist(app: &AppHandle, allowlist: &DesktopAllowlist) -> Result<(), String> {
    let path = allowlist_file_path(app)?;
    save_allowlist_to_file(&path, allowlist)
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

pub fn has_shell_metachars(value: &str) -> bool {
    let meta_chars = ['|', '&', ';', '`', '$', '>', '<', '\r', '\n', '"', '\'', '\0'];
    value.chars().any(|c| meta_chars.contains(&c))
}

pub fn is_forbidden_shell_target(target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() || has_shell_metachars(trimmed) {
        return true;
    }

    let normalized = trimmed.replace('\\', "/").to_lowercase();
    if normalized.contains("..") {
        return true;
    }

    let base = normalized.rsplit('/').next().unwrap_or(&normalized).trim();
    if base.is_empty() {
        return true;
    }

    // Check script / batch extensions (.bat, .cmd, .ps1, .vbs, etc.)
    if let Some((_, ext)) = base.rsplit_once('.') {
        if FORBIDDEN_SCRIPT_EXTENSIONS.contains(&ext) {
            return true;
        }
    }

    let stem = base.strip_suffix(".exe").unwrap_or(base);
    FORBIDDEN_EXECUTABLE_STEMS.contains(&stem)
}

/// Validates structural path requirements for application launchers:
/// - must be a valid non-empty absolute local path (no UNC `\\...` or device namespace `\\?\`)
/// - must have no shell metacharacters or `..` traversal components
/// - must end with `.exe` (case-insensitive)
/// - must not match any blocked shell, script interpreter, or LOLBin
pub fn validate_executable_candidate(target: &str) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() || has_shell_metachars(trimmed) {
        return Err("Executable path is empty or contains forbidden characters.".to_string());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("UNC network paths and device prefixes are forbidden.".to_string());
    }
    if is_forbidden_shell_target(trimmed) {
        return Err("Shells, script interpreters, and LOLBins are strictly forbidden.".to_string());
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err("Application target must be an absolute path.".to_string());
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Parent directory traversal (..) is forbidden in executable paths.".to_string());
    }

    let has_exe_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !has_exe_ext {
        return Err("Application launcher requires an explicit .exe file extension.".to_string());
    }

    Ok(path.to_path_buf())
}

/// Resolves and validates an executable path on disk before allowing or launching it.
/// Canonicalization catches symlinks / NTFS junctions redirecting to scripts or interpreters.
pub fn validate_approved_exe_path(target: &str) -> Result<PathBuf, String> {
    let candidate = validate_executable_candidate(target)?;
    let canonical = fs::canonicalize(&candidate)
        .map_err(|e| format!("Application executable could not be resolved: {e}"))?;
    if !canonical.is_file() {
        return Err("Application target must point to an existing executable file.".to_string());
    }
    let canonical_str = canonical.to_string_lossy();
    let revalidated = validate_executable_candidate(&canonical_str)?;
    Ok(revalidated)
}

pub fn normalize_exe_key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        raw.trim_start_matches("//?/").to_lowercase()
    } else {
        raw
    }
}

pub fn is_exe_in_allowlist(canonical_exe: &Path, approved_apps: &[String]) -> bool {
    let target_key = normalize_exe_key(canonical_exe);
    approved_apps.iter().any(|entry| {
        let Ok(candidate) = validate_executable_candidate(entry) else {
            return false;
        };
        if let Ok(canonical_entry) = fs::canonicalize(&candidate) {
            if normalize_exe_key(&canonical_entry) == target_key {
                return true;
            }
        }
        normalize_exe_key(&candidate) == target_key
    })
}

pub fn normalize_approved_domain(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || has_shell_metachars(trimmed)
        || trimmed.contains('\\')
        || trimmed.contains('@')
        || trimmed.contains('*')
    {
        return None;
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let parsed = url::Url::parse(&with_scheme).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let url::Host::Domain(domain) = parsed.host()? else {
        return None;
    };
    let clean = domain.trim_end_matches('.').to_ascii_lowercase();
    if clean.is_empty() || clean.starts_with('.') {
        return None;
    }
    Some(clean)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_lolbins_interpreters_and_script_extensions() {
        for bad in [
            "cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "powershell.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "C:\\Python312\\python.exe",
            "C:\\Python312\\pythonw.exe",
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Windows\\System32\\certutil.exe",
            "C:\\Windows\\System32\\mshta.exe",
            "C:\\Windows\\System32\\rundll32.exe",
            "C:\\Windows\\System32\\regsvr32.exe",
            "C:\\Windows\\System32\\wscript.exe",
            "C:\\Windows\\System32\\cscript.exe",
            "C:\\Tools\\script.bat",
            "C:\\Tools\\script.cmd",
            "C:\\Tools\\script.ps1",
            "C:\\Tools\\script.vbs",
            "C:\\Tools\\app.exe | whoami",
        ] {
            assert!(
                is_forbidden_shell_target(bad) || validate_executable_candidate(bad).is_err(),
                "expected forbidden/rejected for {bad}"
            );
        }
    }

    #[test]
    fn enforces_absolute_exe_path_validation() {
        assert!(validate_executable_candidate("notepad.exe").is_err());
        assert!(validate_executable_candidate("./app.exe").is_err());
        assert!(validate_executable_candidate("\\\\evil-server\\share\\app.exe").is_err());
        assert!(validate_executable_candidate("C:\\Tools\\..\\Windows\\notepad.exe").is_err());
        assert!(validate_executable_candidate("C:\\Tools\\script.ps1").is_err());
        assert!(validate_executable_candidate("C:\\Tools\\noext").is_err());
        assert!(validate_executable_candidate("C:\\Users\\ASUS\\Apps\\Code.exe").is_ok());
    }

    #[test]
    fn normalizes_valid_domains_and_rejects_malformed() {
        assert_eq!(
            normalize_approved_domain("https://docs.x.ai/guides"),
            Some("docs.x.ai".to_string())
        );
        assert_eq!(
            normalize_approved_domain("aistudio.google.com"),
            Some("aistudio.google.com".to_string())
        );
        assert_eq!(normalize_approved_domain("http://docs.x.ai"), None);
        assert_eq!(normalize_approved_domain("docs.x.ai@evil.com"), None);
        assert_eq!(normalize_approved_domain("evil.com\\.approved.com"), None);
        assert_eq!(normalize_approved_domain("*.approved.com"), None);
    }
}
