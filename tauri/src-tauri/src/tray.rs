// System tray (mirrors the Electron tray): a template icon, a context menu
// (Show Window / About / Quit), left-click toggles the window, and an animated
// sound-wave icon while audio is playing.
use crate::{toggle_window, AppState};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");
const TRAY_ID: &str = "main-tray";

fn default_icon() -> Image<'static> {
    Image::from_bytes(TRAY_ICON_PNG).expect("valid tray icon png")
}

// A 22x22 RGBA frame of three sound-wave bars (black on transparent → renders
// correctly as a macOS template image). Heights cycle to animate.
fn anim_frame(frame: usize) -> Image<'static> {
    let w: u32 = 22;
    let h: u32 = 22;
    let heights = [[4i32, 8, 4], [6, 4, 8], [8, 6, 4], [4, 8, 6]][frame % 4];
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let bars_x = [5usize, 10, 15];
    for (i, &bx) in bars_x.iter().enumerate() {
        let half = heights[i];
        let top = (11 - half).max(0);
        let bottom = (11 + half).min(h as i32);
        for y in top..bottom {
            for x in bx..(bx + 3).min(w as usize) {
                let idx = ((y as u32 * w + x as u32) * 4) as usize;
                buf[idx] = 0;
                buf[idx + 1] = 0;
                buf[idx + 2] = 0;
                buf[idx + 3] = 255;
            }
        }
    }
    Image::new_owned(buf, w, h)
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About Out Loud", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep1, &about, &sep2, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(default_icon())
        .icon_as_template(true)
        .tooltip("Out Loud - Ready")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window_show(app),
            "about" => {
                let _ = app.opener().open_url("https://www.out-loud.io", None::<&str>);
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(&tray.app_handle().clone());
            }
        })
        .build(app)?;

    start_animation(app.clone());
    Ok(())
}

fn toggle_window_show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Background loop that animates the tray icon while playback is active. Icon
// updates are dispatched to the main thread for cross-platform safety.
fn start_animation(app: AppHandle) {
    std::thread::spawn(move || {
        let playing_flag = app.state::<AppState>().tray_playing.clone();
        let mut frame = 0usize;
        let mut was_playing = false;
        loop {
            let playing = playing_flag.load(Ordering::SeqCst);
            if playing {
                frame = frame.wrapping_add(1);
                let img = anim_frame(frame);
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(tray) = app2.tray_by_id(TRAY_ID) {
                        let _ = tray.set_icon(Some(img));
                        let _ = tray.set_tooltip(Some("Out Loud - Playing"));
                    }
                });
                was_playing = true;
                std::thread::sleep(Duration::from_millis(200));
            } else {
                if was_playing {
                    was_playing = false;
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(tray) = app2.tray_by_id(TRAY_ID) {
                            let _ = tray.set_icon(Some(default_icon()));
                            let _ = tray.set_tooltip(Some("Out Loud - Ready"));
                        }
                    });
                }
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    });
}
