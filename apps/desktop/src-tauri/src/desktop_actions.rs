use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::audit::{append_audit_entry, read_recent_audit_entries, DesktopAuditEntry};
use crate::permissions::{
    is_forbidden_shell_target, is_path_within_allowlist, load_permissions,
    revoke_all_permissions, set_single_permission, DesktopPermissions,
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
    executable_path: String,
    approved_apps: Vec<String>,
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

    if is_forbidden_shell_target(&executable_path) {
        let _ = append_audit_entry(
            &app,
            "appOpening",
            "Blocked shell interpreter launch",
            &executable_path,
            "denied",
            Some("Arbitrary shell execution is strictly forbidden"),
        );
        return Err("Shell interpreters and metacharacters are forbidden.".to_string());
    }

    let candidate_norm = executable_path.trim().replace('\\', "/").to_lowercase();
    let is_approved = approved_apps
        .iter()
        .any(|item| item.trim().replace('\\', "/").to_lowercase() == candidate_norm);

    if !is_approved {
        let _ = append_audit_entry(
            &app,
            "appOpening",
            "Blocked unapproved application launch",
            &executable_path,
            "denied",
            Some("Executable not in user allowlist"),
        );
        return Err("Application is not in the user allowlist.".to_string());
    }

    // Launch binary directly without a shell interpreter or arbitrary arguments.
    Command::new(executable_path.trim())
        .spawn()
        .map_err(|e| format!("Failed launching application: {e}"))?;

    let _ = append_audit_entry(
        &app,
        "appOpening",
        "Launched approved application",
        &executable_path,
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_open_url(
    app: AppHandle,
    url: String,
    approved_domains: Vec<String>,
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

    let trimmed = url.trim();
    if !trimmed.starts_with("https://") {
        let _ = append_audit_entry(
            &app,
            "webLaunch",
            "Blocked non-HTTPS web launch",
            trimmed,
            "denied",
            Some("Only HTTPS URLs are allowed"),
        );
        return Err("Only HTTPS URLs are permitted.".to_string());
    }

    let host = trimmed
        .trim_start_matches("https://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_lowercase();

    let domain_ok = approved_domains.iter().any(|d| {
        let dl = d.trim().to_lowercase();
        host == dl || host.ends_with(&format!(".{dl}"))
    });

    if !domain_ok {
        let _ = append_audit_entry(
            &app,
            "webLaunch",
            "Blocked unapproved domain launch",
            trimmed,
            "denied",
            Some("Domain not in user allowlist"),
        );
        return Err("Domain is not in the user web allowlist.".to_string());
    }

    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| format!("Failed opening URL: {e}"))?;

    let _ = append_audit_entry(
        &app,
        "webLaunch",
        "Launched approved HTTPS web page",
        trimmed,
        "allowed",
        None,
    );
    Ok(())
}

#[tauri::command]
pub fn desktop_search_files(
    app: AppHandle,
    folder_path: String,
    query: String,
    approved_folders: Vec<String>,
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
    folder_path: String,
    approved_folders: Vec<String>,
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
