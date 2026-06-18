//! Tauri commands: thin wrappers over the pure `core_lib` crate.
//!
//! Error policy: every fallible command returns `Result<_, AppError>`. We never
//! panic, and error messages are deliberately generic (an error *kind*, never
//! the offending path or an OS-level message) so internal filesystem details
//! and stack information are not leaked to the UI.

use std::io;
use std::path::PathBuf;

use core_lib::{ProjectType, WorkspaceState};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// A single, consistent error type shared by all commands.
#[derive(Debug, Serialize)]
pub struct AppError {
    message: String,
}

impl AppError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Map an I/O error to a user-safe message based only on its *kind*.
fn io_message(action: &str, err: &io::Error) -> String {
    let reason = match err.kind() {
        io::ErrorKind::NotFound => "path not found",
        io::ErrorKind::PermissionDenied => "permission denied",
        io::ErrorKind::NotADirectory => "not a directory",
        _ => "I/O error",
    };
    format!("{action}: {reason}")
}

/// One entry in a directory listing, sent to the webview.
#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// List the immediate children of `path`.
///
/// Returns `Err` (never panics) if the path is missing, not a directory, or
/// unreadable. Directories are listed before files; each group is sorted by
/// name (case-insensitive).
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, AppError> {
    let read = std::fs::read_dir(&path)
        .map_err(|e| AppError::new(io_message("Cannot read directory", &e)))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| AppError::new(io_message("Cannot read entry", &e)))?;
        // Resolve type without following symlinks into errors we can't recover.
        let is_dir = match item.file_type() {
            Ok(ft) => ft.is_dir(),
            Err(_) => false,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let child_path = item.path().to_string_lossy().into_owned();
        entries.push(DirEntry {
            name,
            path: child_path,
            is_dir,
        });
    }

    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        other => other,
    });

    Ok(entries)
}

/// Detect the project type of a folder (badge). Infallible.
#[tauri::command]
pub fn detect_project_type(path: String) -> ProjectType {
    core_lib::detect_project_type(path)
}

/// Resolve the on-disk path of the workspace state file inside the app's
/// config directory.
fn state_file(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| AppError::new("Cannot resolve application config directory"))?;
    Ok(dir.join("workspace.json"))
}

/// Persist the workspace state to the app config directory.
#[tauri::command]
pub fn save_state(app: AppHandle, state: WorkspaceState) -> Result<(), AppError> {
    let path = state_file(&app)?;
    core_lib::save_state(&state, &path)
        .map_err(|e| AppError::new(io_message("Cannot save workspace state", &e)))
}

/// Load the workspace state. A missing or corrupt file yields the default
/// (empty) state, so this command never fails.
#[tauri::command]
pub fn load_state(app: AppHandle) -> WorkspaceState {
    match state_file(&app) {
        Ok(path) => core_lib::load_state(path),
        Err(_) => WorkspaceState::default(),
    }
}
