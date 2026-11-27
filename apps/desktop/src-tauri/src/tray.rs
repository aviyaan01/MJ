use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

pub struct TrayState {
    pub mic_status_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

pub fn setup_system_tray(app: &AppHandle) -> tauri::Result<()> {
    let mic_item = MenuItem::with_id(app, "mic_status", "Microphone: Off", false, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", "Open MJ Assistant", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&mic_item, &show_item, &quit_item])?;

    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut guard) = state.mic_status_item.lock() {
            *guard = Some(mic_item.clone());
        }
    }

    let _tray = TrayIconBuilder::with_id("mj-tray")
        .menu(&menu)
        .tooltip("MJ Assistant — Microphone: Off")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn update_tray_mic_indicator(app: &AppHandle, active: bool, wake_word_standby: bool) {
    let label = if active && wake_word_standby {
        "Microphone: ACTIVE (Wake-Word Standby)"
    } else if active {
        "Microphone: ACTIVE (Live Voice)"
    } else {
        "Microphone: Off"
    };

    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(guard) = state.mic_status_item.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_text(label);
            }
        }
    }

    if let Some(tray) = app.tray_by_id("mj-tray") {
        let _ = tray.set_tooltip(Some(&format!("MJ Assistant — {label}")));
    }
}
