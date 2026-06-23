mod engine_host;
mod prefs;
mod recents;
mod tray;
mod update;

use recents::RecentEntry;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct AppState {
    pub data_dir: PathBuf,
    /// Extra physical width added while the sidebar is open (removed on close).
    pub sidebar_extra: Mutex<u32>,
    pub update: Mutex<Option<update::UpdateInfo>>,
    pub tray_playing: Arc<AtomicBool>,
    pub quitting: AtomicBool,
}

/// Show the window if hidden, hide it if visible (tray left-click behaviour).
pub fn toggle_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ---- Commands ----

#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn recents_get(state: State<AppState>) -> Vec<RecentEntry> {
    recents::get_recents(&state.data_dir)
}

#[tauri::command]
fn recents_put(state: State<AppState>, entry: RecentEntry) -> Vec<RecentEntry> {
    recents::put_recent(&state.data_dir, entry)
}

#[tauri::command]
fn recents_remove(state: State<AppState>, key: String) -> Vec<RecentEntry> {
    recents::remove_recent(&state.data_dir, &key)
}

#[tauri::command]
fn set_playing(state: State<AppState>, playing: bool) {
    state.tray_playing.store(playing, Ordering::SeqCst);
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

// Grow/shrink the window by ~20% when the sidebar opens/closes, so the existing
// content keeps its size (mirrors electron/main.ts setSidebarWindow).
#[tauri::command]
fn set_sidebar(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    open: bool,
) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let mut extra = state.sidebar_extra.lock().unwrap();
    if open {
        if *extra > 0 {
            return Ok(());
        }
        let monitor_w = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| m.size().width)
            .unwrap_or(size.width.saturating_mul(2));
        let add = (size.width as f64 * 0.2).round() as u32;
        let new_w = (size.width + add).min(monitor_w);
        if new_w <= size.width {
            return Ok(());
        }
        *extra = new_w - size.width;
        window
            .set_size(tauri::PhysicalSize::new(new_w, size.height))
            .map_err(|e| e.to_string())?;
    } else {
        if *extra == 0 {
            return Ok(());
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let min_w = (400.0 * scale).round() as u32;
        let new_w = size.width.saturating_sub(*extra).max(min_w);
        *extra = 0;
        window
            .set_size(tauri::PhysicalSize::new(new_w, size.height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let _ = std::fs::create_dir_all(&data_dir);

            app.manage(AppState {
                data_dir,
                sidebar_extra: Mutex::new(0),
                update: Mutex::new(None),
                tray_playing: Arc::new(AtomicBool::new(false)),
                quitting: AtomicBool::new(false),
            });

            engine_host::start(app.handle());
            tray::build_tray(app.handle())?;
            update::start_update_checks(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    // Keep running in the tray: hide instead of closing.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            recents_get,
            recents_put,
            recents_remove,
            set_playing,
            set_sidebar,
            quit_app,
            update::update_get,
            update::update_skip,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });
}
