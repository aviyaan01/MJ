mod audit;
mod credentials;
mod desktop_actions;
mod permissions;
mod system_monitor;
mod tray;

use permissions::{load_allowlist, DesktopAllowlistState};
use std::sync::Mutex;
use tauri::Manager;
use tray::{setup_system_tray, TrayState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TrayState {
            mic_status_item: Mutex::new(None),
        })
        .manage(DesktopAllowlistState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let persisted = load_allowlist(app.handle());
            if let Some(state) = app.try_state::<DesktopAllowlistState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = persisted;
                }
            }
            setup_system_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_actions::desktop_get_permissions,
            desktop_actions::desktop_set_permission,
            desktop_actions::desktop_revoke_all,
            desktop_actions::desktop_get_allowlist,
            desktop_actions::desktop_pick_and_approve_app,
            desktop_actions::desktop_pick_and_approve_folder,
            desktop_actions::desktop_approve_domain_native,
            desktop_actions::desktop_remove_allowlist_entry,
            desktop_actions::desktop_get_audit_logs,
            desktop_actions::desktop_get_system_status,
            desktop_actions::desktop_open_app,
            desktop_actions::desktop_open_url,
            desktop_actions::desktop_search_files,
            desktop_actions::desktop_organize_files,
            desktop_actions::desktop_send_notification,
            desktop_actions::desktop_sync_mic_tray,
            desktop_actions::desktop_validate_shortcut_trigger,
            credentials::desktop_store_credential,
            credentials::desktop_get_credential,
            credentials::desktop_delete_credential,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MJ Assistant desktop companion");
}
