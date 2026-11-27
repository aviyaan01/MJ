use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuditEntry {
    pub timestamp: String,
    pub capability: String,
    pub action: String,
    pub target: String,
    pub outcome: String,
    pub source: String,
    pub detail: Option<String>,
}

fn audit_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Could not resolve local data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating local data dir: {e}"))?;
    Ok(dir.join("privileged_audit.jsonl"))
}

pub fn append_audit_entry(
    app: &AppHandle,
    capability: &str,
    action: &str,
    target: &str,
    outcome: &str,
    detail: Option<&str>,
) -> Result<DesktopAuditEntry, String> {
    let entry = DesktopAuditEntry {
        timestamp: Utc::now().to_rfc3339(),
        capability: capability.to_string(),
        action: action.to_string(),
        target: target.chars().take(240).collect(),
        outcome: outcome.to_string(),
        source: "desktop-tauri".to_string(),
        detail: detail.map(|d| d.chars().take(400).collect()),
    };

    let path = audit_file_path(app)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed opening audit log: {e}"))?;

    let line = serde_json::to_string(&entry).map_err(|e| format!("Serialize audit error: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed writing audit log: {e}"))?;

    Ok(entry)
}

pub fn read_recent_audit_entries(app: &AppHandle, limit: usize) -> Vec<DesktopAuditEntry> {
    let Ok(path) = audit_file_path(app) else {
        return Vec::new();
    };
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };

    let reader = BufReader::new(file);
    let mut entries: Vec<DesktopAuditEntry> = reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<DesktopAuditEntry>(&line).ok())
        .collect();

    entries.reverse();
    entries.truncate(limit.min(500));
    entries
}
