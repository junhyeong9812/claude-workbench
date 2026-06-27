use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use core_lib::{DirEntry, ProjectType, WorkspaceState};
use tauri::{AppHandle, Manager};

use super::{io_message, AppError};

/// List the immediate children of `path`.
///
/// Thin wrapper over [`core_lib::list_dir`]: maps the I/O error to a user-safe
/// [`AppError`] (kind only — never the offending path). Returns `Err` (never
/// panics) if the path is missing, not a directory, or unreadable.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, AppError> {
    core_lib::list_dir(&path).map_err(|e| AppError::new(io_message("Cannot read directory", &e)))
}

/// Detect every project type present in a folder (badges). Infallible.
#[tauri::command]
pub fn detect_project_types(path: String) -> Vec<ProjectType> {
    core_lib::detect_project_types(path)
}

/// Detect per-tool build/test commands in a project dir (Cargo/npm/Gradle/...),
/// so the UI can offer one-click 빌드/테스트. Infallible.
#[tauri::command]
pub fn detect_run_targets(dir: String) -> Vec<core_lib::RunTarget> {
    core_lib::detect_run_targets(&dir)
}

/// The conventional mirror test-file path for a source file (None if the
/// language isn't supported). Path only — Claude generates the content there.
#[tauri::command]
pub fn mirror_test_path(src: String) -> Option<String> {
    core_lib::mirror_test_path(&src)
}

/// Hard cap on search results sent to the UI, to bound payload + walk time.
const SEARCH_LIMIT: usize = 500;

/// Project-wide file-name search under `root` (gitignore-aware). A query with
/// glob metacharacters (`*?[`) is matched as a glob, else as a case-insensitive
/// substring. Read-only and infallible (a bad query just yields no hits).
#[tauri::command]
pub fn search_files(root: String, query: String) -> Vec<core_lib::FileHit> {
    core_lib::search_files(&root, &query, SEARCH_LIMIT)
}

/// Project-wide content (grep) search under `root`: literal, case-insensitive,
/// gitignore-aware, binary files skipped. Read-only and infallible.
#[tauri::command]
pub fn search_content(root: String, query: String) -> Vec<core_lib::ContentHit> {
    core_lib::search_content(&root, &query, SEARCH_LIMIT)
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

/// Read a file's text, capped at `max_bytes` (default 5MB for the viewer; the
/// editor passes a smaller limit to decide editability). Refuses oversized files
/// rather than flooding the UI. Used by the timeline detail viewer, the file peek
/// viewer, and the editor.
#[tauri::command]
pub fn acp_read_file(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    const VIEW_MAX: u64 = 5 * 1024 * 1024;
    let max = max_bytes.unwrap_or(VIEW_MAX);
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))?;
    if meta.len() > max {
        return Err(AppError::new(format!("파일이 너무 큽니다 ({}KB 초과)", max / 1024)));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))
}

/// Process-unique suffix so two saves never race on a shared temp path.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Reject empty paths or any `..` parent-dir traversal (defense-in-depth on top
/// of the UI gates — a buggy/compromised renderer must not escape via `..`).
fn reject_unsafe_path(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::new("빈 경로입니다"));
    }
    if std::path::Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::new("'..' 가 포함된 경로는 허용되지 않습니다"));
    }
    Ok(())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    let p = std::path::Path::new(&path);
    let md = std::fs::symlink_metadata(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))?;
    if md.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    } else {
        std::fs::remove_file(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    }
}

/// Write `content` to `path` (editor save), **atomically**: write a temp file in
/// the same directory then `rename` over the target, so a crash / ENOSPC / I/O
/// error never leaves the original truncated or partial (codex P2 E1). Symlinks
/// are resolved first so we edit the link's *target* (like most editors), not
/// replace the link.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err(AppError::new("Cannot write: path is a directory"));
    }
    // Resolve to the real file (follow symlinks); fall back to the given path if
    // it doesn't exist yet (new file).
    let target = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| AppError::new("Cannot save file: no parent directory"))?;
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(
        ".{stem}.mt-save-{}-{}.tmp",
        std::process::id(),
        SAVE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| AppError::new(io_message("Cannot save file", &e)))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup on rename failure
        AppError::new(io_message("Cannot save file", &e))
    })
}

/// Create an empty file at `path` (tree "새 파일"). Parent directories are
/// created as needed (so a typed `sub/Foo.java` works). Errors if the path
/// already exists, so an existing file is never clobbered.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    let p = std::path::Path::new(&path);
    if p.exists() {
        return Err(AppError::new("이미 존재하는 경로입니다"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot create file", &e)))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
        .map(|_| ())
        .map_err(|e| AppError::new(io_message("Cannot create file", &e)))
}

/// Create a directory at `path` (tree "새 폴더"), including intermediate dirs —
/// so a typed `com/example/foo` (or `.`-separated, mapped to `/` by the UI)
/// makes the whole chain. Idempotent: an existing dir is not an error.
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    std::fs::create_dir_all(&path).map_err(|e| AppError::new(io_message("Cannot create folder", &e)))
}

/// Rename/move `from` to `to` (tree "이름 변경"). Errors if `to` already exists
/// (no overwrite). Parent dirs of `to` are created as needed.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), AppError> {
    reject_unsafe_path(&from)?;
    reject_unsafe_path(&to)?;
    let to_p = std::path::Path::new(&to);
    if to_p.exists() {
        return Err(AppError::new("대상 경로가 이미 존재합니다"));
    }
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot rename", &e)))?;
    }
    std::fs::rename(&from, to_p).map_err(|e| AppError::new(io_message("Cannot rename", &e)))
}
