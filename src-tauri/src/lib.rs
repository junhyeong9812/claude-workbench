mod commands;

/// Build and run the Tauri application.
///
/// Registers the dialog plugin (folder picker) and the four shell commands,
/// all of which are thin wrappers over the pure `core` crate.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(core_lib::SessionManager::new())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
