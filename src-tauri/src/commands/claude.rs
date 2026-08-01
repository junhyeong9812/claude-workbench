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
/// P1: 표시 계층 content_text 상한 — payload·스냅샷에서만 절단(원본 JSONL·
/// 아카이브는 전문 유지). 절단 아이템은 `content_truncated`로 표시되고
/// 뷰어가 `claude_item_detail`로 원문을 lazy 조회한다.
pub(crate) const CONTENT_CAP: usize = 32 * 1024;

/// UTF-8 경계 보존 절단 — 순수 (P1 특성테스트 대상).
pub(crate) fn cap_content(items: &mut [TimelineItem]) {
    for it in items.iter_mut() {
        if let Some(ct) = &it.content_text {
            if ct.len() > CONTENT_CAP {
                let mut n = CONTENT_CAP;
                while n > 0 && !ct.is_char_boundary(n) {
                    n -= 1;
                }
                it.content_text = Some(ct[..n].to_string());
                it.content_truncated = true;
            }
        }
    }
}

/// 파일 서명 (len, mtime ns) — 완료 판정·재활성 감지 입력 (P0 B2, 리뷰
/// 재수정: len 단독은 truncate·동일 길이 재작성·mtime-only 변경을 놓친다).
pub(crate) type FileSig = (u64, u128);

fn file_sig(p: &std::path::Path) -> Option<FileSig> {
    let m = std::fs::metadata(p).ok()?;
    let mt = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((m.len(), mt))
}

/// P0 B2: 완료된 서브에이전트의 보존 프레임 — tail(파서·버퍼·폴링)은 드롭하고
/// payload에 계속 실릴 items만 남긴다. `sig`는 완료 판정 시점의 파일 서명 —
/// 서명이 달라지면(성장·축소·재작성) tail을 재생성해 재개한다.
pub(crate) struct DoneSub {
    pub(crate) turn: u64,
    pub(crate) sig: FileSig,
    pub(crate) items: Vec<TimelineItem>,
    pub(crate) rev: u32,
}

/// 파일 서명 안정 스트릭 전이 — 순수 (P0 B2 특성테스트 대상).
/// 서명 동일 → +1 · 서명 변화 → 리셋 · **metadata 실패(None) → 진행하지
/// 않고 리셋**(리뷰: 실패 40회 누적으로 완료 오판하던 경로 차단).
pub(crate) fn advance_stability(
    prev: (Option<FileSig>, u32),
    sig: Option<FileSig>,
) -> (Option<FileSig>, u32) {
    match (prev.0, sig) {
        (Some(a), Some(b)) if a == b => (Some(a), prev.1 + 1),
        (_, Some(b)) => (Some(b), 0),
        (_, None) => (prev.0, 0),
    }
}

/// 활성 + 완료 프레임을 **발견 순서**로 조립 — 순수 (P0 B2, 리뷰 재수정:
/// active-뒤-done 병합은 순회 순서를 바꿔 미확정 부모의 first-match 후보
/// 순위를 흔든다. 발견 순서는 결정적이며 기존 HashMap 비결정 순회의 유효한
/// 정밀화 — spec §2 B2 순서 명세는 log에 기록).
/// 보존 계약: 완료 에이전트의 (aid, turn, items)가 계속 포함되고, 재활성
/// 재파싱이 끝나 active items가 비어 있지 않으면 active가 우선한다.
pub(crate) fn ordered_frames(
    order: &[String],
    mut active: HashMap<String, (u64, Vec<TimelineItem>)>,
    done: &HashMap<String, DoneSub>,
) -> Vec<(String, u64, Vec<TimelineItem>)> {
    let mut out = Vec::new();
    for aid in order {
        if let Some((turn, items)) = active.remove(aid) {
            if !items.is_empty() {
                out.push((aid.clone(), turn, items));
                continue;
            }
            // 활성이지만 아직 빈 tail(재활성 재파싱 전 등) — done 폴백 시도.
        }
        if let Some(d) = done.get(aid) {
            out.push((aid.clone(), d.turn, d.items.clone()));
        }
    }
    out
}

#[cfg_attr(not(test), allow(dead_code))] // 특성테스트의 naive 기준 구현(메모판과 동치 검증용)
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

/// P0 B1(리뷰 재수정 — Some-동결 캐시는 "늦게 채워진 상위 후보로의 부모
/// 교체"라는 원본 동작을 잃는다): first-match를 **매 변경 틱 그대로 재계산**
/// 하되, 아이템별 `contains(aid)` 판정만 `(revision)` 키로 메모한다.
/// contains는 content_text에만 의존하고 content_text 변경은 revision bump를
/// 동반하므로(TimelineItem.revision: "Bumped on every merged update"),
/// 결과는 naive 스캔과 **완전 동일**하고 비용만 변경된 아이템으로 국한된다
/// (특성테스트: memo vs naive 동치·revision bump 반영).
pub(crate) fn subagent_parent_memo(
    aid: &str,
    main_items: &[TimelineItem],
    sub_raw: &[(String, u64, Vec<TimelineItem>)],
    memo: &mut HashMap<(String, String, String), (u32, bool)>,
) -> Option<String> {
    // 키 = (aid, **session_id**, tool_call_id) — tool_call_id만으로는 다른
    // 세션(다른 서브에이전트 transcript)의 동일 id와 충돌해 앞 아이템의
    // 판정이 뒤 아이템에 재사용된다(재점검 N1-1). revision 계약은 같은
    // Timeline 안에서만 유효하므로 재파싱 재구축 시 호출부가 해당 소스의
    // 메모를 무효화한다(N1-2 — purge_mention_memo_for_source).
    fn mentions(
        aid: &str,
        it: &TimelineItem,
        memo: &mut HashMap<(String, String, String), (u32, bool)>,
    ) -> bool {
        let key = (aid.to_string(), it.session_id.clone(), it.tool_call_id.clone());
        if let Some((rev, m)) = memo.get(&key) {
            if *rev == it.revision {
                return *m;
            }
        }
        let m = it.content_text.as_deref().is_some_and(|ct| ct.contains(aid));
        memo.insert(key, (it.revision, m));
        m
    }
    for it in main_items {
        if mentions(aid, it, memo) {
            return Some(it.tool_call_id.clone());
        }
    }
    for (other, _, its) in sub_raw {
        if other == aid {
            continue;
        }
        for it in its {
            if mentions(aid, it, memo) {
                return Some(it.tool_call_id.clone());
            }
        }
    }
    None
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
    // P0 B3(리뷰 재수정): cwd → worktree root 캐시. 세션 수명 동안 불변이
    // 전제(spec 가정①)이므로 ①**성공(Some) 결과만** 캐시(비-repo 폴백을
    // 캐시하면 이후 git init을 영구히 못 본다 — B1과 대칭) ②라이브 세션에
    // 없는 cwd 엔트리는 매 호출 prune — 캐시 수명이 세션 수명을 넘지 않는다.
    static ROOT_CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
        std::sync::OnceLock::new();
    let cache = ROOT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let live: std::collections::HashSet<&String> = cwds.iter().map(|(_, c)| c).collect();
    if let Ok(mut c) = cache.lock() {
        c.retain(|k, _| live.contains(k));
    }
    cwds.into_iter()
        .map(|(uuid, cwd)| {
            let cached = cache.lock().ok().and_then(|c| c.get(&cwd).cloned());
            let root = match cached {
                Some(r) => r,
                None => match core_lib::git::worktree_root(&cwd) {
                    Some(r) => {
                        if let Ok(mut c) = cache.lock() {
                            c.insert(cwd.clone(), r.clone());
                        }
                        r
                    }
                    None => cwd.clone(), // 비-repo/실패 — 캐시하지 않고 매번 재시도
                },
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
    // P0 B1: 아이템별 contains(aid) 메모 — (aid, session_id, tool_call_id) →
    // (revision, 결과). first-match는 매 변경 틱 재계산(동결 없음).
    let mut mention_memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
    // P0 B2/N2: 재활성(Timeline 재구축) 세대 — revision이 리셋되어 내용이
    // 달라도 fp가 같아질 수 있으므로 fp에 합산해 emit 누락을 막는다.
    let mut sub_gen: u64 = 0;
    // P0 B2: 완료 서브에이전트(파일 서명 DONE_STREAK 연속 안정) — tail 드롭,
    // items 보존. 서명 변화 시 같은 틱에 재파싱까지 마쳐 원자 교체.
    let mut sub_done: HashMap<String, DoneSub> = HashMap::new();
    let mut sub_stable: HashMap<String, (Option<FileSig>, u32)> = HashMap::new();
    let mut sub_path: HashMap<String, PathBuf> = HashMap::new();
    // 서브에이전트 최초 발견 순서 — 프레임 조립·부모 탐색 순서의 결정적 기준
    // (기존 HashMap 비결정 순회의 정밀화, 리뷰 재수정).
    let mut sub_order: Vec<String> = Vec::new();
    // 60초(150ms×400) 연속 무변화 = 완료로 간주 — 리뷰: 6초는 긴 툴 실행
    // 대기(cargo test 등)마다 완료↔재활성 churn + 전체 재파싱을 유발한다.
    const DONE_STREAK: u32 = 400;
    // P1: 스냅샷 저장 debounce 상태.
    const SAVE_DEBOUNCE: Duration = Duration::from_secs(2);
    let mut snap_dirty = false;
    let mut last_save = std::time::Instant::now()
        .checked_sub(SAVE_DEBOUNCE)
        .unwrap_or_else(std::time::Instant::now);
    // Cheap fingerprint of the last emitted state (incl. subagent item count). A
    // prompt- or answer-only record advances turns/answers without touching any
    // tool item, so we can't key off `poll`'s touched indices alone.
    let mut last_fp: (usize, u32, usize, usize, usize, usize, u64, u64, u64, u64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

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

        // P1(듀얼 리뷰 #1·#2, 감사 B1): 스냅샷 debounce 플러시 — emit의 fp
        // 게이트와 poll의 `continue`보다 **앞**, 매 틱 검사한다. 변화가 멎어도
        // (또는 일시 read 오류 틱에도) 마지막 변화 후 ~SAVE_DEBOUNCE에 트레일링
        // 엣지가 반드시 착지한다(게이트 뒤에 두면 무변화 틱이 건너뛰어 마지막
        // 턴이 영구 미저장 — 정상 종료마다 재현). stop을 조건에서 재검사해
        // close 직후 delete가 스냅샷 재생성으로 덮이지 않게 한다(F4 — 구현 전과
        // 동일한 보장 지점). 무변화 틱 비용은 Instant 비교 1회.
        if snap_dirty && !stop.load(Ordering::Relaxed) && last_save.elapsed() >= SAVE_DEBOUNCE {
            // last_save는 성공/실패 무관 갱신(실패 핫루프 방지 — 2s 간격 재시도),
            // dirty는 본문 save() 성공 시에만 해제 — 일시 디스크 오류 1회가 그
            // 시점까지의 변화를 저장 대상에서 영구히 빼지 않는다(#2).
            last_save = std::time::Instant::now();
            if let Ok(base) = app.path().app_data_dir() {
                // Read the rename override (decoupled file) rather than the
                // body's own name, so a concurrent rename isn't clobbered (F1).
                let name = core_lib::snapshot::read_name(&base, &cwd, &uuid)
                    .unwrap_or_else(|| initial_name.clone());
                let date = chrono::Local::now().format("%Y-%m-%d").to_string();
                // 스냅샷 본문은 **전문**(절단 없음 — 듀얼 리뷰 #3). 절단은 IPC
                // 반환 경계(emit payload·claude_session_snapshot)에서만 —
                // 절단본을 디스크 정본 캐시로 남기면 CLI가 원본 JSONL을
                // 로테이트한 뒤 복구 불능이 된다. 디스크 쓰기 크기는 병목이
                // 아니다(병목 = 직렬화 CPU·IPC·DOM).
                let snap = core_lib::snapshot::SessionSnapshot {
                    uuid: uuid.clone(),
                    name,
                    date,
                    items: t.timeline().items().to_vec(),
                    turns: t.turns().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    answers: t.answers().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    dates: t.dates().iter().map(|(k, v)| (*k, v.clone())).collect(),
                    tokens: t.tokens().iter().map(|(k, v)| (*k, *v)).collect(),
                    model: t.model().map(str::to_string),
                    last_usage: t.last_usage(),
                    // Task-chain meta lives in the decoupled `.task` sidecar (set
                    // at handoff), not the body — `load` sources them from there.
                    prev_uuid: None,
                    summary_path: None,
                    // Title/summary likewise sidecar-sourced on `load`.
                    title: None,
                    summary: None,
                };
                // save 직전 stop 재검사 — close→delete와의 경합 창을 syscall
                // 하나로 좁힌다(구 구현과 동급 이하). 완전 봉쇄는 delete와의
                // 락 공유가 필요해 P6(session 락 정리) 후보로 기록(고유 잔존).
                if !stop.load(Ordering::Relaxed)
                    && core_lib::snapshot::save(&base, &cwd, &snap).is_ok()
                {
                    snap_dirty = false;
                }
            }
        }
        if t.poll().is_err() {
            continue; // transient read error — retry next tick (플러시는 이미 수행)
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
                    // P0 B2: 완료 처리된 에이전트(활성 tail 없음)는 파일 서명이
                    // 달라질 때만 tail을 재생성한다. **같은 틱에 전체 재파싱
                    // (poll)까지 마치고**, items가 생겼을 때에만 done을 지운다
                    // — 전이 틱 프레임 공백 없음. 이미 재활성된(활성 tail 존재)
                    // 에이전트는 이 분기를 타지 않는다 — 빈 재파싱이 틱마다
                    // 재생성·재-emit 루프를 돌던 경로 차단(재점검 2차 P1).
                    if !subagents.contains_key(&aid) {
                        if let Some(d) = sub_done.get(&aid) {
                            if let Some(sig) = file_sig(&f) {
                                if sig != d.sig {
                                    // N1-2(재수정): 재구축은 revision을 리셋한다
                                    // — 옛 items의 (session_id, tool_call_id)
                                    // 메모 키를 정확히 무효화(레코드 sessionId가
                                    // 생성자 id보다 우선하므로 sid==aid 가정
                                    // 불가 — 실코드 확인 map.rs L79-81).
                                    let stale: std::collections::HashSet<(&str, &str)> = d
                                        .items
                                        .iter()
                                        .map(|it| (it.session_id.as_str(), it.tool_call_id.as_str()))
                                        .collect();
                                    mention_memo.retain(|(_, sid, tcid), _| {
                                        !stale.contains(&(sid.as_str(), tcid.as_str()))
                                    });
                                    let mut st = core_lib::jsonl::SessionTail::new(
                                        cwd.clone(),
                                        aid.clone(),
                                        f.clone(),
                                    );
                                    let _ = st.poll();
                                    if !st.timeline().items().is_empty() {
                                        sub_done.remove(&aid);
                                        // N2: done 실제 제거(교체 확정) 시점에만
                                        // 세대 증가 — 빈 재파싱은 증가 없음.
                                        sub_gen += 1;
                                    }
                                    sub_stable.remove(&aid);
                                    sub_path.insert(aid.clone(), f);
                                    subagents.insert(aid, st);
                                }
                            }
                            continue;
                        }
                    }
                    // (재활성 후 아직 빈 tail인 done 병존 에이전트는 아래 정상
                    // poll 경로가 증분을 잇는다 — 재생성 없음.)
                    if !subagents.contains_key(&aid) {
                        subagent_turn.insert(aid.clone(), t.current_turn());
                        if !sub_order.contains(&aid) {
                            sub_order.push(aid.clone());
                        }
                    }
                    sub_path.insert(aid.clone(), f.clone());
                    let st = subagents.entry(aid.clone()).or_insert_with(|| {
                        core_lib::jsonl::SessionTail::new(cwd.clone(), aid.clone(), f)
                    });
                    let _ = st.poll();
                }
            }
        }
        // P0 B2: 완료 전이 스윕 — 파일 서명이 DONE_STREAK 연속 무변화면
        // tail을 드롭하고 items만 보존한다(빈 tail·metadata 실패는 완료
        // 후보 아님). 재활성 재파싱이 items를 만든 에이전트의 잔여 done은
        // 정리(active 우선).
        let done_before = sub_done.len();
        sub_done.retain(|aid, _| {
            !subagents
                .get(aid)
                .map(|st| !st.timeline().items().is_empty())
                .unwrap_or(false)
        });
        if sub_done.len() != done_before {
            sub_gen += 1; // 지연 교체 확정(빈 tail → 증분으로 items 도달) — N2
        }
        let mut newly_done: Vec<(String, FileSig)> = Vec::new();
        for (aid, st) in subagents.iter() {
            let Some(p) = sub_path.get(aid) else { continue };
            let sig = file_sig(p);
            let prev = sub_stable.get(aid).copied().unwrap_or((None, 0));
            let next = advance_stability(prev, sig);
            sub_stable.insert(aid.clone(), next);
            if next.1 >= DONE_STREAK && !st.timeline().items().is_empty() {
                if let Some(s) = next.0 {
                    newly_done.push((aid.clone(), s));
                }
            }
        }
        for (aid, sig) in newly_done {
            if let Some(st) = subagents.remove(&aid) {
                let items = st.timeline().items().to_vec();
                let rev: u32 = items.iter().map(|i| i.revision).sum();
                sub_stable.remove(&aid);
                let turn = *subagent_turn.get(&aid).unwrap_or(&0);
                sub_done.insert(aid, DoneSub { turn, sig, items, rev });
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
            sub_gen, // N2: 재활성 세대 — 재구축으로 rev 합이 같아도 emit 보장
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
        // P0 B2: 발견 순서로 활성+완료 프레임 조립(특성테스트 ordered_frames_*)
        // — 완료 프레임 보존 + active(재파싱 완료) 우선 + 결정적 순서.
        let active_map: HashMap<String, (u64, Vec<TimelineItem>)> = subagents
            .iter()
            .map(|(aid, st)| {
                (
                    aid.clone(),
                    (*subagent_turn.get(aid).unwrap_or(&0), st.timeline().items().to_vec()),
                )
            })
            .collect();
        let sub_raw = ordered_frames(&sub_order, active_map, &sub_done);
        // Link each agent to the timeline item (the spawning `Agent`/`Task` call)
        // whose result mentions the agent id — that item, in main or in a parent
        // agent, is its parent (recursive tree). `None` ⇒ nest under its turn.
        // P0 B1(재수정): first-match를 매 변경 틱 그대로 재계산하되, 아이템별
        // contains 판정만 revision 키로 메모 — naive와 완전 동치(부모 승격
        // 포함), 비용은 변경 아이템으로 국한(재점검 N3 주석 정정).
        // 부모 추론은 **절단 전** 원문으로(멘션이 32KB 밖에 있을 수 있다 —
        // P1 절단은 그 뒤 표시용 클론에만 적용).
        let parents: Vec<Option<String>> = sub_raw
            .iter()
            .map(|(aid, _, _)| subagent_parent_memo(aid, &items_v, &sub_raw, &mut mention_memo))
            .collect();
        // P1: 표시 계층 절단 + payload는 clone 없이 move(스냅샷은 아래 debounce
        // 블록이 t에서 재구성 — 틱당 딥클론 2회→1회).
        let mut items_p = items_v;
        cap_content(&mut items_p);
        let subagents_v: Vec<(String, Option<String>, u64, Vec<TimelineItem>)> = sub_raw
            .into_iter()
            .zip(parents)
            .map(|((aid, turn, mut its), parent)| {
                cap_content(&mut its);
                (aid, parent, turn, its)
            })
            .collect();

        let _ = app.emit(
            "claude-timeline",
            ClaudeTimelinePayload {
                id,
                items: items_p,
                turns: turns_v,
                answers: answers_v,
                dates: dates_v,
                tokens: tokens_v,
                model: model_v,
                last_usage: last_usage_v,
                subagents: subagents_v,
            },
        );
        // 저장 자체는 위(틱 진입부) debounce 플러시가 수행한다 — 여기서는
        // dirty 마킹만. Persisting keeps the session listable/reopenable across
        // restarts (D-1) without the append duplication.
        snap_dirty = true;

        if stop.load(Ordering::Relaxed) {
            break; // closed during poll/emit — don't persist after close (F4)
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

/// P1: 절단된 아이템의 원문 상세 — 전문 스냅샷 우선, 부재 시 원본 JSONL
/// (+서브에이전트 transcript)에서 재추출(read-only, mapper 결정적 — spec
/// 가정②). 뷰어가 `content_truncated` 아이템 선택 시 lazy 호출.
#[derive(Serialize)]
pub struct ItemDetail {
    pub content_text: Option<String>,
    pub raw_input: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn claude_item_detail(
    app: AppHandle,
    project: String,
    uuid: String,
    tool_call_id: String,
) -> Result<ItemDetail, AppError> {
    // 커맨드 경계에서 uuid를 명시 검증(#6) — 아래 경로 탐색(find_session_jsonl·
    // 서브에이전트 dir join)에 통제 밖 문자열이 들어가지 않게 한 줄로 막는다.
    if !core_lib::snapshot::is_safe_uuid(&uuid) {
        return Err(AppError::new("Invalid session id"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let detail_of = |it: &TimelineItem| ItemDetail {
            content_text: it.content_text.clone(),
            raw_input: it.raw_input.clone(),
        };
        // 1) 스냅샷 우선(#3·#20) — 디스크 본문은 전문이므로 대부분 여기서 끝난다
        //    (수 MB 파싱 1회, transcript 수십 MB 재파싱 회피). 구버전(절단 저장)
        //    스냅샷의 아이템은 content_truncated가 남아 있으므로 폴백으로 넘긴다.
        if let Ok(base) = app.path().app_data_dir() {
            if let Some(snap) = core_lib::snapshot::load(&base, &project, &uuid) {
                if let Some(it) = snap
                    .items
                    .iter()
                    .find(|i| i.tool_call_id == tool_call_id && !i.content_truncated)
                {
                    return Ok(detail_of(it));
                }
            }
        }
        // 2) 원본 JSONL 폴백 — 스냅샷 부재/미포함(서브에이전트 아이템 등).
        let root = core_lib::jsonl::claude_projects_root()
            .ok_or_else(|| AppError::new("Cannot locate the Claude projects root"))?;
        let jsonl = core_lib::jsonl::find_session_jsonl(&root, &uuid)
            .map_err(|e| AppError::new(io_message("Locate transcript", &e)))?
            .ok_or_else(|| AppError::new("Session transcript not found"))?;
        // 본 세션 transcript 전체 재파싱(온디맨드 1회 — 클릭당 수십~수백 ms).
        let mut t = core_lib::jsonl::SessionTail::new(project.clone(), uuid.clone(), jsonl.clone());
        t.poll().map_err(|e| AppError::new(io_message("Read transcript", &e)))?;
        if let Some(it) = t.timeline().items().iter().find(|i| i.tool_call_id == tool_call_id) {
            return Ok(detail_of(it));
        }
        // 서브에이전트 transcript들 (poll 루프와 동일 규칙: <jsonl stem>/subagents/*.jsonl).
        let sub_dir = jsonl.with_extension("").join("subagents");
        if let Ok(entries) = std::fs::read_dir(&sub_dir) {
            for entry in entries.flatten() {
                let f = entry.path();
                if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let aid = f
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.trim_start_matches("agent-").to_string())
                    .unwrap_or_default();
                let mut st = core_lib::jsonl::SessionTail::new(project.clone(), aid, f);
                let _ = st.poll();
                if let Some(it) =
                    st.timeline().items().iter().find(|i| i.tool_call_id == tool_call_id)
                {
                    return Ok(detail_of(it));
                }
            }
        }
        Err(AppError::new("Timeline item not found in the transcript"))
    })
    .await
    .map_err(|_| AppError::new("Detail lookup task failed"))?
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
    let mut snap = core_lib::snapshot::load(&base, &project, &uuid)?;
    // P1(#3): 절단은 IPC 반환 경계에서만 — 디스크 본문은 전문 유지.
    cap_content(&mut snap.items);
    Some(snap)
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

    // P1 특성테스트 — 절단은 UTF-8 경계 보존 + 플래그, 상한 이하는 불변.
    #[test]
    fn cap_content_truncates_on_char_boundary_and_flags() {
        let long = "가".repeat(CONTENT_CAP); // 3바이트 문자 — 경계가 CAP에 안 떨어짐
        let mut items = vec![item("big", Some(&long)), item("small", Some("짧음")), item("none", None)];
        cap_content(&mut items);
        let big = &items[0];
        assert!(big.content_truncated);
        let ct = big.content_text.as_deref().unwrap();
        assert!(ct.len() <= CONTENT_CAP);
        assert!(ct.chars().all(|c| c == '가'), "경계 절단이 문자를 깨면 안 된다");
        assert!(!items[1].content_truncated);
        assert_eq!(items[1].content_text.as_deref(), Some("짧음"));
        assert!(!items[2].content_truncated);
    }

    // P0 B2 특성테스트 — 기대값 손계산.
    const SIG_A: FileSig = (100, 1);
    const SIG_B: FileSig = (150, 2);

    #[test]
    fn stability_streak_advances_resets_and_skips_metadata_failure() {
        assert_eq!(advance_stability((Some(SIG_A), 0), Some(SIG_A)), (Some(SIG_A), 1));
        assert_eq!(advance_stability((Some(SIG_A), 5), Some(SIG_A)), (Some(SIG_A), 6));
        assert_eq!(advance_stability((Some(SIG_A), 5), Some(SIG_B)), (Some(SIG_B), 0)); // 변화 → 리셋
        // 같은 len·다른 mtime = 재작성 감지 (len 단독 판정 회귀 방지)
        assert_eq!(advance_stability((Some((100, 1)), 5), Some((100, 9))), (Some((100, 9)), 0));
        // metadata 실패 → 스트릭 진행 금지(리셋), 마지막 서명 유지
        assert_eq!(advance_stability((Some(SIG_A), 39), None), (Some(SIG_A), 0));
        assert_eq!(advance_stability((None, 0), None), (None, 0));
    }

    fn done(turn: u64, items: Vec<TimelineItem>) -> DoneSub {
        let rev = items.iter().map(|i| i.revision).sum();
        DoneSub { turn, sig: SIG_A, items, rev }
    }

    #[test]
    fn ordered_frames_keeps_done_in_discovery_order_and_prefers_reparsed_active() {
        let order = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        let mut active: HashMap<String, (u64, Vec<TimelineItem>)> = HashMap::new();
        active.insert("a1".into(), (1, vec![item("l-1", None)])); // 활성
        active.insert("a3".into(), (3, vec![])); // 재활성 재파싱 전(빈 tail)
        let mut d: HashMap<String, DoneSub> = HashMap::new();
        d.insert("a2".into(), done(7, vec![item("d-2", None)])); // 완료
        d.insert("a3".into(), done(9, vec![item("d-3", None)])); // 전이 중 — done 폴백
        let out = ordered_frames(&order, active, &d);
        // 발견 순서 유지 + 완료 프레임 보존 + 빈 active는 done 폴백(공백 없음).
        assert_eq!(
            out.iter().map(|(aid, turn, its)| (aid.as_str(), *turn, its[0].tool_call_id.as_str())).collect::<Vec<_>>(),
            vec![("a1", 1, "l-1"), ("a2", 7, "d-2"), ("a3", 9, "d-3")]
        );
    }

    #[test]
    fn ordered_frames_active_wins_over_stale_done_after_reparse() {
        let order = vec!["a1".to_string()];
        let mut active: HashMap<String, (u64, Vec<TimelineItem>)> = HashMap::new();
        active.insert("a1".into(), (1, vec![item("new-1", None)]));
        let mut d: HashMap<String, DoneSub> = HashMap::new();
        d.insert("a1".into(), done(1, vec![item("old-1", None)]));
        let out = ordered_frames(&order, active, &d);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].2[0].tool_call_id, "new-1"); // 재파싱된 active 우선
    }

    // P0 B1(재수정) — 메모 스캔이 naive와 완전 동치인지 + revision bump 반영.
    #[test]
    fn parent_memo_matches_naive_and_tracks_revision_updates() {
        let mut memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
        let mut main = vec![item("call-1", Some("nothing")), item("call-2", Some("spawn agent-A"))];
        let subs = vec![agent("agent-A", vec![])];
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
        // 더 이른 아이템(call-1)의 content_text가 나중에 갱신되어(revision bump)
        // aid를 언급하면 — naive처럼 부모가 call-1로 "승격"되어야 한다(동결 금지).
        main[0] = {
            let mut it = item("call-1", Some("late mention of agent-A"));
            it.revision = 2;
            it
        };
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            Some("call-1".to_string())
        );
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
    }

    /// 재점검 N1-1: 다른 세션(다른 transcript)의 동일 tool_call_id·동일
    /// revision이 있어도 메모가 충돌하지 않아야 한다 — 키에 session_id 포함.
    #[test]
    fn parent_memo_does_not_collide_across_sessions() {
        fn item_in(sid: &str, tcid: &str, ct: Option<&str>) -> TimelineItem {
            let mut it = item(tcid, ct);
            it.session_id = sid.to_string();
            it
        }
        let mut memo: HashMap<(String, String, String), (u32, bool)> = HashMap::new();
        // main의 "dup"(미언급)이 먼저 스캔되고, agent-B transcript의 "dup"
        // (언급, 같은 revision)이 뒤에 온다 — naive는 b쪽 dup을 부모로 찾는다.
        let main = vec![item_in("main", "dup", Some("nothing"))];
        let subs = vec![
            agent("agent-A", vec![]),
            ("agent-B".to_string(), 1, vec![item_in("agent-B", "dup", Some("spawn agent-A"))]),
        ];
        assert_eq!(
            subagent_parent_memo("agent-A", &main, &subs, &mut memo),
            subagent_parent("agent-A", &main, &subs)
        );
        assert_eq!(subagent_parent_memo("agent-A", &main, &subs, &mut memo), Some("dup".into()));
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
