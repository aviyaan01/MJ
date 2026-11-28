use chrono::Utc;
use serde::Serialize;
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub mount: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryStatus {
    pub percent: Option<u8>,
    pub charging: Option<bool>,
    pub remaining_seconds: Option<u32>,
    pub battery_saver_active: Option<bool>,
    pub source_note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryCpuRamStatus {
    pub cpu_model: String,
    pub cpu_cores: usize,
    pub cpu_usage_percent: f32,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_available_bytes: u64,
    pub memory_usage_percent: f32,
    pub battery: Option<BatteryStatus>,
    pub collected_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHostTelemetry {
    pub source: String,
    pub platform: String,
    pub os_release: String,
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: usize,
    pub cpu_usage_percent: f32,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_available_bytes: u64,
    pub memory_usage_percent: f32,
    pub uptime_seconds: u64,
    pub process_count: usize,
    pub storage: Vec<StorageEntry>,
    pub battery: Option<BatteryStatus>,
    pub network_connected: bool,
    pub admin_elevated: bool,
    pub collected_at: String,
}

#[cfg(windows)]
fn read_windows_battery() -> Option<BatteryStatus> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    let mut status = SYSTEM_POWER_STATUS {
        ACLineStatus: 255,
        BatteryFlag: 255,
        BatteryLifePercent: 255,
        SystemStatusFlag: 0,
        BatteryLifeTime: u32::MAX,
        BatteryFullLifeTime: u32::MAX,
    };

    let ok = unsafe { GetSystemPowerStatus(&mut status as *mut SYSTEM_POWER_STATUS) };
    if ok == 0 || status.BatteryFlag == 128 || status.BatteryLifePercent == 255 {
        return None;
    }

    let charging = match status.ACLineStatus {
        1 => Some(true),
        0 => Some(false),
        _ => None,
    };
    let remaining_seconds = if status.BatteryLifeTime != u32::MAX {
        Some(status.BatteryLifeTime)
    } else {
        None
    };

    Some(BatteryStatus {
        percent: Some(status.BatteryLifePercent.min(100)),
        charging,
        remaining_seconds,
        battery_saver_active: Some(status.SystemStatusFlag != 0),
        source_note: "Win32 GetSystemPowerStatus".to_string(),
    })
}

#[cfg(not(windows))]
fn read_windows_battery() -> Option<BatteryStatus> {
    None
}

pub fn collect_native_telemetry() -> NativeHostTelemetry {
    let mut sys = System::new_all();
    sys.refresh_cpu_usage();
    std::thread::sleep(std::time::Duration::from_millis(120));
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let cpu_model = cpus
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "CPU".to_string());
    let cpu_usage_percent = (sys.global_cpu_usage() * 10.0).round() / 10.0;

    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let mem_available = sys.available_memory();
    let mem_pct = if mem_total > 0 {
        (((mem_used as f64 / mem_total as f64) * 1000.0).round() / 10.0) as f32
    } else {
        0.0
    };

    let disks = Disks::new_with_refreshed_list();
    let storage = disks
        .iter()
        .map(|d| StorageEntry {
            mount: d.mount_point().to_string_lossy().to_string(),
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
        })
        .collect();

    let networks = Networks::new_with_refreshed_list();
    let network_connected = networks
        .iter()
        .any(|(name, _)| !name.to_lowercase().contains("loopback"));

    NativeHostTelemetry {
        source: "windows-tauri-os".to_string(),
        platform: std::env::consts::OS.to_string(),
        os_release: System::os_version().unwrap_or_else(|| "unknown".to_string()),
        arch: std::env::consts::ARCH.to_string(),
        cpu_model,
        cpu_cores: cpus.len(),
        cpu_usage_percent,
        memory_total_bytes: mem_total,
        memory_used_bytes: mem_used,
        memory_available_bytes: mem_available,
        memory_usage_percent: mem_pct,
        uptime_seconds: System::uptime(),
        process_count: sys.processes().len(),
        storage,
        battery: read_windows_battery(),
        network_connected,
        admin_elevated: false,
        collected_at: Utc::now().to_rfc3339(),
    }
}

pub fn collect_battery_cpu_ram_status() -> BatteryCpuRamStatus {
    let full = collect_native_telemetry();
    BatteryCpuRamStatus {
        cpu_model: full.cpu_model,
        cpu_cores: full.cpu_cores,
        cpu_usage_percent: full.cpu_usage_percent,
        memory_total_bytes: full.memory_total_bytes,
        memory_used_bytes: full.memory_used_bytes,
        memory_available_bytes: full.memory_available_bytes,
        memory_usage_percent: full.memory_usage_percent,
        battery: full.battery,
        collected_at: full.collected_at,
    }
}

#[cfg(test)]
mod tests {
    use super::collect_battery_cpu_ram_status;

    #[test]
    fn collects_battery_cpu_and_ram_metrics_cleanly() {
        let status = collect_battery_cpu_ram_status();
        assert!(status.cpu_cores >= 1);
        assert!(status.memory_total_bytes > 0);
        assert!(!status.collected_at.is_empty());
    }
}
