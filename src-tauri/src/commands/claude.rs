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

/// 서브에이전트의 부모(스폰한 `Agent`/`Task` 툴콜) 추론 — 순수 (P0 B1).
/// main 타임라인 → *다른* 에이전트 순으로 첫 매치(결과 텍스트가 agent id를
/// 언급하는 아이템). 자기 transcript는 제외 — 자기 id 에코가 self-parent가
/// 되어 트리에서 사라지는 회귀 방지(codex B1 F1). 동작 보존: 기존 인라인
/// 체인 스캔과 동일한 순회 순서·판정(특성테스트 subagent_parent_*).
/// P0 B2: 완료된 서브에이전트의 보존 프레임 — tail(파서·버퍼)은 드롭하고
/// payload에 계속 실릴 items만 남긴다. `len`은 완료 판정 시점의 파일 크기로,
/// 파일이 다시 자라면(len 초과) tail을 재생성해 재개한다(가정② 무해화).
pub(crate) struct DoneSub {
    pub(crate) turn: u64,
    pub(crate) len: u64,
    pub(crate) items: Vec<TimelineItem>,
    pub(crate) rev: u32,
}

/// 파일 길이 안정 스트릭 전이 — 순수 (P0 B2 특성테스트 대상).
/// 같은 길이면 스트릭 +1, 변하면 리셋.
pub(crate) fn advance_stability(prev: (u64, u32), len: u64) -> (u64, u32) {
    if prev.0 == len {
        (len, prev.1 + 1)
    } else {
        (len, 0)
    }
}

/// 활성 + 완료 서브에이전트 프레임 병합 — 순수. 보존 계약: 완료된 에이전트의
/// (aid, turn, items)가 payload에 **계속 포함**된다(스냅샷·트리 표시 불변).
/// 순서는 원래도 HashMap 순회라 비결정적이었으므로 집합 동일성만이 계약.
pub(crate) fn merge_sub_frames(
    mut active: Vec<(String, u64, Vec<TimelineItem>)>,
    done: &HashMap<String, DoneSub>,
) -> Vec<(String, u64, Vec<TimelineItem>)> {
    for (aid, d) in done {
        active.push((aid.clone(), d.turn, d.items.clone()));
    }
    active
}

pub(crate) fn subagent_parent(
    aid: &str,
    main_items: &[TimelineItem],
    sub_raw: &[(String, u64, Vec<TimelineItem>)],
) -> Option<String> {
    main_items
        .iter()
        .chain(
            sub_raw
                .iter()
                .filter(|(other, _, _)| other != aid)
                .flat_map(|(_, _, x)| x.iter()),
        )
        .find(|it| it.content_text.as_deref().is_some_and(|ct| ct.contains(aid)))
        .map(|it| it.tool_call_id.clone())
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
    let mut cmd = vec!["claude".to_string(), flag.to_string(), session_uuid.clone()];

    // hook-status: 수신기가 살아 있으면 세션 한정 hook 설정을 주입한다
    // (--settings 인자 — 사용자 ~/.claude 무수정, spec §2). 세션별 토큰은
    // 0600 헤더 파일로 쓰고 경로만 env로 전달 — claude/curl 어느 쪽 argv에도
    // 토큰 값이 실리지 않는다(리뷰 H1·H4). 수신기 기동/등록 실패는 주입
    // 생략 = 프론트 화면 스캔 폴백 (기능 저하, 세션은 정상).
    let mut envs: Vec<(String, String)> = Vec::new();
    if let Some(hook) = super::hookserver::ensure_started(app) {
        if let Some(hdr_path) = hook.register_session(&session_uuid) {
            cmd.push("--settings".to_string());
            cmd.push(super::hookserver::hook_settings_json());
            envs.push(("WORKBENCH_HOOK_PORT".to_string(), hook.port.to_string()));
            envs.push(("WORKBENCH_HOOK_HDR".to_string(), hdr_path));
        }
    }

    let id = mgr
        .create_with_env(Some(cmd), Some(cwd.clone()), cols, rows, envs)
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

    // 이 프로젝트에 아카이브 지식이 있으면 .mcp.json 등록을 보장 — 새로 뜨는
    // claude가 지식 서버(search_knowledge)를 바로 쓸 수 있게 (best-effort).
    super::ensure_mcp_registration(&app, &cwd);

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
    // P0 B3: cwd → worktree root 캐시. 세션 cwd는 스폰 시 고정이고 root도
    // 세션 수명 동안 불변(spec 가정①)인데, 4초 폴링마다 세션 수만큼
    // `git rev-parse` 서브프로세스를 띄우던 것을 첫 조회 후 재사용한다.
    static ROOT_CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
        std::sync::OnceLock::new();
    let cache = ROOT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    cwds.into_iter()
        .map(|(uuid, cwd)| {
            let cached = cache.lock().ok().and_then(|c| c.get(&cwd).cloned());
            let root = match cached {
                Some(r) => r,
                None => {
                    let r = core_lib::git::worktree_root(&cwd).unwrap_or_else(|| cwd.clone());
                    if let Ok(mut c) = cache.lock() {
                        c.insert(cwd.clone(), r.clone());
                    }
                    r
                }
            };
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
    // P0 B1: agent id → 확정된 부모 tool_call_id (Some만 저장 — 불변 링크 캐시).
    let mut parent_cache: HashMap<String, Option<String>> = HashMap::new();
    // P0 B2: 완료 서브에이전트(파일 길이 DONE_STREAK 연속 안정) — tail은
    // 드롭하고 items만 보존. 재성장 시 재생성.
    let mut sub_done: HashMap<String, DoneSub> = HashMap::new();
    let mut sub_stable: HashMap<String, (u64, u32)> = HashMap::new();
    let mut sub_path: HashMap<String, PathBuf> = HashMap::new();
    /// ~6초(150ms×40) 연속 무성장 = 완료로 간주.
    const DONE_STREAK: u32 = 40;
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
                    // P0 B2: 완료 처리된 에이전트는 파일이 다시 자랄 때만
                    // tail을 재생성(전체 재파싱 — mapper는 결정적이라 동일
                    // items 재구성), 아니면 폴링을 건너뛴다.
                    if let Some(d) = sub_done.get(&aid) {
                        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        if len > d.len {
                            sub_done.remove(&aid);
                            sub_stable.remove(&aid);
                            subagents.insert(
                                aid.clone(),
                                core_lib::jsonl::SessionTail::new(cwd.clone(), aid.clone(), f.clone()),
                            );
                            sub_path.insert(aid, f);
                        }
                        continue;
                    }
                    if !subagents.contains_key(&aid) {
                        subagent_turn.insert(aid.clone(), t.current_turn());
                    }
                    sub_path.insert(aid.clone(), f.clone());
                    let st = subagents.entry(aid.clone()).or_insert_with(|| {
                        core_lib::jsonl::SessionTail::new(cwd.clone(), aid.clone(), f)
                    });
                    let _ = st.poll();
                }
            }
        }
        // P0 B2: 완료 전이 스윕 — 파일 길이가 DONE_STREAK 연속 무성장이면
        // tail을 드롭하고 items만 보존한다(빈 tail은 계속 활성 — 곧 자랄 수
        // 있는 신생 파일).
        let mut newly_done: Vec<String> = Vec::new();
        for (aid, st) in subagents.iter() {
            let Some(p) = sub_path.get(aid) else { continue };
            let len = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let prev = sub_stable.get(aid).copied().unwrap_or((len, 0));
            let next = advance_stability(prev, len);
            sub_stable.insert(aid.clone(), next);
            if next.1 >= DONE_STREAK && !st.timeline().items().is_empty() {
                newly_done.push(aid.clone());
            }
        }
        for aid in newly_done {
            if let Some(st) = subagents.remove(&aid) {
                let items = st.timeline().items().to_vec();
                let rev: u32 = items.iter().map(|i| i.revision).sum();
                let len = sub_stable.remove(&aid).map(|e| e.0).unwrap_or(0);
                let turn = *subagent_turn.get(&aid).unwrap_or(&0);
                sub_done.insert(aid, DoneSub { turn, len, items, rev });
            }
        }

        // fingerprint·카운트는 활성+완료 합산 — 완료 전이가 payload 내용을
        // 바꾸지 않으므로 fp도 불변이어야 한다(전이 자체로 재-emit 없음).
        let done_rev: u32 = sub_done.values().map(|d| d.rev).sum();
        let done_count: usize = sub_done.values().map(|d| d.items.len()).sum();
        let sub_rev: u32 = subagents
            .values()
            .flat_map(|st| st.timeline().items().iter().map(|i| i.revision))
            .sum::<u32>()
            + done_rev;
        let sub_count: usize =
            subagents.values().map(|st| st.timeline().items().len()).sum::<usize>() + done_count;

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
        let active_frames: Vec<(String, u64, Vec<TimelineItem>)> = subagents
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
        // P0 B2: 완료 프레임 병합 — payload/스냅샷 내용 보존(특성테스트
        // merge_sub_frames_*).
        let sub_raw = merge_sub_frames(active_frames, &sub_done);
        // Link each agent to the timeline item (the spawning `Agent`/`Task` call)
        // whose result mentions the agent id — that item, in main or in a parent
        // agent, is its parent (recursive tree). `None` ⇒ nest under its turn.
        // P0 B1: 링크는 한 번 확정되면 불변인데 매 틱 O(A×C) 전문 스캔을
        // 반복하던 것을 Some 결과만 캐시한다(None은 다음 틱 재탐색 — 스폰
        // 아이템의 content_text가 늦게 도착하는 기존 동작 보존).
        let subagents_v: Vec<(String, Option<String>, u64, Vec<TimelineItem>)> = sub_raw
            .iter()
            .map(|(aid, turn, its)| {
                let parent = match parent_cache.get(aid) {
                    Some(p) => p.clone(),
                    None => {
                        let p = subagent_parent(aid, &items_v, &sub_raw);
                        if p.is_some() {
                            parent_cache.insert(aid.clone(), p.clone());
                        }
                        p
                    }
                };
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

#[cfg(test)]
mod tests {
    use super::*;

    /// serde로 최소 필드 TimelineItem 픽스처 생성 (shell()은 pub(crate) of core).
    fn item(tool_call_id: &str, content_text: Option<&str>) -> TimelineItem {
        serde_json::from_value(serde_json::json!({
            "session_id": "s",
            "tool_call_id": tool_call_id,
            "turn": 1,
            "seq": 1,
            "kind": "execute",
            "title": "t",
            "locations": [],
            "project_label": null,
            "diffs": [],
            "content_text": content_text,
            "raw_input": null,
            "agent_status": "completed",
            "write_status": "none",
            "revision": 1
        }))
        .expect("fixture")
    }

    fn agent(aid: &str, items: Vec<TimelineItem>) -> (String, u64, Vec<TimelineItem>) {
        (aid.to_string(), 1, items)
    }

    // P0 B2 특성테스트 — 기대값 손계산.
    #[test]
    fn stability_streak_advances_and_resets() {
        assert_eq!(advance_stability((100, 0), 100), (100, 1)); // 무성장 → +1
        assert_eq!(advance_stability((100, 5), 100), (100, 6));
        assert_eq!(advance_stability((100, 5), 150), (150, 0)); // 성장 → 리셋
    }

    #[test]
    fn merge_keeps_done_agent_frames_in_payload() {
        let active = vec![agent("agent-live", vec![item("l-1", None)])];
        let mut done: HashMap<String, DoneSub> = HashMap::new();
        done.insert(
            "agent-done".into(),
            DoneSub { turn: 7, len: 42, items: vec![item("d-1", None)], rev: 1 },
        );
        let merged = merge_sub_frames(active, &done);
        // 완료 에이전트가 (원 turn과 함께) payload에 계속 포함된다 — 보존 계약.
        assert_eq!(merged.len(), 2);
        let d = merged.iter().find(|(aid, _, _)| aid == "agent-done").expect("done frame");
        assert_eq!(d.1, 7);
        assert_eq!(d.2[0].tool_call_id, "d-1");
        let l = merged.iter().find(|(aid, _, _)| aid == "agent-live").expect("live frame");
        assert_eq!(l.2[0].tool_call_id, "l-1");
    }

    // P0 B1 특성테스트 — 기대값 손계산 (자기참조 금지).
    #[test]
    fn subagent_parent_prefers_main_timeline_first_match() {
        let main = vec![
            item("call-1", Some("no mention")),
            item("call-2", Some("spawned agent-A here")),
            item("call-3", Some("agent-A again later")),
        ];
        let subs = vec![agent("agent-A", vec![])];
        // 첫 매치(call-2)가 이긴다 — call-3이 아니라.
        assert_eq!(subagent_parent("agent-A", &main, &subs), Some("call-2".into()));
    }

    #[test]
    fn subagent_parent_excludes_own_transcript_but_scans_others() {
        // 자기 transcript가 자기 id를 에코해도 self-parent가 되면 안 된다.
        let main = vec![item("m-1", Some("nothing"))];
        let subs = vec![
            agent("agent-A", vec![item("a-1", Some("I am agent-A"))]),
            agent("agent-B", vec![item("b-1", Some("delegating to agent-A"))]),
        ];
        // main 무매치 → 다른 에이전트(B)의 아이템이 부모.
        assert_eq!(subagent_parent("agent-A", &main, &subs), Some("b-1".into()));
        // B 자신은 어디에도 언급이 없으니 None.
        assert_eq!(subagent_parent("agent-B", &main, &subs), None);
    }

    #[test]
    fn subagent_parent_none_when_unmentioned_or_no_content() {
        let main = vec![item("m-1", None)];
        assert_eq!(subagent_parent("agent-X", &main, &[]), None);
    }
}
