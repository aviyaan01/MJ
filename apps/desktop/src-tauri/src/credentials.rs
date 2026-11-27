use keyring::Entry;

const SERVICE_NAME: &str = "com.mjassistant.desktop";

fn is_allowed_credential_key(key: &str) -> bool {
    matches!(key, "app_access_passcode" | "desktop_session_note")
}

#[tauri::command]
pub fn desktop_store_credential(key: String, value: String) -> Result<(), String> {
    if !is_allowed_credential_key(&key) {
        return Err("Credential key is not in the desktop store allowlist.".to_string());
    }
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Could not access OS credential store: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Failed storing credential in OS keyring: {e}"))
}

#[tauri::command]
pub fn desktop_get_credential(key: String) -> Result<Option<String>, String> {
    if !is_allowed_credential_key(&key) {
        return Err("Credential key is not in the desktop store allowlist.".to_string());
    }
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Could not access OS credential store: {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed reading credential from OS keyring: {e}")),
    }
}

#[tauri::command]
pub fn desktop_delete_credential(key: String) -> Result<(), String> {
    if !is_allowed_credential_key(&key) {
        return Err("Credential key is not in the desktop store allowlist.".to_string());
    }
    let entry = Entry::new(SERVICE_NAME, &key)
        .map_err(|e| format!("Could not access OS credential store: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed deleting credential from OS keyring: {e}")),
    }
}
