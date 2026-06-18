mod commands;

/// Build and run the Tauri application.
///
/// Registers the dialog plugin (folder picker) and the four shell commands,
/// all of which are thin wrappers over the pure `core` crate.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_dir,
            commands::detect_project_type,
            commands::save_state,
            commands::load_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
