// ---- Claude (architecture A: real terminal + session-JSONL tail) ----
//
// Instead of the ACP adapter, we spawn the **real** `claude` CLI in a PTY (so
// xterm renders its full TUI — perfect terminal parity) and tail the session
// JSONL transcript the CLI writes (`~/.claude/projects/<slug>/<uuid>.jsonl`) to
// build the change timeline. `claude_start` does both: it reuses the PTY relay
// (the `terminal-output` event, exactly like `terminal_create`) and spawns a
// polling thread that drives a `SessionTail` and emits `claude-timeline` events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use core_lib::{SessionManager, TimelineItem, TokenUsage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::{io_message, AppError, TerminalOutput};

/// One live Claude session shared across windows (multiwindow mirror, P6). A
/// session is ONE PTY (`id`) + JSONL (`uuid`); multiple windows can render it,
/// but only the `driver` window may type into it (single-writer). `attached` is
/// the windows currently viewing, in attach order — when the driver detaches,
/// the next in order takes over. `rev` monotonically tags driver changes so the
/// frontend can drop stale `claude-driver-changed` events.
struct Sess {
    project: String,
    uuid: String,
    attached: Vec<String>,
    driver: String,
    rev: u64,
    /// Poll-thread stop flag (set on real close / PTY death).
    stop: Arc<AtomicBool>,
}

/// All live Claude sessions, behind ONE lock so `live`/`by_id` never tear
/// (review R7-3). Mutations + the *actions* to run after unlocking (PTY remove,
/// event emit) are computed under the lock; the side effects run after release.
#[derive(Default)]
struct ClaudeRuntime {
    /// (project, uuid) -> live PTY id, so a 2nd window finds the running session.
    live: HashMap<(String, String), u64>,
    /// PTY id -> session.
    by_id: HashMap<u64, Sess>,
}

/// Managed state: all live Claude sessions (single lock).
#[derive(Default)]
pub struct ClaudeState {
    rt: Mutex<ClaudeRuntime>,
}

/// Result of opening a Claude session: whether we attached to an already-running
/// PTY (mirror) or started a fresh one (driver), plus the current driver/rev.
#[derive(Serialize)]
pub struct ClaudeOpened {
    id: u64,
    session_uuid: String,
    /// "driver" (we started it / first viewer) or "mirror" (read-only viewer).
    role: String,
    driver: String,
    rev: u64,
}

/// Broadcast on `claude-driver-changed` + returned by driver-changing commands.
#[derive(Clone, Serialize)]
pub struct ClaudeDriver {
    id: u64,
    driver: String,
    rev: u64,
}

/// Result of `claude_detach`: whether the PTY was actually closed (last viewer)
/// and the resulting driver/rev.
#[derive(Serialize)]
pub struct ClaudeDetached {
    closed: bool,
    driver: String,
    rev: u64,
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
    /// Current assistant model id (e.g. `claude-opus-4-8`), or `None` if not yet
    /// seen — the frontend maps it to a context-window size for the usage gauge.
    model: Option<String>,
    /// Most recent assistant message's usage = current context occupancy (the gauge
    /// numerator). Distinct from `tokens`, which sums a turn's tool round-trips.
    last_usage: Option<TokenUsage>,
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
/// emit `claude-timeline` items. Does NOT register into `ClaudeRuntime` — the
/// caller does that under its lock. `resume` continues an existing session by
/// UUID; None starts a fresh `--session-id`. Returns (id, uuid, poll-stop flag).
fn spawn_claude(
    app: &AppHandle,
    mgr: &SessionManager,
    cwd: String,
    resume: Option<String>,
    name: String,
    cols: u16,
    rows: u16,
) -> Result<(u64, String, Arc<AtomicBool>), AppError> {
    let session_uuid = match &resume {
        Some(u) => u.clone(),
        None => new_session_uuid()?,
    };
    // Resume only if the transcript already exists; otherwise `--resume` would
    // fork a *different* new session, so create with this exact id via
    // `--session-id` (keeps the id stable across restarts).
    let resuming = resume.is_some()
        && core_lib::jsonl::claude_projects_root()
            .and_then(|root| core_lib::jsonl::find_session_jsonl(&root, &session_uuid).ok().flatten())
            .is_some();
    let flag = if resuming { "--resume" } else { "--session-id" };
    let cmd = vec!["claude".to_string(), flag.to_string(), session_uuid.clone()];

    let id = mgr
        .create(Some(cmd), Some(cwd.clone()), cols, rows)
        .map_err(AppError::new)?;
    // Clean up the orphan PTY if we can't subscribe to it (review P6-impl #4).
    let rx = match mgr.subscribe(id) {
        Ok(rx) => rx,
        Err(e) => {
            let _ = mgr.remove(id);
            return Err(AppError::new(e));
        }
    };
    let stop = Arc::new(AtomicBool::new(false));

    // (a) Relay PTY output -> webview (global emit; every attached window filters
    // by id). When the PTY dies the sender drops, the loop ends, and `stop` is
    // set so the poll thread stops tailing.
    {
        let app = app.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                let _ = app.emit(
                    "terminal-output",
                    TerminalOutput { session_id: id, seq: chunk.seq, data: chunk.bytes },
                );
            }
            stop.store(true, Ordering::Relaxed);
        });
    }
    // (b) Tail the JSONL -> claude-timeline + persist snapshot.
    {
        let app = app.clone();
        let uuid = session_uuid.clone();
        let stop = stop.clone();
        thread::spawn(move || run_timeline_poll(app, id, cwd, uuid, name, stop));
    }
    Ok((id, session_uuid, stop))
}

/// Open a Claude session for THIS window: if its PTY is already live (another
/// window started it), attach as a read-only **mirror**; otherwise start a fresh
/// PTY and become the **driver**. Atomic under the runtime lock so two windows
/// can't both start the same session (review R7-2/R7-3). `uuid` None = brand new.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn claude_open_or_attach(
    window: Window,
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    project: String,
    uuid: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<ClaudeOpened, AppError> {
    let label = window.label().to_string();
    let cwd = cwd.ok_or_else(|| AppError::new("Claude requires an active project"))?;
    let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;

    // Mirror: attach to the running PTY if this uuid is live.
    if let Some(u) = &uuid {
        let key = (project.clone(), u.clone());
        if let Some(&id) = rt.live.get(&key) {
            if mgr.exists(id) {
                if let Some(sess) = rt.by_id.get_mut(&id) {
                    if !sess.attached.contains(&label) {
                        sess.attached.push(label.clone());
                    }
                    // Promote this window to driver if the current driver is gone
                    // (e.g. it detached during a transfer, leaving a stale label) —
                    // else the new viewer is locked as a mirror with no driver
                    // (review P6-impl #1). `role` is computed from the real driver (#5).
                    let mut handoff = None;
                    if !sess.attached.iter().any(|l| l == &sess.driver) {
                        sess.driver = label.clone();
                        sess.rev += 1;
                        handoff = Some((sess.driver.clone(), sess.rev));
                    }
                    let role = if sess.driver == label { "driver" } else { "mirror" };
                    let opened = ClaudeOpened {
                        id,
                        session_uuid: u.clone(),
                        role: role.into(),
                        driver: sess.driver.clone(),
                        rev: sess.rev,
                    };
                    drop(rt);
                    if let Some((driver, rev)) = handoff {
                        let _ = app.emit("claude-driver-changed", ClaudeDriver { id, driver, rev });
                    }
                    return Ok(opened);
                }
            }
            // Stale live entry (PTY gone): clean BOTH maps + stop flag so
            // `claude_live_uuids` can't keep reporting it (review P6-impl #3).
            if let Some(s) = rt.by_id.remove(&id) {
                s.stop.store(true, Ordering::Relaxed);
            }
            rt.live.remove(&key);
        }
    }

    // Driver: start a fresh PTY (lock held so a concurrent open can't double-start).
    let (id, session_uuid, stop) = spawn_claude(
        &app,
        &mgr,
        cwd,
        uuid,
        name.unwrap_or_else(|| "Claude".to_string()),
        cols,
        rows,
    )?;
    rt.live.insert((project.clone(), session_uuid.clone()), id);
    rt.by_id.insert(
        id,
        Sess {
            project,
            uuid: session_uuid.clone(),
            attached: vec![label.clone()],
            driver: label.clone(),
            rev: 0,
            stop,
        },
    );
    Ok(ClaudeOpened { id, session_uuid, role: "driver".into(), driver: label, rev: 0 })
}

/// Driver-only input: write to the PTY only if `window` is the session's current
/// driver (single-writer — a mirror's stray input is a silent no-op, review
/// R7-1). Claude panels call this instead of `terminal_write`.
#[tauri::command]
pub fn claude_write(
    window: Window,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
    data: Vec<u8>,
) -> Result<(), AppError> {
    let is_driver = {
        let rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        rt.by_id.get(&id).map(|s| s.driver == window.label()).unwrap_or(false)
    };
    if is_driver {
        mgr.write(id, &data).map_err(AppError::new)
    } else {
        Ok(()) // not the driver — ignore
    }
}

/// Driver-only resize (the PTY size is shared; only the driver drives it).
#[tauri::command]
pub fn claude_resize(
    window: Window,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let is_driver = {
        let rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        rt.by_id.get(&id).map(|s| s.driver == window.label()).unwrap_or(false)
    };
    if is_driver {
        mgr.resize(id, cols, rows).map_err(AppError::new)
    } else {
        Ok(())
    }
}

/// Take over input control of a session (mirror → driver). No-op if `window`
/// isn't attached. Bumps `rev` and broadcasts `claude-driver-changed` so every
/// window locks/unlocks accordingly (review R7-4).
#[tauri::command]
pub fn claude_set_driver(
    window: Window,
    app: AppHandle,
    claude: State<'_, ClaudeState>,
    id: u64,
) -> Result<ClaudeDriver, AppError> {
    let label = window.label().to_string();
    let changed = {
        let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        match rt.by_id.get_mut(&id) {
            Some(s) if s.attached.contains(&label) && s.driver != label => {
                s.driver = label.clone();
                s.rev += 1;
                Some((s.driver.clone(), s.rev))
            }
            Some(s) => Some((s.driver.clone(), s.rev)), // already driver / not attached
            None => None,
        }
    };
    match changed {
        Some((driver, rev)) => {
            if driver == label {
                let _ = app.emit("claude-driver-changed", ClaudeDriver { id, driver: driver.clone(), rev });
            }
            Ok(ClaudeDriver { id, driver, rev })
        }
        None => Err(AppError::new("no such session")),
    }
}

/// `window` stops viewing session `id`. Removes it from `attached`; when
/// `close_if_last` and no viewers remain, really closes the PTY (refcount). If
/// the leaver was the driver and viewers remain, the next-in-order takes over
/// (broadcast). Claude panels call this instead of `claude_close` (review R7-5/7).
#[tauri::command]
pub fn claude_detach(
    window: Window,
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
    close_if_last: bool,
) -> Result<ClaudeDetached, AppError> {
    let label = window.label().to_string();
    enum Act {
        None,
        Close(Arc<AtomicBool>),
        Handoff(String, u64),
    }
    let (act, driver, rev) = {
        let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        let Some(sess) = rt.by_id.get_mut(&id) else {
            return Ok(ClaudeDetached { closed: false, driver: String::new(), rev: 0 });
        };
        sess.attached.retain(|l| l != &label);
        if sess.attached.is_empty() {
            if close_if_last {
                let key = (sess.project.clone(), sess.uuid.clone());
                let stop = sess.stop.clone();
                rt.by_id.remove(&id);
                rt.live.remove(&key);
                (Act::Close(stop), String::new(), 0)
            } else {
                // Transfer in progress: keep the PTY (target will attach); leave
                // driver as-is (target will set_driver).
                (Act::None, sess.driver.clone(), sess.rev)
            }
        } else if sess.driver == label {
            sess.driver = sess.attached[0].clone();
            sess.rev += 1;
            (Act::Handoff(sess.driver.clone(), sess.rev), sess.driver.clone(), sess.rev)
        } else {
            (Act::None, sess.driver.clone(), sess.rev)
        }
    };
    match act {
        Act::Close(stop) => {
            stop.store(true, Ordering::Relaxed);
            mgr.remove(id).map_err(AppError::new)?;
            Ok(ClaudeDetached { closed: true, driver, rev })
        }
        Act::Handoff(d, r) => {
            let _ = app.emit("claude-driver-changed", ClaudeDriver { id, driver: d, rev: r });
            Ok(ClaudeDetached { closed: false, driver, rev })
        }
        Act::None => Ok(ClaudeDetached { closed: false, driver, rev }),
    }
}

/// One live session's identity + the directory it runs in (its `project` = cwd,
/// which may be a git worktree). Read-only — for the worktree panel's session
/// badges (which worktree has a live session).
#[derive(Serialize)]
pub struct SessionCwd {
    uuid: String,
    cwd: String,
    /// The worktree root containing `cwd` (git-canonicalized), so the panel matches
    /// a session to its worktree even when the session runs in a subdirectory and
    /// without symlink/`..`/trailing-slash false-misses. Falls back to `cwd`.
    root: String,
}

/// All currently-live Claude sessions (any window) as (uuid, cwd, worktree root).
/// The worktree panel matches each worktree's path against `root` to badge "a
/// session runs here". The runtime lock is read-only and brief (just clone the
/// cwds); the per-session git `show-toplevel` runs *after* releasing the lock so a
/// subprocess never blocks session mutations.
#[tauri::command]
pub fn claude_session_cwds(claude: State<'_, ClaudeState>) -> Vec<SessionCwd> {
    let cwds: Vec<(String, String)> = claude
        .rt
        .lock()
        .map(|rt| {
            rt.by_id
                .values()
                .map(|s| (s.uuid.clone(), s.project.clone()))
                .collect()
        })
        .unwrap_or_default();
    cwds.into_iter()
        .map(|(uuid, cwd)| {
            let root = core_lib::git::worktree_root(&cwd).unwrap_or_else(|| cwd.clone());
            SessionCwd { uuid, cwd, root }
        })
        .collect()
}

/// UUIDs of sessions currently live (any window) in `project` — lets the picker
/// mark "running in another window — open as mirror".
#[tauri::command]
pub fn claude_live_uuids(claude: State<'_, ClaudeState>, project: String) -> Vec<String> {
    claude
        .rt
        .lock()
        .map(|rt| {
            rt.by_id
                .values()
                .filter(|s| s.project == project)
                .map(|s| s.uuid.clone())
                .collect()
        })
        .unwrap_or_default()
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
    let mut last_fp: (usize, u32, usize, usize, usize, usize, u64, u64, u64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0);

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
        // Token/model/usage changes can land without any item/answer change (a
        // usage-only assistant record), so fold them into the fingerprint — else the
        // gauge and persisted snapshot would skip those ticks (codex).
        let token_fp: u64 = t
            .tokens()
            .values()
            .map(|u| u.input + u.output + u.cache_read + u.cache_creation)
            .sum();
        let ctx_fp: u64 = t
            .last_usage()
            .map(|u| u.input + u.cache_read + u.cache_creation)
            .unwrap_or(0);
        let model_fp: u64 = t.model().map(|m| m.bytes().map(u64::from).sum()).unwrap_or(0);
        let fp = (
            items.len(),
            items.iter().map(|i| i.revision).sum::<u32>() + sub_rev,
            t.turns().len(),
            t.answers().values().map(|s| s.len()).sum(),
            t.dates().len(),
            sub_count,
            token_fp,
            ctx_fp,
            model_fp,
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
        let model_v: Option<String> = t.model().map(str::to_string);
        let last_usage_v: Option<TokenUsage> = t.last_usage();
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
                model: model_v.clone(),
                last_usage: last_usage_v,
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
                model: model_v,
                last_usage: last_usage_v,
                // Task-chain meta lives in the decoupled `.task` sidecar (set at
                // handoff), not the body — the body is overwritten every tick, so
                // these stay `None` here and `load` sources them from the sidecar.
                prev_uuid: None,
                summary_path: None,
                // Title/summary likewise sidecar-sourced on `load` (`.title`/
                // `.summary.md`), so the per-tick body write never clobbers them.
                title: None,
                summary: None,
            };
            let _ = core_lib::snapshot::save(&base, &cwd, &snap);
        }
    }

    // The PTY died on its own (claude exited) — drop the runtime entry so a later
    // id collision can't see stale live/driver state (review R7-3 cleanup).
    let mut existed = false;
    if let Some(state) = app.try_state::<ClaudeState>() {
        if let Ok(mut rt) = state.rt.lock() {
            if let Some(sess) = rt.by_id.remove(&id) {
                rt.live.remove(&(sess.project, sess.uuid));
                existed = true;
            }
        }
    }
    // Notify any mirror windows that the session ended (review P6-impl #2).
    if existed {
        let _ = app.emit("claude-session-closed", id);
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

/// Force-close a Claude session regardless of viewers: stop the poll thread and
/// kill the PTY (every attached window's relay ends). Used by "삭제" and as a
/// hard close; the normal per-window close is `claude_detach` (refcount). The
/// persisted timeline is kept unless separately deleted.
#[tauri::command]
pub fn claude_close(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
) -> Result<(), AppError> {
    let stop = {
        let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        rt.by_id.remove(&id).map(|s| {
            rt.live.remove(&(s.project.clone(), s.uuid.clone()));
            s.stop
        })
    };
    if let Some(stop) = stop {
        stop.store(true, Ordering::Relaxed);
    }
    let res = mgr.remove(id).map_err(AppError::new);
    // Tell every window the session is gone so mirrors don't linger as dead UI
    // (review P6-impl #2).
    let _ = app.emit("claude-session-closed", id);
    res
}
