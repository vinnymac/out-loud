// In-app update notice (mirrors electron/update-check.ts). Polls GitHub's
// "latest release" and, when it's newer than the running version, surfaces an
// "update available" notice with a direct download link for this platform.
// Best-effort: any network failure is swallowed (offline-first).
use crate::prefs;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const RELEASES_API: &str =
    "https://api.github.com/repos/light-cloud-com/out-loud/releases/latest";
const RELEASES_URL: &str = "https://github.com/light-cloud-com/out-loud/releases/latest";
const POLL_INTERVAL_SECS: u64 = 6 * 60 * 60;

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub latest: String,
    #[serde(rename = "notesUrl")]
    pub notes_url: String,
    #[serde(rename = "downloadUrl")]
    pub download_url: String,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

fn parse_version(v: &str) -> Vec<i64> {
    v.trim_start_matches(['v', 'V'])
        .split('.')
        .map(|n| n.parse::<i64>().unwrap_or(0))
        .collect()
}

/// -1 if a < b, 0 if equal, 1 if a > b
fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = parse_version(a);
    let pb = parse_version(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let da = *pa.get(i).unwrap_or(&0);
        let db = *pb.get(i).unwrap_or(&0);
        if da > db {
            return 1;
        }
        if da < db {
            return -1;
        }
    }
    0
}

fn pick_asset(assets: &[GithubAsset]) -> String {
    let is_arm = std::env::consts::ARCH == "aarch64";
    let ext = match std::env::consts::OS {
        "macos" => ".dmg",
        "windows" => ".exe",
        _ => ".AppImage",
    };
    let candidates: Vec<&GithubAsset> = assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(ext))
        .collect();
    let matched = candidates.iter().find(|a| {
        let arm = a.name.to_lowercase().contains("arm64");
        if is_arm {
            arm
        } else {
            !arm
        }
    });
    matched
        .or(candidates.first())
        .map(|a| a.browser_download_url.clone())
        .unwrap_or_default()
}

async fn fetch_latest_release() -> Option<GithubRelease> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("out-loud-app")
        .build()
        .ok()?;
    let res = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json::<GithubRelease>().await.ok()
}

fn compute_update(
    release: &GithubRelease,
    current_version: &str,
    skipped: &Option<String>,
) -> Option<UpdateInfo> {
    let tag = release.tag_name.clone()?;
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    if compare_versions(&latest, current_version) <= 0 {
        return None;
    }
    if let Some(s) = skipped {
        if compare_versions(&latest, s) <= 0 {
            return None;
        }
    }
    let notes_url = release.html_url.clone().unwrap_or_else(|| RELEASES_URL.to_string());
    let download = pick_asset(&release.assets);
    Some(UpdateInfo {
        available: true,
        latest,
        notes_url: notes_url.clone(),
        download_url: if download.is_empty() { notes_url } else { download },
    })
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().data_dir.clone()
}

async fn refresh(app: &AppHandle) {
    let current = app.package_info().version.to_string();
    let dd = data_dir(app);
    let release = fetch_latest_release().await;
    // Record the check time regardless of outcome.
    let mut p = prefs::get_prefs(&dd);
    p.last_check_at = now_ms();
    prefs::set_prefs(&dd, &p);

    let Some(release) = release else { return };
    let computed = compute_update(&release, &current, &p.skipped_version);
    {
        let state = app.state::<AppState>();
        *state.update.lock().unwrap() = computed.clone();
    }
    let _ = app.emit("update-available", computed);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn start_update_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            refresh(&app).await;
            tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    });
}

#[tauri::command]
pub fn update_get(state: tauri::State<AppState>) -> Option<UpdateInfo> {
    state.update.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_skip(app: AppHandle, version: String) -> Option<UpdateInfo> {
    let dd = data_dir(&app);
    let mut p = prefs::get_prefs(&dd);
    p.skipped_version = Some(version.clone());
    prefs::set_prefs(&dd, &p);
    let state = app.state::<AppState>();
    let mut cached = state.update.lock().unwrap();
    if let Some(info) = cached.as_ref() {
        if compare_versions(&info.latest, &version) <= 0 {
            *cached = None;
        }
    }
    cached.clone()
}
