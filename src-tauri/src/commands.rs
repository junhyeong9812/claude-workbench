//! Tauri commands: thin wrappers over the pure `core_lib` crate.
//!
//! Error policy: every fallible command returns `Result<_, AppError>`. We never
//! panic, and error messages are deliberately generic (an error *kind*, never
//! the offending path or an OS-level message) so internal filesystem details
//! and stack information are not leaked to the UI.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use core_acp::{AcpEvent, AcpHost};
use core_lib::{DirEntry, ProjectType, SessionManager, TimelineItem, WorkspaceState};
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

// ---- Claude (architecture A: real terminal + session-JSONL tail) ----
//
// Instead of the ACP adapter, we spawn the **real** `claude` CLI in a PTY (so
// xterm renders its full TUI — perfect terminal parity) and tail the session
// JSONL transcript the CLI writes (`~/.claude/projects/<slug>/<uuid>.jsonl`) to
// build the change timeline. `claude_start` does both: it reuses the PTY relay
// (the `terminal-output` event, exactly like `terminal_create`) and spawns a
// polling thread that drives a `SessionTail` and emits `claude-timeline` events.

/// Managed state: the stop flag for each Claude session's polling thread, keyed
/// by the PTY session id. Setting it (on `claude_close`) ends the thread.
#[derive(Default)]
pub struct ClaudeState {
    polls: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

/// Returned by `claude_start`: the PTY session id (used by the panel for output
/// filtering, input, and close) and the Claude session UUID we generated.
#[derive(Serialize)]
pub struct ClaudeStarted {
    id: u64,
    session_uuid: String,
}

/// The full timeline snapshot for a Claude session, emitted as `claude-timeline`
/// whenever a poll observed any change. Carries the change items **and** the
/// derived conversation turns/answers/dates, so the UI shows plain Q&A turns
/// (no tool calls) too — not only tool items. Re-sending the whole (modest)
/// state keeps the frontend a simple replace.
#[derive(Clone, Serialize)]
struct ClaudeTimelinePayload {
    id: u64,
    items: Vec<TimelineItem>,
    turns: Vec<(u64, String)>,
    answers: Vec<(u64, String)>,
    dates: Vec<(u64, String)>,
}

/// Generate a fresh session UUID for `--session-id`. Linux-only (the app's
/// platform): reads the kernel's random UUID source.
fn new_session_uuid() -> Result<String, AppError> {
    std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .map(|s| s.trim().to_string())
        .map_err(|_| AppError::new("Cannot generate a session id"))
}

/// Spawn the real `claude` CLI in a PTY rooted at `cwd` and start (a) relaying
/// its output to `terminal-output` (xterm) and (b) tailing its session JSONL to
/// emit `claude-timeline` items. `resume` continues an existing session by its
/// UUID (same file, append); omitting it starts a new `--session-id` session.
#[tauri::command]
pub fn claude_start(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    cwd: Option<String>,
    resume: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<ClaudeStarted, AppError> {
    // Claude must be rooted at the project; refuse rather than guess.
    let cwd = cwd.ok_or_else(|| AppError::new("Claude requires an active project"))?;
    // Resume reuses the original id (same JSONL file); a new session gets a
    // fresh UUID we pass via --session-id (so we know exactly which file to tail).
    let session_uuid = match &resume {
        Some(u) => u.clone(),
        None => new_session_uuid()?,
    };
    let flag = if resume.is_some() { "--resume" } else { "--session-id" };
    let cmd = vec!["claude".to_string(), flag.to_string(), session_uuid.clone()];

    let id = mgr
        .create(Some(cmd), Some(cwd.clone()), cols, rows)
        .map_err(AppError::new)?;
    let rx = mgr.subscribe(id).map_err(AppError::new)?;

    let stop = Arc::new(AtomicBool::new(false));
    claude
        .polls
        .lock()
        .map_err(|_| AppError::new("Claude state unavailable"))?
        .insert(id, stop.clone());

    // (a) Relay PTY output -> webview, like `terminal_create`. When the PTY dies
    // (claude exits on its own, or failed to start), the sender drops and this
    // loop ends — we then set `stop` so the poll thread doesn't tail forever
    // (codex B-2b #1).
    {
        let app = app.clone();
        let stop = stop.clone();
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
            stop.store(true, Ordering::Relaxed);
        });
    }

    // (b) Tail the session JSONL -> emit timeline items.
    {
        let app = app.clone();
        let cwd = cwd.clone();
        let uuid = session_uuid.clone();
        thread::spawn(move || run_timeline_poll(app, id, cwd, uuid, stop));
    }

    Ok(ClaudeStarted { id, session_uuid })
}

/// The polling loop for one Claude session (its own thread). Waits for the
/// session JSONL to appear (the CLI creates it after init), then polls a
/// `SessionTail` every ~150ms, emitting and persisting newly-touched items.
/// Ends when the stop flag is set (`claude_close`).
fn run_timeline_poll(app: AppHandle, id: u64, cwd: String, uuid: String, stop: Arc<AtomicBool>) {
    let Some(root) = core_lib::jsonl::claude_projects_root() else {
        return;
    };
    let mut tail: Option<core_lib::jsonl::SessionTail> = None;
    // Cheap fingerprint of the last emitted state. A prompt- or answer-only
    // record advances turns/answers without touching any tool item, so we can't
    // key off `poll`'s touched indices alone — compare the whole shape.
    let mut last_fp: (usize, u32, usize, usize, usize) = (0, 0, 0, 0, 0);

    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(150));

        // Resolve the file once it appears, then keep tailing it.
        if tail.is_none() {
            if let Ok(Some(path)) = core_lib::jsonl::find_session_jsonl(&root, &uuid) {
                tail = Some(core_lib::jsonl::SessionTail::new(
                    cwd.clone(),
                    uuid.clone(),
                    path,
                ));
            } else {
                continue;
            }
        }
        let Some(t) = tail.as_mut() else { continue };
        if t.poll().is_err() {
            continue; // transient read error — retry next tick
        }

        let items = t.timeline().items();
        let fp = (
            items.len(),
            items.iter().map(|i| i.revision).sum(),
            t.turns().len(),
            t.answers().values().map(|s| s.len()).sum(),
            t.dates().len(),
        );
        if fp == last_fp {
            continue; // nothing changed this tick
        }
        last_fp = fp;

        // First cut: live emit only (persistence/reopen is the next increment —
        // codex B-2b F2/F3: re-persisting the resume replay duplicates history,
        // so the persist model is being revisited).
        let _ = app.emit(
            "claude-timeline",
            ClaudeTimelinePayload {
                id,
                items: items.to_vec(),
                turns: t.turns().iter().map(|(k, v)| (*k, v.clone())).collect(),
                answers: t.answers().iter().map(|(k, v)| (*k, v.clone())).collect(),
                dates: t.dates().iter().map(|(k, v)| (*k, v.clone())).collect(),
            },
        );
    }

    // Drop our stop-flag entry so a later id collision can't see a stale flag.
    if let Some(state) = app.try_state::<ClaudeState>() {
        if let Ok(mut polls) = state.polls.lock() {
            polls.remove(&id);
        }
    }
}

/// Close a Claude session: stop its polling thread and kill the PTY (which ends
/// the output relay). The persisted timeline is kept (the `닫기` action).
#[tauri::command]
pub fn claude_close(
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
) -> Result<(), AppError> {
    if let Ok(mut polls) = claude.polls.lock() {
        if let Some(stop) = polls.remove(&id) {
            stop.store(true, Ordering::Relaxed);
        }
    }
    mgr.remove(id).map_err(AppError::new)
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

/// Read a file's current text for the timeline detail viewer (B4) — e.g.
/// clicking a `read` item shows the file itself. Capped to keep the viewer
/// responsive; refuses binary/oversized files rather than flooding the UI.
#[tauri::command]
pub fn acp_read_file(path: String) -> Result<String, AppError> {
    const MAX: u64 = 512 * 1024;
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))?;
    if meta.len() > MAX {
        return Err(AppError::new("파일이 너무 커서 미리보기를 생략합니다 (512KB 초과)"));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))
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
