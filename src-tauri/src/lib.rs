mod commands;

/// On Linux, align `GTK_IM_MODULE` with the input-method daemon that is actually
/// running before GTK initializes.
///
/// Why: a common desktop misconfiguration leaves `GTK_IM_MODULE=fcitx` in the
/// environment while `ibus` is the daemon actually running (or vice-versa).
/// WebKitGTK then loads an IM module that can't connect to any daemon, so CJK
/// (e.g. Hangul) composition silently fails in the webview even though it works
/// elsewhere. We detect the running daemon and override the IM env to match.
/// This only mutates *our* process environment, so the rest of the desktop is
/// untouched. Must run before any GTK init (GTK reads `GTK_IM_MODULE` once).
#[cfg(target_os = "linux")]
fn align_ime_module() {
    use std::fs;

    // Find the running IM daemon by scanning `/proc/<pid>/comm`.
    let mut daemon: Option<&str> = None;
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Ok(comm) = fs::read_to_string(entry.path().join("comm")) {
                match comm.trim() {
                    "ibus-daemon" => {
                        daemon = Some("ibus");
                        break;
                    }
                    "fcitx5" | "fcitx" => {
                        daemon = Some("fcitx");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    // Only override when the configured module disagrees with reality.
    if let Some(module) = daemon {
        let current = std::env::var("GTK_IM_MODULE").unwrap_or_default();
        if current != module {
            eprintln!("[ime] running daemon is {module}; GTK_IM_MODULE was '{current}' -> '{module}'");
            std::env::set_var("GTK_IM_MODULE", module);
            std::env::set_var("QT_IM_MODULE", module);
            std::env::set_var("XMODIFIERS", format!("@im={module}"));
        }
    }
}

/// Build and run the Tauri application.
///
/// Registers the dialog plugin (folder picker) and the shell + terminal + ACP
/// commands, all thin wrappers over the `core`/`core-acp` crates.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    align_ime_module();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(core_lib::SessionManager::new())
        .manage(commands::AcpState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_dir,
            commands::detect_project_types,
            commands::save_state,
            commands::load_state,
            commands::terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_snapshot,
            commands::terminal_close,
            commands::acp_start,
            commands::acp_prompt,
            commands::acp_alive,
            commands::acp_respond,
            commands::acp_cancel,
            commands::acp_close,
            commands::acp_sessions,
            commands::acp_session_timeline,
            commands::acp_read_file,
            commands::acp_delete_session,
            commands::acp_rename_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
