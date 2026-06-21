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
use std::time::{Duration, Instant};

use core_lib::{DirEntry, ProjectType, SessionManager, TimelineItem, TokenUsage, WorkspaceState};
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
    tokens: Vec<(u64, TokenUsage)>,
    /// Per-subagent (`Agent`/`Task`) change lists:
    /// `(agent_id, parent_tool_call_id, turn, items)`. `parent_tool_call_id` is
    /// the timeline item (the spawning `Agent` tool call) the agent nests under —
    /// found by matching the agent id inside that call's result. `None` ⇒ no
    /// known parent (nest under its `turn`). Enables the recursive agent tree.
    subagents: Vec<(String, Option<String>, u64, Vec<TimelineItem>)>,
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
#[allow(clippy::too_many_arguments)] // Tauri injects State + the panel's params
pub fn claude_start(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    cwd: Option<String>,
    resume: Option<String>,
    name: Option<String>,
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

    // (b) Tail the session JSONL -> emit timeline items + persist snapshot.
    {
        let app = app.clone();
        let cwd = cwd.clone();
        let uuid = session_uuid.clone();
        let name = name.unwrap_or_else(|| "Claude".to_string());
        thread::spawn(move || run_timeline_poll(app, id, cwd, uuid, name, stop));
    }

    Ok(ClaudeStarted { id, session_uuid })
}

/// The polling loop for one Claude session (its own thread). Waits for the
/// session JSONL to appear (the CLI creates it after init), then polls a
/// `SessionTail` every ~150ms, emitting and persisting newly-touched items.
/// Ends when the stop flag is set (`claude_close`).
fn run_timeline_poll(
    app: AppHandle,
    id: u64,
    cwd: String,
    uuid: String,
    initial_name: String,
    stop: Arc<AtomicBool>,
) {
    let Some(root) = core_lib::jsonl::claude_projects_root() else {
        return;
    };
    let mut tail: Option<core_lib::jsonl::SessionTail> = None;
    // `<uuid>/subagents/` dir + a tail per subagent transcript (Task agents), and
    // the main turn each agent was first seen in (so it nests under that turn).
    let mut sub_dir: Option<PathBuf> = None;
    let mut subagents: HashMap<String, core_lib::jsonl::SessionTail> = HashMap::new();
    let mut subagent_turn: HashMap<String, u64> = HashMap::new();
    // Cheap fingerprint of the last emitted state (incl. subagent item count). A
    // prompt- or answer-only record advances turns/answers without touching any
    // tool item, so we can't key off `poll`'s touched indices alone.
    let mut last_fp: (usize, u32, usize, usize, usize, usize) = (0, 0, 0, 0, 0, 0);

    while !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(150));
        // Re-check after the sleep so a `claude_close` during the sleep stops us
        // before another poll/save (so a delete-after-close isn't recreated —
        // codex session-UX F4).
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Resolve the file once it appears, then keep tailing it.
        if tail.is_none() {
            if let Ok(Some(path)) = core_lib::jsonl::find_session_jsonl(&root, &uuid) {
                sub_dir = Some(path.with_extension("").join("subagents"));
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

        // Tail each subagent transcript (parallel Task agents write their own
        // `<uuid>/subagents/agent-<id>.jsonl`). New files appear as agents spawn.
        if let Some(sd) = &sub_dir {
            if let Ok(entries) = std::fs::read_dir(sd) {
                for entry in entries.flatten() {
                    let f = entry.path();
                    if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let Some(aid) = f
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.trim_start_matches("agent-").to_string())
                    else {
                        continue;
                    };
                    if !subagents.contains_key(&aid) {
                        subagent_turn.insert(aid.clone(), t.current_turn());
                    }
                    let st = subagents.entry(aid.clone()).or_insert_with(|| {
                        core_lib::jsonl::SessionTail::new(cwd.clone(), aid.clone(), f)
                    });
                    let _ = st.poll();
                }
            }
        }
        let sub_rev: u32 = subagents
            .values()
            .flat_map(|st| st.timeline().items().iter().map(|i| i.revision))
            .sum();
        let sub_count: usize = subagents.values().map(|st| st.timeline().items().len()).sum();

        let items = t.timeline().items();
        let fp = (
            items.len(),
            items.iter().map(|i| i.revision).sum::<u32>() + sub_rev,
            t.turns().len(),
            t.answers().values().map(|s| s.len()).sum(),
            t.dates().len(),
            sub_count,
        );
        if fp == last_fp {
            continue; // nothing changed this tick
        }
        last_fp = fp;

        let items_v = items.to_vec();
        let turns_v: Vec<(u64, String)> = t.turns().iter().map(|(k, v)| (*k, v.clone())).collect();
        let answers_v: Vec<(u64, String)> =
            t.answers().iter().map(|(k, v)| (*k, v.clone())).collect();
        let dates_v: Vec<(u64, String)> = t.dates().iter().map(|(k, v)| (*k, v.clone())).collect();
        let tokens_v: Vec<(u64, TokenUsage)> = t.tokens().iter().map(|(k, v)| (*k, *v)).collect();
        let sub_raw: Vec<(String, u64, Vec<TimelineItem>)> = subagents
            .iter()
            .filter(|(_, st)| !st.timeline().items().is_empty())
            .map(|(aid, st)| {
                (
                    aid.clone(),
                    *subagent_turn.get(aid).unwrap_or(&0),
                    st.timeline().items().to_vec(),
                )
            })
            .collect();
        // Link each agent to the timeline item (the spawning `Agent`/`Task` call)
        // whose result mentions the agent id — that item, in main or in a parent
        // agent, is its parent (recursive tree). `None` ⇒ nest under its turn.
        let subagents_v: Vec<(String, Option<String>, u64, Vec<TimelineItem>)> = sub_raw
            .iter()
            .map(|(aid, turn, its)| {
                // Find the spawning item (its result mentions the agent id) in the
                // main timeline or in *other* agents — never in this agent's own
                // transcript, so a child echoing its id can't self-parent and
                // vanish from the tree (codex B1 F1).
                let parent = items_v
                    .iter()
                    .chain(
                        sub_raw
                            .iter()
                            .filter(|(other, _, _)| other != aid)
                            .flat_map(|(_, _, x)| x.iter()),
                    )
                    .find(|it| {
                        it.content_text
                            .as_deref()
                            .is_some_and(|ct| ct.contains(aid.as_str()))
                    })
                    .map(|it| it.tool_call_id.clone());
                (aid.clone(), parent, *turn, its.clone())
            })
            .collect();

        let _ = app.emit(
            "claude-timeline",
            ClaudeTimelinePayload {
                id,
                items: items_v.clone(),
                turns: turns_v.clone(),
                answers: answers_v.clone(),
                dates: dates_v.clone(),
                tokens: tokens_v.clone(),
                subagents: subagents_v,
            },
        );

        // Persist a whole-session snapshot (D-1): overwrite, so the session
        // survives restart and can be listed/reopened, without the append
        // duplication. A rename (claude_rename writes the snapshot's name) is
        // preserved by reading the existing name back here.
        if stop.load(Ordering::Relaxed) {
            break; // closed during poll/emit — don't persist after close (F4)
        }
        if let Ok(base) = app.path().app_data_dir() {
            // Read the rename override (decoupled file) rather than the body's
            // own name, so a concurrent rename isn't clobbered (codex F1).
            let name = core_lib::snapshot::read_name(&base, &cwd, &uuid)
                .unwrap_or_else(|| initial_name.clone());
            let date = chrono::Local::now().format("%Y-%m-%d").to_string();
            let snap = core_lib::snapshot::SessionSnapshot {
                uuid: uuid.clone(),
                name,
                date,
                items: items_v,
                turns: turns_v,
                answers: answers_v,
                dates: dates_v,
                tokens: tokens_v,
                // Task-chain meta lives in the decoupled `.task` sidecar (set at
                // handoff), not the body — the body is overwritten every tick, so
                // these stay `None` here and `load` sources them from the sidecar.
                prev_uuid: None,
                summary_path: None,
            };
            let _ = core_lib::snapshot::save(&base, &cwd, &snap);
        }
    }

    // Drop our stop-flag entry so a later id collision can't see a stale flag.
    if let Some(state) = app.try_state::<ClaudeState>() {
        if let Ok(mut polls) = state.polls.lock() {
            polls.remove(&id);
        }
    }
}

/// List the saved Claude (A) sessions for `project`, newest first (for the
/// "+ Claude(A)" reopen picker).
#[tauri::command]
pub fn claude_sessions(app: AppHandle, project: String) -> Vec<core_lib::snapshot::SnapshotSummary> {
    let Ok(base) = app.path().app_data_dir() else {
        return vec![];
    };
    core_lib::snapshot::list(&base, &project)
}

/// Load a saved session's full timeline snapshot, to seed the panel on reopen.
#[tauri::command]
pub fn claude_session_snapshot(
    app: AppHandle,
    project: String,
    uuid: String,
) -> Option<core_lib::snapshot::SessionSnapshot> {
    let base = app.path().app_data_dir().ok()?;
    core_lib::snapshot::load(&base, &project, &uuid)
}

/// Load a whole handoff chain (the `head` task and every task it continues from),
/// oldest-first, so the panel can render one continuous timeline across the
/// `/clear`-style restarts that split a task into separate sessions. Empty if the
/// head is absent. (Task-chain links live in each session's `.task` sidecar.)
#[tauri::command]
pub fn claude_session_chain(
    app: AppHandle,
    project: String,
    head_uuid: String,
) -> Vec<core_lib::snapshot::SessionSnapshot> {
    let Ok(base) = app.path().app_data_dir() else {
        return vec![];
    };
    core_lib::snapshot::load_chain(&base, &project, &head_uuid)
}

// ---- Task handoff (architecture A: summarize prev task -> seed new session) ----
//
// "task 시작" restarts a Claude terminal under a fresh `--session-id` (not
// `/clear`, whose new uuid we can't track) and seeds it with a handoff summary of
// the previous task, generated by a one-shot headless `claude -p`. The chain link
// lives in the new session's `.task` sidecar so the timeline renders continuously
// across the restart.

/// The generated handoff summary: where it was written + its text (so the UI can
/// show it for review/edit before the restart).
#[derive(Serialize)]
pub struct TaskSummary {
    path: String,
    text: String,
}

/// Run a one-shot `claude -p --output-format text` in `cwd`, feeding `prompt` on
/// stdin and capturing stdout. Drains stdout/stderr on threads (so a full pipe
/// can't deadlock the child), enforces `timeout` with kill+wait (no zombie), caps
/// captured output, and treats only `exit 0 && non-empty stdout` as success
/// (codex P3 D7).
fn run_claude_p(cwd: &str, prompt: &str, timeout: Duration) -> Result<String, AppError> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    const CAP: usize = 256 * 1024;

    let mut child = Command::new("claude")
        .args(["-p", "--output-format", "text"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| AppError::new("Cannot start claude for summary"))?;

    // Feed the prompt and close stdin (EOF) on its own thread so a large prompt
    // can't deadlock against an unread stdout pipe.
    if let Some(mut stdin) = child.stdin.take() {
        let p = prompt.to_string();
        thread::spawn(move || {
            let _ = stdin.write_all(p.as_bytes());
            // `stdin` drops here -> EOF.
        });
    }

    // Drain stdout on its own thread, sending the captured (capped) bytes on a
    // channel so we collect with a *timeout* — never an unbounded `join`, which
    // could hang if a descendant of `claude` keeps the pipe open past the child's
    // own exit (codex P3-impl 3).
    let (otx, orx) = std::sync::mpsc::channel::<Vec<u8>>();
    if let Some(mut so) = child.stdout.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = so.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if buf.len() < CAP {
                    let take = n.min(CAP - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
            let _ = otx.send(buf);
        });
    }
    // Drain stderr to a sink (so a full stderr pipe can't block the child) and
    // discard it — error text isn't surfaced to the UI. Detached.
    if let Some(mut se) = child.stderr.take() {
        thread::spawn(move || {
            let mut sink = [0u8; 8192];
            while let Ok(n) = se.read(&mut sink) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    // Wait with a deadline; kill + reap on timeout.
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait(); // reap so we don't leave a zombie
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    match status {
        Some(st) if st.success() => {
            // Collect stdout with a bounded wait (the drain thread finishes as the
            // pipe closed on exit) — never block the command thread indefinitely.
            let stdout = orx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
            let text = String::from_utf8_lossy(&stdout).trim().to_string();
            if text.is_empty() {
                Err(AppError::new("Claude returned an empty summary"))
            } else {
                Ok(text)
            }
        }
        Some(_) => Err(AppError::new("Claude failed to produce a summary")),
        None => Err(AppError::new("Claude summary timed out")),
    }
}

/// Generate a handoff summary for the task in session `uuid` (rooted at `cwd`):
/// read the session JSONL fresh (not the lagging poll snapshot — codex P3 D4),
/// render it to compact text, run a headless `claude -p`, and write the result to
/// the `<uuid>.summary.md` sidecar. Returns the path + text for review/edit. The
/// current session is left untouched, so a failure here aborts the handoff
/// without losing the live session.
#[tauri::command]
pub async fn generate_task_summary(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<TaskSummary, AppError> {
    // Tauri runs *synchronous* commands on the main thread, so the blocking
    // `claude -p` wait would freeze the whole UI. Offload it to the blocking pool
    // and await the result, keeping the webview responsive.
    tauri::async_runtime::spawn_blocking(move || generate_task_summary_blocking(app, cwd, uuid))
        .await
        .map_err(|_| AppError::new("Summary task failed to run"))?
}

fn generate_task_summary_blocking(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<TaskSummary, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let root = core_lib::jsonl::claude_projects_root()
        .ok_or_else(|| AppError::new("Cannot resolve Claude projects root"))?;
    let path = core_lib::jsonl::find_session_jsonl(&root, &uuid)
        .ok()
        .flatten()
        .ok_or_else(|| AppError::new("Session transcript not found"))?;

    // A fresh tail starts at offset 0, so one poll reads the whole (idle) file;
    // a second catches any bytes written between the two reads.
    let mut tail = core_lib::jsonl::SessionTail::new(cwd.clone(), uuid.clone(), path);
    let _ = tail.poll();
    let _ = tail.poll();

    let name =
        core_lib::snapshot::read_name(&base, &cwd, &uuid).unwrap_or_else(|| "Claude".to_string());
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let snap = core_lib::snapshot::SessionSnapshot {
        uuid: uuid.clone(),
        name,
        date,
        items: tail.timeline().items().to_vec(),
        turns: tail.turns().iter().map(|(k, v)| (*k, v.clone())).collect(),
        answers: tail.answers().iter().map(|(k, v)| (*k, v.clone())).collect(),
        dates: tail.dates().iter().map(|(k, v)| (*k, v.clone())).collect(),
        tokens: tail.tokens().iter().map(|(k, v)| (*k, *v)).collect(),
        prev_uuid: None,
        summary_path: None,
    };
    if snap.turns.is_empty() {
        return Err(AppError::new("요약할 대화가 없습니다"));
    }
    let rendered = core_lib::snapshot::render_for_summary(&snap);
    let prompt = format!(
        "다음은 한 코딩 작업(task)의 전체 타임라인입니다. 이어서 작업할 Claude 세션이 맥락을 빠르게 \
이어받도록 한국어 핸드오프 요약을 markdown으로 작성하세요. 포함: (1) 목표와 지금까지 한 일 (2) 변경된 \
핵심 파일과 이유 (3) 미해결·다음 할 일 (4) 주의점. 군더더기 없이 간결하게.\n\n{rendered}"
    );
    let text = run_claude_p(&cwd, &prompt, Duration::from_secs(120))?;
    let path = core_lib::snapshot::save_summary(&base, &cwd, &uuid, &text)
        .map_err(|e| AppError::new(io_message("Cannot save summary", &e)))?;
    Ok(TaskSummary {
        path: path.to_string_lossy().to_string(),
        text,
    })
}

/// Overwrite a session's handoff summary with user-edited text (the review/edit
/// step before the restart). Returns the sidecar path.
#[tauri::command]
pub fn save_task_summary(
    app: AppHandle,
    cwd: String,
    uuid: String,
    text: String,
) -> Result<String, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let path = core_lib::snapshot::save_summary(&base, &cwd, &uuid, &text)
        .map_err(|e| AppError::new(io_message("Cannot save summary", &e)))?;
    Ok(path.to_string_lossy().to_string())
}

/// Record the handoff chain link for a freshly-started task: set `uuid`'s `.task`
/// sidecar to point at `prev_uuid`. The `summary_path` is **derived** from
/// `prev_uuid` here (its `<prev_uuid>.summary.md`), never taken from the caller,
/// so an arbitrary path can't be stored (codex P3 D8). Called right after the new
/// session starts, before seed injection, so a seed failure stays recoverable.
#[tauri::command]
pub fn claude_set_task_meta(
    app: AppHandle,
    cwd: String,
    uuid: String,
    prev_uuid: String,
) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let summary_path = core_lib::snapshot::summary_path(&base, &cwd, &prev_uuid)
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string());
    let meta = core_lib::snapshot::TaskMeta {
        prev_uuid: Some(prev_uuid),
        summary_path,
    };
    core_lib::snapshot::save_task_meta(&base, &cwd, &uuid, &meta)
        .map_err(|e| AppError::new(io_message("Cannot set task meta", &e)))
}

/// Rename a saved session (persists in its snapshot; the poll thread reads the
/// name back so it isn't clobbered).
#[tauri::command]
pub fn claude_rename(
    app: AppHandle,
    project: String,
    uuid: String,
    name: String,
) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    // Write only the name override file — decoupled from the timeline body the
    // poll thread writes, so neither clobbers the other (codex F1).
    core_lib::snapshot::save_name(&base, &project, &uuid, &name)
        .map_err(|e| AppError::new(io_message("Cannot rename session", &e)))
}

/// Delete a saved session's snapshot (the `삭제` action). The live session, if
/// any, should be closed separately via `claude_close`.
#[tauri::command]
pub fn claude_delete(app: AppHandle, project: String, uuid: String) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    core_lib::snapshot::delete(&base, &project, &uuid)
        .map_err(|e| AppError::new(io_message("Cannot delete session", &e)))
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

/// Write `content` to `path` (editor save), **atomically**: write a temp file in
/// the same directory then `rename` over the target, so a crash / ENOSPC / I/O
/// error never leaves the original truncated or partial (codex P2 E1). Symlinks
/// are resolved first so we edit the link's *target* (like most editors), not
/// replace the link.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), AppError> {
    let p = std::path::Path::new(&path);
    let md = std::fs::symlink_metadata(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))?;
    if md.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    } else {
        std::fs::remove_file(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    }
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), AppError> {
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


// ---- Git panel (G1) — thin wrappers over core_lib::git (system `git` CLI) ----

/// Working-tree status for `cwd` (infallible — non-repo yields `is_repo: false`).
#[tauri::command]
pub fn git_status(cwd: String) -> core_lib::git::GitStatus {
    core_lib::git::status(&cwd)
}

/// Local branches + current.
#[tauri::command]
pub fn git_branches(cwd: String) -> Result<core_lib::git::Branches, AppError> {
    core_lib::git::branches(&cwd).map_err(AppError::new)
}

/// Switch to an existing branch.
#[tauri::command]
pub fn git_checkout(cwd: String, branch: String) -> Result<(), AppError> {
    core_lib::git::checkout(&cwd, &branch).map(|_| ()).map_err(AppError::new)
}

/// Create and switch to a new branch.
#[tauri::command]
pub fn git_create_branch(cwd: String, name: String) -> Result<(), AppError> {
    core_lib::git::create_branch(&cwd, &name).map(|_| ()).map_err(AppError::new)
}

/// Stage one path.
#[tauri::command]
pub fn git_stage(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::stage(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

/// Stage all changes.
#[tauri::command]
pub fn git_stage_all(cwd: String) -> Result<(), AppError> {
    core_lib::git::stage_all(&cwd).map(|_| ()).map_err(AppError::new)
}

/// Unstage one path.
#[tauri::command]
pub fn git_unstage(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::unstage(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

/// Commit staged changes with `message`. Returns git's stdout for feedback.
#[tauri::command]
pub fn git_commit(cwd: String, message: String) -> Result<String, AppError> {
    core_lib::git::commit(&cwd, &message).map_err(AppError::new)
}

/// Push the current branch (sets upstream on `origin` if none). Explicit user
/// action only — never called automatically.
#[tauri::command]
pub fn git_push(cwd: String) -> Result<String, AppError> {
    core_lib::git::push(&cwd).map_err(AppError::new)
}

/// Recent commits across all refs (newest first) for the history graph.
#[tauri::command]
pub fn git_log(
    cwd: String,
    limit: Option<u32>,
    order: Option<String>,
) -> Result<Vec<core_lib::git::Commit>, AppError> {
    core_lib::git::log(&cwd, limit.unwrap_or(200), order.as_deref().unwrap_or("date"))
        .map_err(AppError::new)
}

// ---- Git GP3 (actions) + GP4 (worktrees) ----

#[tauri::command]
pub fn git_merge(cwd: String, branch: String) -> Result<String, AppError> {
    core_lib::git::merge(&cwd, &branch).map_err(AppError::new)
}

#[tauri::command]
pub fn git_fetch(cwd: String) -> Result<String, AppError> {
    core_lib::git::fetch(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_pull(cwd: String) -> Result<String, AppError> {
    core_lib::git::pull(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_discard(cwd: String, path: String) -> Result<(), AppError> {
    core_lib::git::discard(&cwd, &path).map(|_| ()).map_err(AppError::new)
}

#[tauri::command]
pub fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<String, AppError> {
    core_lib::git::delete_branch(&cwd, &name, force).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_list(cwd: String) -> Result<Vec<String>, AppError> {
    core_lib::git::stash_list(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_save(cwd: String, message: String) -> Result<String, AppError> {
    core_lib::git::stash_save(&cwd, &message).map_err(AppError::new)
}

#[tauri::command]
pub fn git_stash_pop(cwd: String) -> Result<String, AppError> {
    core_lib::git::stash_pop(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktrees(cwd: String) -> Result<Vec<core_lib::git::Worktree>, AppError> {
    core_lib::git::worktrees(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktree_add(cwd: String, path: String, branch: String) -> Result<String, AppError> {
    core_lib::git::worktree_add(&cwd, &path, &branch).map_err(AppError::new)
}

#[tauri::command]
pub fn git_worktree_remove(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::worktree_remove(&cwd, &path).map_err(AppError::new)
}

#[tauri::command]
pub fn git_diff(cwd: String, path: String, staged: bool) -> Result<String, AppError> {
    core_lib::git::diff(&cwd, &path, staged).map_err(AppError::new)
}

#[tauri::command]
pub fn git_show(cwd: String, hash: String) -> Result<String, AppError> {
    core_lib::git::show(&cwd, &hash).map_err(AppError::new)
}

#[tauri::command]
pub fn git_tags(cwd: String) -> Result<Vec<String>, AppError> {
    core_lib::git::tags(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_create_tag(cwd: String, name: String, message: String) -> Result<String, AppError> {
    core_lib::git::create_tag(&cwd, &name, &message).map_err(AppError::new)
}

#[tauri::command]
pub fn git_delete_tag(cwd: String, name: String) -> Result<String, AppError> {
    core_lib::git::delete_tag(&cwd, &name).map_err(AppError::new)
}

#[tauri::command]
pub fn git_merge_abort(cwd: String) -> Result<String, AppError> {
    core_lib::git::merge_abort(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_merge_continue(cwd: String) -> Result<String, AppError> {
    core_lib::git::merge_continue(&cwd).map_err(AppError::new)
}

#[tauri::command]
pub fn git_resolve_ours(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::resolve_ours(&cwd, &path).map_err(AppError::new)
}

#[tauri::command]
pub fn git_resolve_theirs(cwd: String, path: String) -> Result<String, AppError> {
    core_lib::git::resolve_theirs(&cwd, &path).map_err(AppError::new)
}
