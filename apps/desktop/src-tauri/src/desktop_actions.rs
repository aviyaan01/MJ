use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::{Host, Url};

use crate::audit::{append_audit_entry, read_recent_audit_entries, DesktopAuditEntry};
use crate::permissions::{
    has_shell_metachars, is_exe_in_allowlist, is_forbidden_shell_target,
    is_path_within_allowlist, is_protected_system_path, load_permissions,
    normalize_approved_domain, normalize_exe_key, revoke_all_permissions, save_allowlist,
    set_single_permission, validate_approved_exe_path, DesktopAllowlist, DesktopAllowlistState,
    DesktopPermissions,
};
use crate::system_monitor::{collect_native_telemetry, NativeHostTelemetry};
use crate::tray::update_tray_mic_indicator;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMatch {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePlanSummary {
    pub moved_count: usize,
    pub skipped_count: usize,
    pub details: Vec<String>,
}

/// Strictly validates an HTTPS URL using `url::Url::parse` against Rust-stored approved domains.
/// Blocks backslash (`\`) authority confusion, userinfo (`@`), non-HTTPS schemes, and non-domain hosts.
pub fn validate_approved_https_url(
    raw_url: &str,
    approved_domains: &[String],
) -> Result<Url, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || has_shell_metachars(trimmed) {
        return Err("URL is empty or contains forbidden characters.".to_string());
    }
    if trimmed.contains('\\') || trimmed.contains('\t') {
        return Err("Backslashes and control whitespace are forbidden in URLs.".to_string());
    }
    if trimmed.contains('@') {
        return Err("URL userinfo (@) is forbidden.".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS URLs are permitted.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL embedded credentials are forbidden.".to_string());
    }

    let host_lower = match parsed.host() {
        Some(Host::Domain(domain)) => domain.trim_end_matches('.').to_ascii_lowercase(),
        _ => return Err("URL must target an approved domain name.".to_string()),
    };
    if host_lower.is_empty() {
        return Err("URL host is empty.".to_string());
    }

    let domain_ok = approved_domains.iter().any(|d| {
        let Some(dl) = normalize_approved_domain(d) else {
            return false;
        };
        host_lower == dl || host_lower.ends_with(&format!(".{dl}"))
    });

    if !domain_ok {
        return Err("Domain is not in the native desktop web allowlist.".to_string());
    }

    Ok(parsed)
}

#[tauri::command]
pub fn desktop_get_permissions(app: AppHandle) -> DesktopPermissions {
    load_permissions(&app)
}

#[tauri::command]
pub fn desktop_set_permission(
    app: AppHandle,
    key: String,
    enabled: bool,
) -> Result<DesktopPermissions, String> {
    let perms = set_single_permission(&app, &key, enabled)?;
    let _ = append_audit_entry(
        &app,
        &key,
        if enabled {
            "Enabled desktop capability"
        } else {
            "Disabled desktop capability"
        },
        &key,
        "allowed",
        None,
    );
    Ok(perms)
}

#[tauri::command]
pub fn desktop_revoke_all(app: AppHandle) -> Result<DesktopPermissions, String> {
    let perms = revoke_all_permissions(&app)?;
    update_tray_mic_indicator(&app, false, false);
    let _ = append_audit_entry(
        &app,
        "desktop_revocation",
        "Revoked all OS capabilities",
        "all_os_capabilities",
        "allowed",
        None,
    );
    Ok(perms)
}

#[tauri::command]
pub fn desktop_get_allowlist(state: State<'_, DesktopAllowlistState>) -> Result<DesktopAllowlist, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
    Ok(guard.clone())
}

/// Native Rust-controlled flow to approve an `.exe` application via the OS File Explorer picker.
/// Webview scripts cannot specify arbitrary paths cleanly without interactive OS user selection.
#[tauri::command]
pub async fn desktop_pick_and_approve_app(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
) -> Result<Option<String>, String> {
    let picker_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("Windows Executables", &["exe"])
            .set_title("MJ Assistant — Select Approved Application (.exe)")
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("Native file dialog task failed: {e}"))?;

    let Some(file_path) = picked else {
        let _ = append_audit_entry(
            &app,
            "appOpening",
            "Cancelled native app allowlist picker",
            "(cancelled)",
            "cancelled",
            None,
        );
        return Ok(None);
    };

    let Some(raw_path) = file_path.as_path() else {
        return Err("Selected item does not represent a local filesystem path.".to_string());
    };
    let raw_str = raw_path.to_string_lossy().to_string();
    let canonical = match validate_approved_exe_path(&raw_str) {
        Ok(p) => p,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "appOpening",
                "Rejected unsafe application in native picker",
                &raw_str,
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };

    let canonical_str = canonical.to_string_lossy().to_string();
    let key = normalize_exe_key(&canonical);

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        if !guard
            .approved_apps
            .iter()
            .any(|existing| normalize_exe_key(Path::new(existing)) == key)
        {
            guard.approved_apps.push(canonical_str.clone());
            save_allowlist(&app, &guard)?;
        }
    }

    let _ = append_audit_entry(
        &app,
        "appOpening",
        "Approved executable via native OS picker",
        &canonical_str,
        "allowed",
        Some("Stored in Rust native allowlist"),
    );

    Ok(Some(canonical_str))
}

/// Native Rust-controlled flow to approve a local folder via the OS Folder Picker dialog.
#[tauri::command]
pub async fn desktop_pick_and_approve_folder(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
) -> Result<Option<String>, String> {
    let picker_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .set_title("MJ Assistant — Select Approved Folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Native folder dialog task failed: {e}"))?;

    let Some(folder_path) = picked else {
        return Ok(None);
    };

    let Some(raw_path) = folder_path.as_path() else {
        return Err("Selected item is not a local filesystem folder.".to_string());
    };
    let canonical = fs::canonicalize(raw_path)
        .map_err(|e| format!("Could not resolve selected folder: {e}"))?;
    if is_protected_system_path(&canonical) {
        let target_str = canonical.to_string_lossy().to_string();
        let _ = append_audit_entry(
            &app,
            "fileRead",
            "Blocked protected OS folder in native picker",
            &target_str,
            "denied",
            Some("Protected system folder"),
        );
        return Err("Protected system directories cannot be approved.".to_string());
    }

    let canonical_str = canonical.to_string_lossy().to_string();
    let norm = normalize_exe_key(&canonical);

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        if !guard
            .approved_folders
            .iter()
            .any(|existing| normalize_exe_key(Path::new(existing)) == norm)
        {
            guard.approved_folders.push(canonical_str.clone());
            save_allowlist(&app, &guard)?;
        }
    }

    let _ = append_audit_entry(
        &app,
        "fileRead",
        "Approved folder via native OS picker",
        &canonical_str,
        "allowed",
        Some("Stored in Rust native allowlist"),
    );

    Ok(Some(canonical_str))
}

/// Native Rust-controlled domain approval gated by a native OS Yes/No confirmation prompt
/// so webview scripts cannot silently add domains to Rust's allowlist without explicit user approval.
#[tauri::command]
pub async fn desktop_approve_domain_native(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    domain: String,
) -> Result<bool, String> {
    let clean_domain = normalize_approved_domain(&domain)
        .ok_or_else(|| "Invalid HTTPS domain name.".to_string())?;

    let prompt_app = app.clone();
    let domain_display = clean_domain.clone();
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        prompt_app
            .dialog()
            .message(format!(
                "Allow MJ Assistant Desktop Companion to open HTTPS links on:\n\n{domain_display}\n\nApprove only domains you trust."
            ))
            .title("MJ Assistant — Native Domain Approval")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show()
    })
    .await
    .map_err(|e| format!("Native confirmation dialog task failed: {e}"))?;

    if !confirmed {
        let _ = append_audit_entry(
            &app,
            "webLaunch",
            "Declined domain approval in native dialog",
            &clean_domain,
            "cancelled",
            None,
        );
        return Ok(false);
    }

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        if !guard
            .approved_domains
            .iter()
            .any(|d| d.eq_ignore_ascii_case(&clean_domain))
        {
            guard.approved_domains.push(clean_domain.clone());
            save_allowlist(&app, &guard)?;
        }
    }

    let _ = append_audit_entry(
        &app,
        "webLaunch",
        "Approved HTTPS domain via native confirmation",
        &clean_domain,
        "allowed",
        Some("Stored in Rust native allowlist"),
    );

    Ok(true)
}

#[tauri::command]
pub fn desktop_remove_allowlist_entry(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    kind: String,
    target: String,
) -> Result<DesktopAllowlist, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Allowlist state lock poisoned.".to_string())?;

    let norm_target = normalize_exe_key(Path::new(target.trim()));
    match kind.as_str() {
        "app" => {
            guard
                .approved_apps
                .retain(|item| normalize_exe_key(Path::new(item)) != norm_target);
        }
        "folder" => {
            guard
                .approved_folders
                .retain(|item| normalize_exe_key(Path::new(item)) != norm_target);
        }
        "web_domain" => {
            let domain_norm = target.trim().to_ascii_lowercase();
            guard
                .approved_domains
                .retain(|item| !item.eq_ignore_ascii_case(&domain_norm));
        }
        _ => return Err(format!("Unknown allowlist kind: {kind}")),
    }

    save_allowlist(&app, &guard)?;
    let _ = append_audit_entry(
        &app,
        "allowlist_removal",
        &format!("Removed {kind} from native allowlist"),
        target.trim(),
        "allowed",
        None,
    );
    Ok(guard.clone())
}

#[tauri::command]
pub fn desktop_get_audit_logs(app: AppHandle, limit: Option<usize>) -> Vec<DesktopAuditEntry> {
    read_recent_audit_entries(&app, limit.unwrap_or(100))
}

#[tauri::command]
pub fn desktop_get_system_status(app: AppHandle) -> Result<NativeHostTelemetry, String> {
    let perms = load_permissions(&app);
    if !perms.system_monitoring {
        let _ = append_audit_entry(
            &app,
            "systemMonitoring",
            "Blocked Windows telemetry read",
            "native_os_metrics",
            "denied",
            Some("systemMonitoring is OFF"),
        );
        return Err("systemMonitoring capability is OFF.".to_string());
    }

    let telemetry = collect_native_telemetry();
    let _ = append_audit_entry(
        &app,
        "systemMonitoring",
        "Read Windows native telemetry",
        &format!("{}/{}", telemetry.platform, telemetry.arch),
        "allowed",
        Some("Standard user privileges (asInvoker)"),
    );
    Ok(telemetry)
}

#[tauri::command]
pub fn desktop_open_app(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    executable_path: String,
) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.app_opening {
        let _ = append_audit_entry(
            &app,
            "appOpening",
            "Blocked application launch",
            &executable_path,
            "denied",
            Some("appOpening capability is OFF"),
        );
        return Err("appOpening capability is OFF.".to_string());
    }

    let canonical_exe = match validate_approved_exe_path(&executable_path) {
        Ok(p) => p,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "appOpening",
                "Blocked forbidden or invalid executable launch",
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
            "appOpening",
            "Blocked unapproved application launch",
            &canonical_exe.to_string_lossy(),
            "denied",
            Some("Executable not in Rust native allowlist"),
        );
        return Err("Application is not in the native desktop allowlist.".to_string());
    }

    // Launch canonical binary directly without a shell interpreter or arbitrary arguments.
    Command::new(&canonical_exe)
        .spawn()
        .map_err(|e| format!("Failed launching application: {e}"))?;

    let _ = append_audit_entry(
        &app,
        "appOpening",
        "Launched approved application",
        &canonical_exe.to_string_lossy(),
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_open_url(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    url: String,
) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.web_launch {
        let _ = append_audit_entry(
            &app,
            "webLaunch",
            "Blocked web page launch",
            &url,
            "denied",
            Some("webLaunch capability is OFF"),
        );
        return Err("webLaunch capability is OFF.".to_string());
    }

    let approved_domains = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        guard.approved_domains.clone()
    };

    let parsed = match validate_approved_https_url(&url, &approved_domains) {
        Ok(u) => u,
        Err(reason) => {
            let _ = append_audit_entry(
                &app,
                "webLaunch",
                "Blocked unsafe or unapproved URL launch",
                url.trim(),
                "denied",
                Some(&reason),
            );
            return Err(reason);
        }
    };

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("Failed opening URL: {e}"))?;

    let _ = append_audit_entry(
        &app,
        "webLaunch",
        "Launched approved HTTPS web page",
        parsed.as_str(),
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_search_files(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    folder_path: String,
    query: String,
) -> Result<Vec<FileSearchMatch>, String> {
    let perms = load_permissions(&app);
    if !perms.file_read {
        let _ = append_audit_entry(
            &app,
            "fileRead",
            "Blocked desktop file search",
            &folder_path,
            "denied",
            Some("fileRead capability is OFF"),
        );
        return Err("fileRead capability is OFF.".to_string());
    }

    let approved_folders = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        guard.approved_folders.clone()
    };

    let canonical_root = is_path_within_allowlist(Path::new(&folder_path), &approved_folders)?;
    let needle = query.trim().to_lowercase();
    let mut results = Vec::new();
    collect_files_bounded(&canonical_root, &needle, 0, &mut results);

    let _ = append_audit_entry(
        &app,
        "fileRead",
        "Searched approved folder",
        &canonical_root.to_string_lossy(),
        "allowed",
        Some(&format!("Query matched {} files", results.len())),
    );
    Ok(results)
}

fn collect_files_bounded(dir: &Path, needle: &str, depth: usize, out: &mut Vec<FileSearchMatch>) {
    if depth > 4 || out.len() >= 100 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 100 {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_files_bounded(&path, needle, depth + 1, out);
        } else if let Ok(meta) = entry.metadata() {
            let name = entry.file_name().to_string_lossy().to_string();
            if needle.is_empty() || name.to_lowercase().contains(needle) {
                out.push(FileSearchMatch {
                    name,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: meta.len(),
                });
            }
        }
    }
}

#[tauri::command]
pub fn desktop_organize_files(
    app: AppHandle,
    state: State<'_, DesktopAllowlistState>,
    folder_path: String,
    confirmed: bool,
) -> Result<OrganizePlanSummary, String> {
    let perms = load_permissions(&app);
    if !perms.file_write {
        let _ = append_audit_entry(
            &app,
            "fileWrite",
            "Blocked local file organization",
            &folder_path,
            "denied",
            Some("fileWrite capability is OFF"),
        );
        return Err("fileWrite capability is OFF.".to_string());
    }

    let approved_folders = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Allowlist state lock poisoned.".to_string())?;
        guard.approved_folders.clone()
    };

    let canonical_root = is_path_within_allowlist(Path::new(&folder_path), &approved_folders)?;
    if !confirmed {
        let _ = append_audit_entry(
            &app,
            "fileWrite",
            "Cancelled unconfirmed file organization",
            &canonical_root.to_string_lossy(),
            "cancelled",
            Some("Explicit confirmation is required before moving files"),
        );
        return Err("Explicit confirmation is required before modifying local files.".to_string());
    }

    let mut moved_count = 0usize;
    let mut skipped_count = 0usize;
    let mut details = Vec::new();

    let entries = fs::read_dir(&canonical_root)
        .map_err(|e| format!("Could not read target directory: {e}"))?;

    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("other")
            .to_lowercase();
        let category = match ext.as_str() {
            "pdf" | "docx" | "txt" | "md" => "Documents",
            "png" | "jpg" | "jpeg" | "webp" => "Images",
            "csv" | "xlsx" | "json" => "Data",
            _ => "Other",
        };
        let dest_dir = canonical_root.join(category);
        let _ = fs::create_dir_all(&dest_dir);
        let file_name = entry.file_name();
        let dest: PathBuf = dest_dir.join(&file_name);

        if dest.exists() {
            skipped_count += 1;
            continue;
        }

        if fs::rename(&src, &dest).is_ok() {
            moved_count += 1;
            if details.len() < 20 {
                details.push(format!(
                    "{} -> {}/{}",
                    file_name.to_string_lossy(),
                    category,
                    file_name.to_string_lossy()
                ));
            }
        } else {
            skipped_count += 1;
        }
    }

    let _ = append_audit_entry(
        &app,
        "fileWrite",
        "Organized files into category folders",
        &canonical_root.to_string_lossy(),
        "allowed",
        Some(&format!("Moved {moved_count} files, skipped {skipped_count}")),
    );

    Ok(OrganizePlanSummary {
        moved_count,
        skipped_count,
        details,
    })
}

#[tauri::command]
pub fn desktop_send_notification(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.notifications {
        let _ = append_audit_entry(
            &app,
            "notifications",
            "Blocked desktop notification",
            &title,
            "denied",
            Some("notifications capability is OFF"),
        );
        return Err("notifications capability is OFF.".to_string());
    }

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("Failed showing notification: {e}"))?;

    let _ = append_audit_entry(
        &app,
        "notifications",
        "Displayed desktop notification",
        &title,
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_sync_mic_tray(app: AppHandle, active: bool, wake_word_standby: bool) {
    update_tray_mic_indicator(&app, active, wake_word_standby);
}

#[tauri::command]
pub fn desktop_validate_shortcut_trigger(
    app: AppHandle,
    accelerator: String,
    action: String,
) -> Result<(), String> {
    let perms = load_permissions(&app);
    if !perms.configurable_shortcuts {
        let _ = append_audit_entry(
            &app,
            "configurableShortcuts",
            "Blocked shortcut trigger",
            &format!("{accelerator} -> {action}"),
            "denied",
            Some("configurableShortcuts capability is OFF"),
        );
        return Err("configurableShortcuts capability is OFF.".to_string());
    }

    if is_forbidden_shell_target(&accelerator) || is_forbidden_shell_target(&action) {
        let _ = append_audit_entry(
            &app,
            "configurableShortcuts",
            "Blocked unsafe shortcut trigger",
            &format!("{accelerator} -> {action}"),
            "denied",
            Some("Arbitrary shell targets are forbidden"),
        );
        return Err("Shortcut contains forbidden shell targets or characters.".to_string());
    }

    let _ = append_audit_entry(
        &app,
        "configurableShortcuts",
        "Triggered configured desktop shortcut",
        &format!("{accelerator} -> {action}"),
        "allowed",
        None,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_approved_https_url;

    #[test]
    fn rejects_url_bypasses_and_allows_exact_and_subdomains() {
        let domains = vec!["approved.com".to_string(), "docs.x.ai".to_string()];

        // Bypass attacks MUST fail
        assert!(validate_approved_https_url("https://evil.com\\.approved.com/", &domains).is_err());
        assert!(validate_approved_https_url("https://approved.com@evil.com/", &domains).is_err());
        assert!(validate_approved_https_url("http://approved.com/", &domains).is_err());
        assert!(validate_approved_https_url("javascript:alert(1)", &domains).is_err());
        assert!(validate_approved_https_url("file:///C:/Windows/win.ini", &domains).is_err());
        assert!(validate_approved_https_url("https://notapproved.com/", &domains).is_err());
        assert!(validate_approved_https_url("https://127.0.0.1/", &domains).is_err());

        // Exact & valid subdomains MUST pass
        assert!(validate_approved_https_url("https://approved.com/path", &domains).is_ok());
        assert!(validate_approved_https_url("https://sub.approved.com/path", &domains).is_ok());
        assert!(validate_approved_https_url("https://docs.x.ai/guides", &domains).is_ok());
    }
}
