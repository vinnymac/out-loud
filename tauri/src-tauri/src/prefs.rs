// Persisted shell preferences (mirrors electron/store.ts): the skipped update
// version, last update check time, and a stable anonymous install id used only
// to de-dupe sessions in analytics (an opaque random UUID — no PII).
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppPrefs {
    #[serde(default, rename = "skippedVersion")]
    pub skipped_version: Option<String>,
    #[serde(default, rename = "lastCheckAt")]
    pub last_check_at: u64,
    #[serde(default, rename = "installId")]
    pub install_id: Option<String>,
}

fn prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("preferences.json")
}

pub fn get_prefs(data_dir: &Path) -> AppPrefs {
    match fs::read_to_string(prefs_path(data_dir)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => AppPrefs::default(),
    }
}

pub fn set_prefs(data_dir: &Path, prefs: &AppPrefs) {
    let _ = fs::create_dir_all(data_dir);
    if let Ok(s) = serde_json::to_string_pretty(prefs) {
        let _ = fs::write(prefs_path(data_dir), s);
    }
}

pub fn get_or_create_install_id(data_dir: &Path) -> String {
    let mut p = get_prefs(data_dir);
    if let Some(id) = &p.install_id {
        return id.clone();
    }
    let id = uuid::Uuid::new_v4().to_string();
    p.install_id = Some(id.clone());
    set_prefs(data_dir, &p);
    id
}
