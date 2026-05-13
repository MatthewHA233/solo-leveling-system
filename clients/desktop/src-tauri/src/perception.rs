#[cfg(windows)]
#[path = "perception_windows.rs"]
mod platform;

#[cfg(windows)]
pub use platform::*;

#[cfg(not(windows))]
mod platform {
    #![allow(dead_code)]

    use std::path::PathBuf;
    use std::sync::Arc;

    use serde::{Deserialize, Serialize};

    use crate::db::Database;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ScreenshotSettings {
        pub enabled: bool,
        pub interval_seconds: u64,
        pub capture_target: String,
        pub format: String,
        pub quality: u8,
        pub resolution_percent: u8,
        pub save_dir: String,
        pub retention_mode: String,
        pub max_size_mb: u64,
        pub retention_days: u64,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ScreenshotStorageInfo {
        pub path: String,
        pub size_bytes: u64,
        pub file_count: u64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TrackingSettings {
        pub afk_after_minutes: u32,
        pub idle_after_seconds: u32,
        pub min_activity_seconds: u32,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WindowBlacklistEntry {
        pub app: String,
        pub title: Option<String>,
        pub created_at: String,
    }

    impl Default for ScreenshotSettings {
        fn default() -> Self {
            Self {
                enabled: false,
                interval_seconds: 60,
                capture_target: "active_window".to_string(),
                format: "jpg".to_string(),
                quality: 50,
                resolution_percent: 100,
                save_dir: default_screenshot_dir().to_string_lossy().into_owned(),
                retention_mode: "days".to_string(),
                max_size_mb: 2048,
                retention_days: 7,
            }
        }
    }

    impl Default for TrackingSettings {
        fn default() -> Self {
            Self {
                afk_after_minutes: 3,
                idle_after_seconds: 60,
                min_activity_seconds: 5,
            }
        }
    }

    pub async fn run_window_watcher(_db: Arc<Database>) {}

    pub async fn run_status_watcher(_db: Arc<Database>) {}

    pub async fn run_screenshot_watcher() {}

    pub async fn refresh_app_colors_from_icons(_db: Arc<Database>) {}

    pub fn find_screenshot_near(_date: &str, _time_str: &str) -> Option<PathBuf> {
        None
    }

    pub fn load_screenshot_settings() -> ScreenshotSettings {
        ScreenshotSettings::default()
    }

    pub fn save_screenshot_settings(
        settings: ScreenshotSettings,
    ) -> Result<ScreenshotSettings, String> {
        Ok(settings)
    }

    pub fn screenshot_storage_info() -> Result<ScreenshotStorageInfo, String> {
        let path = default_screenshot_dir();
        Ok(ScreenshotStorageInfo {
            path: path.to_string_lossy().into_owned(),
            size_bytes: 0,
            file_count: 0,
        })
    }

    pub fn open_screenshot_folder() -> Result<(), String> {
        Ok(())
    }

    pub fn clear_screenshot_data() -> Result<ScreenshotStorageInfo, String> {
        screenshot_storage_info()
    }

    pub fn load_window_blacklist() -> Vec<WindowBlacklistEntry> {
        Vec::new()
    }

    pub fn add_window_blacklist(
        app: String,
        title: Option<String>,
    ) -> Result<Vec<WindowBlacklistEntry>, String> {
        Ok(vec![WindowBlacklistEntry {
            app,
            title,
            created_at: String::new(),
        }])
    }

    pub fn remove_window_blacklist(
        _app: String,
        _title: Option<String>,
    ) -> Result<Vec<WindowBlacklistEntry>, String> {
        Ok(Vec::new())
    }

    pub fn load_tracking_settings() -> TrackingSettings {
        TrackingSettings::default()
    }

    pub fn save_tracking_settings(settings: TrackingSettings) -> Result<TrackingSettings, String> {
        Ok(settings)
    }

    fn default_screenshot_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("solo-leveling-system")
            .join("Screenshots")
    }
}

#[cfg(not(windows))]
pub use platform::*;
