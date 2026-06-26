// ---- Terminal (PTY) commands ----
//
// The pure `SessionManager` (in `core`, tauri-free) owns the PTYs. These
// commands are thin wrappers; the only Tauri-specific glue is the relay thread
// in `terminal_create`, which forwards core output chunks to a webview event.

use std::sync::atomic::Ordering;
use std::thread;

use core_lib::SessionManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::{scrollback_dir, spawn_scrollback_flush, AppError, ScrollbackState, TerminalOutput};

/// Scrollback snapshot returned to a (re)attaching panel: recent raw bytes plus
/// the seq of the last chunk they cover (backfill contract — see core::session).
#[derive(Serialize)]
pub struct TerminalSnapshot {
    data: Vec<u8>,
    last_seq: u64,
}

/// Spawn a PTY (default shell unless `cmd` given) in `cwd` and start streaming
/// its output to the `terminal-output` event. Returns the session id. When
/// `persist_key` is given (opt-in), seed the scrollback from disk and flush it
/// back periodically so the panel restores its prior output after a restart.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    cmd: Option<Vec<String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    persist_key: Option<String>,
) -> Result<u64, AppError> {
    let seed = persist_key
        .as_ref()
        .and_then(|k| scrollback_dir(&app).and_then(|d| core_lib::scrollback_store::load(&d, k)));
    let id = mgr
        .create_seeded(cmd, cwd, cols, rows, seed)
        .map_err(AppError::new)?;
    let rx = mgr.subscribe(id).map_err(AppError::new)?;
    // Relay core output chunks -> webview event until the session is removed
    // (sender dropped -> recv errors -> thread ends; no leak).
    {
        let app = app.clone();
        thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                let _ = app.emit(
                    "terminal-output",
                    TerminalOutput {
                        session_id: id,
                        seq: chunk.seq,
                        data: chunk.bytes,
                    },
                );
            }
        });
    }
    if let Some(key) = persist_key {
        spawn_scrollback_flush(app, id, key);
    }
    Ok(id)
}

/// Send input bytes (keystrokes) to a session's PTY.
#[tauri::command]
pub fn terminal_write(
    mgr: State<'_, SessionManager>,
    id: u64,
    data: Vec<u8>,
) -> Result<(), AppError> {
    mgr.write(id, &data).map_err(AppError::new)
}

/// Resize a session's PTY (no-op for a 0 dimension; errors if unknown).
#[tauri::command]
pub fn terminal_resize(
    mgr: State<'_, SessionManager>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    mgr.resize(id, cols, rows).map_err(AppError::new)
}

/// Snapshot the scrollback for a (re)attaching panel.
#[tauri::command]
pub fn terminal_snapshot(
    mgr: State<'_, SessionManager>,
    id: u64,
) -> Result<TerminalSnapshot, AppError> {
    let (data, last_seq) = mgr.snapshot(id).map_err(AppError::new)?;
    Ok(TerminalSnapshot { data, last_seq })
}

/// Close a session: kill the PTY, join its reader thread, free resources
/// (panel-close path — spec §0.1).
#[tauri::command]
pub fn terminal_close(mgr: State<'_, SessionManager>, id: u64) -> Result<(), AppError> {
    mgr.remove(id).map_err(AppError::new)
}

/// Enable/disable scrollback disk persistence at runtime (the global opt-in
/// toggle). Affects already-running flushers, not just new sessions (P4-R3).
#[tauri::command]
pub fn scrollback_set_enabled(state: State<'_, ScrollbackState>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}
