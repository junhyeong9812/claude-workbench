// ---- Session archive (관찰 → 아카이브 전환) ----
//
// "종료(아카이브)" copies the session's JSONL transcript verbatim, normalizes it
// into a versioned JSON document, and renders a self-contained book.html — all
// under the archive root (workspace-configurable, default <app_data_dir>/archive).
// The source transcript under ~/.claude/projects is read, never modified.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{io_message, AppError};

/// Where an archive landed, for the UI to confirm/open.
#[derive(Serialize)]
pub struct ArchiveResult {
    pub dir: String,
    pub book_path: String,
    /// Whether a previous archive of this session was replaced (re-archive).
    pub replaced: bool,
}

/// The effective archive root: the workspace-configured directory when set and
/// non-blank, else `<app_data_dir>/archive`.
fn archive_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let configured = super::load_state(app.clone()).archive_root;
    if let Some(root) = configured {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("archive"))
        .map_err(|_| AppError::new("Cannot resolve app data directory"))
}

/// Archive session `uuid` (rooted at `cwd`): read its JSONL fresh, normalize,
/// and write `session.jsonl` + `normalized.json` + `book.html` under the archive
/// root. Blocking work (file IO + full-transcript parse) runs on the blocking
/// pool so the webview stays responsive.
#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<ArchiveResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || archive_session_blocking(app, cwd, uuid))
        .await
        .map_err(|_| AppError::new("Archive task failed to run"))?
}

fn archive_session_blocking(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<ArchiveResult, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let projects_root = core_lib::jsonl::claude_projects_root()
        .ok_or_else(|| AppError::new("Cannot resolve Claude projects root"))?;
    let jsonl_path = core_lib::jsonl::find_session_jsonl(&projects_root, &uuid)
        .ok()
        .flatten()
        .ok_or_else(|| AppError::new("Session transcript not found"))?;
    let jsonl_bytes = std::fs::read(&jsonl_path)
        .map_err(|e| AppError::new(io_message("Cannot read transcript", &e)))?;
    let jsonl_text = String::from_utf8_lossy(&jsonl_bytes);

    // Title: the AI-generated `.title` sidecar when present, else the display
    // name — the archive folder slug derives from it.
    let title = core_lib::snapshot::read_title(&base, &cwd, &uuid)
        .or_else(|| core_lib::snapshot::read_name(&base, &cwd, &uuid))
        .unwrap_or_else(|| "Claude".to_string());
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();

    let session = core_lib::archive::normalize(&cwd, &uuid, &title, &date, &jsonl_text);
    if session.turns.is_empty() {
        return Err(AppError::new("아카이브할 대화가 없습니다"));
    }

    let root = archive_root(&app)?;
    let out = core_lib::archive::write_archive(&root, &cwd, &session, &jsonl_bytes)
        .map_err(|e| AppError::new(io_message("Cannot write archive", &e)))?;
    Ok(ArchiveResult {
        dir: out.dir.to_string_lossy().to_string(),
        book_path: out.book_path.to_string_lossy().to_string(),
        replaced: out.replaced,
    })
}
