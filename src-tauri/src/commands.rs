//! Tauri commands: thin wrappers over the pure `core_lib` crate.
//!
//! Error policy: every fallible command returns `Result<_, AppError>`. We never
//! panic, and error messages are deliberately generic (an error *kind*, never
//! the offending path or an OS-level message) so internal filesystem details
//! and stack information are not leaked to the UI.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use core_acp::{AcpEvent, AcpHost};
use core_lib::{DirEntry, ProjectType, SessionManager, WorkspaceState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

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

// ---- Terminal (PTY) commands ----
//
// The pure `SessionManager` (in `core`, tauri-free) owns the PTYs. These
// commands are thin wrappers; the only Tauri-specific glue is the relay thread
// in `terminal_create`, which forwards core output chunks to a webview event.

/// One chunk of PTY output, emitted as the `terminal-output` event. `data` is
/// raw bytes (serialized as a JSON byte array); the frontend feeds it to xterm.
#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: u64,
    seq: u64,
    data: Vec<u8>,
}

/// Scrollback snapshot returned to a (re)attaching panel: recent raw bytes plus
/// the seq of the last chunk they cover (backfill contract — see core::session).
#[derive(Serialize)]
pub struct TerminalSnapshot {
    data: Vec<u8>,
    last_seq: u64,
}

/// Spawn a PTY (default shell unless `cmd` given) in `cwd` and start streaming
/// its output to the `terminal-output` event. Returns the session id.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    cmd: Option<Vec<String>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, AppError> {
    let id = mgr.create(cmd, cwd, cols, rows).map_err(AppError::new)?;
    let rx = mgr.subscribe(id).map_err(AppError::new)?;
    // Relay core output chunks -> webview event until the session is removed
    // (sender dropped -> recv errors -> thread ends; no leak).
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

// ---- ACP (Claude) commands ----
//
// The `core_acp::AcpHost` owns the adapter subprocess + its `!Send` connection
// on a dedicated thread (async island — design D1). These commands are thin
// wrappers over the host's `Send` handle; the only Tauri glue is the relay
// thread in `acp_start`, which forwards host events to the `acp-event` webview
// event (mirroring the PTY `terminal-output` relay).

/// Managed state: one [`AcpHost`] per Claude panel, keyed by a monotonic id.
#[derive(Default)]
pub struct AcpState {
    hosts: Mutex<HashMap<u64, AcpHost>>,
    next_id: AtomicU64,
}

/// A host event tagged with its panel id, emitted as the `acp-event` event.
/// `event` is flattened, so the payload is `{ id, type, ... }`.
#[derive(Clone, Serialize)]
struct AcpEventPayload {
    id: u64,
    #[serde(flatten)]
    event: AcpEvent,
}

fn acp_lock<'a>(
    state: &'a State<'_, AcpState>,
) -> Result<std::sync::MutexGuard<'a, HashMap<u64, AcpHost>>, AppError> {
    state
        .hosts
        .lock()
        .map_err(|_| AppError::new("ACP state unavailable"))
}

/// Spawn the Claude adapter rooted at `cwd` (the active project) and start
/// relaying its events. Returns the panel id used by the other ACP commands.
#[tauri::command]
pub fn acp_start(
    app: AppHandle,
    state: State<'_, AcpState>,
    cwd: Option<String>,
    resume: Option<String>,
    start_turn: Option<u64>,
) -> Result<u64, AppError> {
    // Claude must be rooted at the session root; refuse rather than guess.
    let cwd =
        PathBuf::from(cwd.ok_or_else(|| AppError::new("Claude requires an active project"))?);
    let project = cwd.to_string_lossy().to_string();

    let (ev_tx, ev_rx) = std::sync::mpsc::channel::<AcpEvent>();
    let host = AcpHost::spawn(cwd, ev_tx, resume, start_turn.unwrap_or(0))
        .map_err(|e| AppError::new(io_message("Cannot start Claude", &e)))?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Relay host events -> webview until the host thread ends (sender dropped
    // -> recv errors -> loop exits; no leak). `Disconnected` is the last event
    // sent before the sender drops. Timeline events are also persisted (S3b).
    // On exit we drop the now-dead handle from state so later commands on `id`
    // fail loudly instead of silently no-op'ing.
    let app = app.clone();
    thread::spawn(move || {
        while let Ok(event) = ev_rx.recv() {
            persist_event(&app, &project, &event);
            let _ = app.emit("acp-event", AcpEventPayload { id, event });
        }
        if let Some(state) = app.try_state::<AcpState>() {
            if let Ok(mut hosts) = state.hosts.lock() {
                hosts.remove(&id);
            }
        }
    });

    acp_lock(&state)?.insert(id, host);
    Ok(id)
}

/// Queue a prompt to a Claude session.
#[tauri::command]
pub fn acp_prompt(state: State<'_, AcpState>, id: u64, text: String) -> Result<(), AppError> {
    let hosts = acp_lock(&state)?;
    let host = hosts
        .get(&id)
        .ok_or_else(|| AppError::new("unknown Claude session"))?;
    host.prompt(text);
    Ok(())
}

/// Whether a Claude session id is still live. Sessions survive tab/project
/// switches (the host lives in `AcpState`) but **not** an app restart, which
/// empties the process-local map — a re-attaching panel uses this to tell a
/// live session from a stale persisted id.
#[tauri::command]
pub fn acp_alive(state: State<'_, AcpState>, id: u64) -> bool {
    acp_lock(&state)
        .map(|hosts| hosts.contains_key(&id))
        .unwrap_or(false)
}

/// Answer a pending tool approval (S2b-2). `option_id` is the chosen permission
/// option; an empty string declines (Cancelled).
#[tauri::command]
pub fn acp_respond(
    state: State<'_, AcpState>,
    id: u64,
    request_id: u64,
    option_id: String,
) -> Result<(), AppError> {
    let hosts = acp_lock(&state)?;
    let host = hosts
        .get(&id)
        .ok_or_else(|| AppError::new("unknown Claude session"))?;
    host.respond_permission(request_id, option_id);
    Ok(())
}

/// Cancel the in-flight turn for a session (best effort).
#[tauri::command]
pub fn acp_cancel(state: State<'_, AcpState>, id: u64) -> Result<(), AppError> {
    let hosts = acp_lock(&state)?;
    let host = hosts
        .get(&id)
        .ok_or_else(|| AppError::new("unknown Claude session"))?;
    host.cancel();
    Ok(())
}

/// Close a session: drop the host (its `Drop` asks the thread to shut down and
/// kill the adapter). The persisted timeline is **kept** (the `닫기` action).
#[tauri::command]
pub fn acp_close(state: State<'_, AcpState>, id: u64) -> Result<(), AppError> {
    let host = acp_lock(&state)?.remove(&id);
    drop(host);
    Ok(())
}

// ---- Timeline persistence + session management (S3b/S3c) ----

/// Persist a timeline event (`TurnStarted` / `TimelineItem`) to the project's
/// app-data history as one JSON line, tagged with today's date. Other events
/// are not persisted. Best effort — never blocks the relay.
fn persist_event(app: &AppHandle, project: &str, event: &AcpEvent) {
    // Serialize the event (tagged) and only keep the timeline kinds.
    let mut val = match serde_json::to_value(event) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind != "timeline_item" && kind != "turn_started" && kind != "turn_answer" {
        return;
    }
    let Some(session) = val
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return;
    };
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Some(obj) = val.as_object_mut() {
        obj.insert("date".into(), serde_json::Value::String(date.clone()));
    }
    if let Ok(line) = serde_json::to_string(&val) {
        let _ = core_lib::history::append(&base, project, &date, &session, &line);
    }
}

/// A saved session, summarized for the "open" picker (S3c/B3-5).
#[derive(Serialize)]
pub struct SessionSummary {
    session_id: String,
    date: String,
    /// User-facing name ("Claude N" or a rename). Falls back to the title.
    name: String,
    /// The first prompt of the session (its first turn), shown as subtext.
    title: String,
    /// Number of timeline (tool-call) items recorded.
    count: usize,
}

/// Persist a session's display name (B3-5). Appended as a `session_name` record;
/// the latest one wins on load. Called on the first prompt (so empty sessions
/// stay unsaved) and on rename.
#[tauri::command]
pub fn acp_rename_session(
    app: AppHandle,
    project: String,
    session_id: String,
    name: String,
) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let line = serde_json::json!({
        "type": "session_name", "session_id": session_id, "name": name, "date": date,
    })
    .to_string();
    core_lib::history::append(&base, &project, &date, &session_id, &line)
        .map_err(|e| AppError::new(io_message("Cannot rename session", &e)))
}

/// List the saved Claude sessions for `project`, newest first.
#[tauri::command]
pub fn acp_sessions(app: AppHandle, project: String) -> Vec<SessionSummary> {
    let Ok(base) = app.path().app_data_dir() else {
        return vec![];
    };
    let mut out: Vec<SessionSummary> = Vec::new();
    for file in core_lib::history::session_files(&base, &project) {
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        let mut session_id = String::new();
        let mut date = String::new();
        let mut title = String::new();
        let mut name = String::new();
        let mut count = 0usize;
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if session_id.is_empty() {
                session_id = v.get("session_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                date = v.get("date").and_then(|x| x.as_str()).unwrap_or("").to_string();
            }
            match v.get("type").and_then(|x| x.as_str()) {
                Some("turn_started") if title.is_empty() => {
                    title = v.get("prompt").and_then(|x| x.as_str()).unwrap_or("").to_string();
                }
                // Latest session_name wins.
                Some("session_name") => {
                    name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                }
                Some("timeline_item") => count += 1,
                _ => {}
            }
        }
        if !session_id.is_empty() {
            if name.is_empty() {
                name = title.clone();
            }
            out.push(SessionSummary {
                session_id,
                date,
                name,
                title,
                count,
            });
        }
    }
    // Newest first (by date desc, then discovery order).
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out
}

/// Return a saved session's timeline as JSON event lines (parsed), for the UI
/// to replay into a read-only timeline view (S3c reopen).
#[tauri::command]
pub fn acp_session_timeline(
    app: AppHandle,
    project: String,
    session_id: String,
) -> Vec<serde_json::Value> {
    let Ok(base) = app.path().app_data_dir() else {
        return vec![];
    };
    core_lib::history::load_session(&base, &project, &session_id)
        .into_iter()
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// Delete a saved session's persisted history (the `삭제` action). The live
/// host, if any, should be closed separately via `acp_close`.
#[tauri::command]
pub fn acp_delete_session(
    app: AppHandle,
    project: String,
    session_id: String,
) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    core_lib::history::delete_session(&base, &project, &session_id)
        .map_err(|e| AppError::new(io_message("Cannot delete session", &e)))
}
