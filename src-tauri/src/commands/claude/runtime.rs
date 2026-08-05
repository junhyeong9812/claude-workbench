//! 세션 수명·드라이버 전이(멀티윈도우 미러, P6) — P5 B-c 분할: 전이표는
//! [`ClaudeRuntime`] 순수 메서드(B-b), 커맨드는 그 호출 + 락 해제 후 부수효과.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use core_lib::SessionManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Window};

use crate::commands::{io_message, AppError};

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
    /// Recently delivered `request_id`s, newest last — the at-most-once ledger
    /// for identified writes (audit H1). Bounded: only the tail matters, since a
    /// retry follows its original within seconds.
    delivered: std::collections::VecDeque<String>,
}

/// How many delivered request ids one session remembers.
const DELIVERED_MEMORY: usize = 16;

/// Verdict of [`ClaudeRuntime::claim_write`] — what the command should do next.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum WriteClaim {
    /// Not this window's session to write to (mirror, or unknown id).
    NotDriver,
    /// These exact bytes already went in under this `request_id` — do nothing,
    /// and report success: the caller's intent is satisfied exactly once.
    AlreadyDelivered,
    /// Go ahead and write; on failure call [`ClaudeRuntime::release_write`].
    Fresh,
}

/// All live Claude sessions, behind ONE lock so `live`/`by_id` never tear
/// (review R7-3). Mutations + the *actions* to run after unlocking (PTY remove,
/// event emit) are computed under the lock; the side effects run after release.
#[derive(Default)]
pub(super) struct ClaudeRuntime {
    /// (project, uuid) -> live PTY id, so a 2nd window finds the running session.
    live: HashMap<(String, String), u64>,
    /// PTY id -> session.
    by_id: HashMap<u64, Sess>,
}

/// T1/T2(open_or_attach의 live 분기) 계산 결과 — 부수효과 없음(P5 B-b).
enum AttachLive {
    /// live 항목 없음(또는 uuid 미지정) — 신규 스폰(T3) 경로로.
    NotLive,
    /// live PTY에 attach(미러, 또는 고아 드라이버 승격 시 handoff Some).
    Attached {
        id: u64,
        driver: String,
        rev: u64,
        handoff: Option<(String, u64)>,
    },
    /// stale live 정리됨(PTY 소멸, T2) — 신규 스폰 경로로 낙하.
    Cleaned,
}

/// T5(detach) 계산 결과 — 부수효과(PTY remove·emit)는 락 해제 후 호출부가.
enum DetachAct {
    None,
    Close(Arc<AtomicBool>),
    Handoff(String, u64),
}

/// P5 B-b: 드라이버 전이표(조사 §2-3 T1~T7)를 **순수 메서드**로 — 락 안에서
/// 계산만 하고 부수효과(emit·mgr.remove)는 호출부가 락 해제 후 수행한다(I4).
/// 유일한 외부 판정이던 `mgr.exists`는 `pty_alive` 클로저로 주입 — 전 전이가
/// tauri 무의존이 되어 특성테스트가 커버리지 0이던 전이를 전수 고정한다.
impl ClaudeRuntime {
    /// T1/T2 — live uuid attach. 불변식: live↔by_id 동시 갱신(I1),
    /// 고아 드라이버(전송 창 I3의 복구) 승격 시 rev+1(I2).
    fn attach_live(
        &mut self,
        project: &str,
        uuid: Option<&str>,
        label: &str,
        pty_alive: impl FnOnce(u64) -> bool,
    ) -> AttachLive {
        let Some(u) = uuid else { return AttachLive::NotLive };
        let key = (project.to_string(), u.to_string());
        let Some(&id) = self.live.get(&key) else { return AttachLive::NotLive };
        if pty_alive(id) {
            if let Some(sess) = self.by_id.get_mut(&id) {
                if !sess.attached.iter().any(|l| l == label) {
                    sess.attached.push(label.to_string());
                }
                let mut handoff = None;
                if !sess.attached.iter().any(|l| l == &sess.driver) {
                    sess.driver = label.to_string();
                    sess.rev += 1;
                    handoff = Some((sess.driver.clone(), sess.rev));
                }
                return AttachLive::Attached {
                    id,
                    driver: sess.driver.clone(),
                    rev: sess.rev,
                    handoff,
                };
            }
        }
        // Stale live entry (PTY gone): clean BOTH maps + stop flag so
        // `claude_live_uuids` can't keep reporting it (review P6-impl #3).
        if let Some(s) = self.by_id.remove(&id) {
            s.stop.store(true, Ordering::Relaxed);
        }
        self.live.remove(&key);
        AttachLive::Cleaned
    }

    /// T3 — 신규 스폰 등록(driver=label, rev=0, 양 맵 동시).
    fn register(&mut self, id: u64, project: String, uuid: String, label: String, stop: Arc<AtomicBool>) {
        self.live.insert((project.clone(), uuid.clone()), id);
        self.by_id.insert(
            id,
            Sess {
                project,
                uuid,
                attached: vec![label.clone()],
                driver: label,
                rev: 0,
                stop,
                delivered: std::collections::VecDeque::new(),
            },
        );
    }

    /// Decide whether `label` may write to session `id`, and — when the write
    /// carries a `request_id` — whether it has already been delivered.
    ///
    /// **At-most-once for identified writes (audit H1).** A [적용] that times out
    /// on the frontend cannot cancel a `claude_write` already in flight, so the
    /// bytes may land *after* the requester gave up; if the user then retries,
    /// the prompt would be pasted twice. The frontend keeps the same
    /// `request_id` across a retry, and this ledger turns the second call into a
    /// no-op that still reports success — so exactly one copy lands no matter how
    /// the late-success and the retry interleave.
    ///
    /// The id is recorded **here**, before the write, so two concurrent calls
    /// can't both see "fresh"; a failed write calls [`Self::release_write`] to
    /// take it back (a write that never landed must stay retryable).
    ///
    /// `request_id: None` (keystrokes, seeds) skips the ledger entirely — those
    /// callers have always been fire-and-forget and their behaviour is unchanged.
    fn claim_write(&mut self, id: u64, label: &str, request_id: Option<&str>) -> WriteClaim {
        let Some(sess) = self.by_id.get_mut(&id) else { return WriteClaim::NotDriver };
        if sess.driver != label {
            return WriteClaim::NotDriver;
        }
        let Some(rid) = request_id else { return WriteClaim::Fresh };
        if sess.delivered.iter().any(|d| d == rid) {
            return WriteClaim::AlreadyDelivered;
        }
        if sess.delivered.len() >= DELIVERED_MEMORY {
            sess.delivered.pop_front();
        }
        sess.delivered.push_back(rid.to_string());
        WriteClaim::Fresh
    }

    /// Undo a claim whose write failed, so the same `request_id` can be retried.
    fn release_write(&mut self, id: u64, request_id: &str) {
        if let Some(sess) = self.by_id.get_mut(&id) {
            sess.delivered.retain(|d| d != request_id);
        }
    }

    /// T4 — 인수(테이크오버). None = 세션 없음. Some((driver, rev)):
    /// attach된 비드라이버만 실제 전이(rev+1); 그 외는 현재값 그대로(emit은
    /// 호출부가 `driver == label`일 때만 — I7 비대칭 보존).
    fn set_driver(&mut self, id: u64, label: &str) -> Option<(String, u64)> {
        match self.by_id.get_mut(&id) {
            Some(s) if s.attached.iter().any(|l| l == label) && s.driver != label => {
                s.driver = label.to_string();
                s.rev += 1;
                Some((s.driver.clone(), s.rev))
            }
            Some(s) => Some((s.driver.clone(), s.rev)), // already driver / not attached
            None => None,
        }
    }

    /// T5 — detach. None = 세션 없음. (a) 마지막 뷰어+close_if_last → Close
    /// (양 맵 제거) (b) 마지막 뷰어+전송 중 → None(PTY·driver 유지, I6)
    /// (c) 드라이버 이탈+잔여 → Handoff(attached[0], rev+1).
    fn detach(&mut self, id: u64, label: &str, close_if_last: bool) -> Option<(DetachAct, String, u64)> {
        let sess = self.by_id.get_mut(&id)?;
        sess.attached.retain(|l| l != label);
        if sess.attached.is_empty() {
            if close_if_last {
                let key = (sess.project.clone(), sess.uuid.clone());
                let stop = sess.stop.clone();
                self.by_id.remove(&id);
                self.live.remove(&key);
                Some((DetachAct::Close(stop), String::new(), 0))
            } else {
                // Transfer in progress: keep the PTY (target will attach); leave
                // driver as-is (target will set_driver).
                Some((DetachAct::None, sess.driver.clone(), sess.rev))
            }
        } else if sess.driver == label {
            sess.driver = sess.attached[0].clone();
            sess.rev += 1;
            Some((DetachAct::Handoff(sess.driver.clone(), sess.rev), sess.driver.clone(), sess.rev))
        } else {
            Some((DetachAct::None, sess.driver.clone(), sess.rev))
        }
    }

    /// T6/T7 — 강제 제거(양 맵). stop 플래그를 돌려준다 — T6(claude_close)는
    /// store 후 PTY remove, T7(poll 자연사)는 존재 여부만 쓴다.
    pub(super) fn remove_session(&mut self, id: u64) -> Option<Arc<AtomicBool>> {
        self.by_id.remove(&id).map(|s| {
            self.live.remove(&(s.project, s.uuid));
            s.stop
        })
    }
}

/// Managed state: all live Claude sessions (single lock).
#[derive(Default)]
pub struct ClaudeState {
    pub(super) rt: Mutex<ClaudeRuntime>,
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

/// Refuse to take over a transcript that something else is — or might be —
/// already running, checked at the last possible moment before the PTY starts.
///
/// The picker's verdict is a snapshot of `/proc` from when it was opened; a user
/// can leave it sitting while they go and resume that same session in a
/// terminal, and the adopt would then append to a transcript another CLI owns
/// (review #1: time-of-check/time-of-use). Re-establishing it here shrinks that
/// window to the spawn itself.
///
/// **Only the adopt path calls this.** The app's own sessions must never be
/// checked: we spawn them with `--resume <uuid>` on our own command line, so the
/// very act of running one makes it read as `Live` — a reopen after a crash, or
/// any path that races its own leftover process, would block itself forever.
///
/// Every failure here is a refusal, never a pass. In particular a **missing**
/// transcript is fatal on this path: adopt means continuing a session that
/// exists, and `spawn_claude` falls back to `--session-id` when it can't find
/// the file — so letting a missing transcript through would quietly create a
/// brand-new session wearing the id of the one the user clicked (audit B2).
fn recheck_adoptable(uuid: &str, cwd: &str) -> Result<(), AppError> {
    let Some(root) = core_lib::jsonl::claude_projects_root() else {
        return Err(AppError::new("Claude 전사 디렉토리를 찾을 수 없어 세션을 열지 않았습니다."));
    };
    let jsonl = match core_lib::jsonl::find_session_jsonl(&root, uuid) {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Err(AppError::new(
                "이 세션의 전사를 찾을 수 없습니다 — 그 사이 지워졌거나 옮겨진 것 같습니다. \
                 목록을 다시 열어 확인하세요.",
            ))
        }
        Err(e) => {
            return Err(AppError::new(io_message("이 세션의 전사를 찾지 못했습니다", &e)))
        }
    };
    let jsonl = jsonl.canonicalize().unwrap_or(jsonl);
    let dir = std::fs::canonicalize(cwd).unwrap_or_else(|_| std::path::PathBuf::from(cwd));
    let targets = std::iter::once(jsonl.clone()).collect();
    let probe = core_lib::live::LiveProbe::gather(
        std::path::Path::new("/proc"),
        &targets,
        std::process::id(),
    );
    match probe.classify(uuid, &jsonl, &dir) {
        core_lib::live::Liveness::Free => Ok(()),
        core_lib::live::Liveness::Live => Err(AppError::new(
            "이 세션은 지금 다른 곳에서 열려 있습니다 — 그 창을 닫은 뒤 다시 시도하세요. \
             (같은 전사에 두 프로세스가 쓰면 세션이 깨집니다)",
        )),
        core_lib::live::Liveness::Unknown => Err(AppError::new(
            "이 세션이 열려 있는지 확인할 수 없어 열지 않았습니다 \
             (같은 디렉토리에서 세션을 특정할 수 없는 claude가 돌고 있습니다).",
        )),
    }
}

/// Open a Claude session for THIS window: if its PTY is already live (another
/// window started it), attach as a read-only **mirror**; otherwise start a fresh
/// PTY and become the **driver**. Atomic under the runtime lock so two windows
/// can't both start the same session (review R7-2/R7-3). `uuid` None = brand new.
///
/// `adopt` marks the one path that takes over a transcript the app never drove
/// (the picker's external-session section). Only that path re-checks liveness
/// here; see [`recheck_adoptable`].
///
/// `model` is passed straight through to the spawn (`--model`), and is therefore
/// meaningful **only on the driver path**: attaching to an already-running PTY
/// cannot change the model it was started with, so the mirror branch above
/// ignores it. The one caller that sets it (prompt refine) always opens a brand
/// new uuid, which never takes the mirror branch.
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
    adopt: Option<bool>,
    model: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<ClaudeOpened, AppError> {
    let label = window.label().to_string();
    let cwd = cwd.ok_or_else(|| AppError::new("Claude requires an active project"))?;
    let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;

    // Mirror: attach to the running PTY if this uuid is live (T1/T2 — 전이는
    // ClaudeRuntime 순수 메서드, 승격 emit은 락 해제 후. P6-impl #1/#3/#5).
    match rt.attach_live(&project, uuid.as_deref(), &label, |id| mgr.exists(id)) {
        AttachLive::Attached { id, driver, rev, handoff } => {
            let role = if driver == label { "driver" } else { "mirror" };
            let opened = ClaudeOpened {
                id,
                session_uuid: uuid.clone().unwrap_or_default(),
                role: role.into(),
                driver,
                rev,
            };
            drop(rt);
            if let Some((driver, rev)) = handoff {
                let _ = app.emit("claude-driver-changed", ClaudeDriver { id, driver, rev });
            }
            return Ok(opened);
        }
        AttachLive::NotLive | AttachLive::Cleaned => {}
    }

    // 이 프로젝트에 아카이브 지식이 있으면 .mcp.json 등록을 보장 — 새로 뜨는
    // claude가 지식 서버(search_knowledge)를 바로 쓸 수 있게 (best-effort).
    //
    // /tmp 스크래치 cwd(프롬프트 정리 세션)는 제외한다: 그 디렉토리는 프로젝트가
    // 아니라 격리용 빈 폴더이고, 등록이 성사되면 거기에 `.mcp.json`이 남는다
    // (spec ②·survey R2-3). 지식 디렉토리가 없어 실제로도 조기 반환하겠지만,
    // "정리 세션은 어떤 프로젝트 파일도 건드리지 않는다"는 불변식은 우연이 아니라
    // 명시적 조건이어야 한다.
    if !core_lib::claude_cli::is_scratch_dir(std::path::Path::new(&cwd)) {
        crate::commands::archive::ensure_mcp_registration(&app, &cwd);
    }

    // Adopt only: the liveness verdict the picker showed was computed when the
    // picker opened, and the user may have sat on it for minutes — long enough to
    // go start that very session in a terminal. Re-establish it here, *after* the
    // side work above and immediately before the spawn, so nothing runs between
    // the check and the PTY (review #1, audit B2). The runtime lock is held
    // throughout. One /proc pass, measured at ~0.12 s.
    if adopt.unwrap_or(false) {
        if let Some(uuid) = uuid.as_deref() {
            recheck_adoptable(uuid, &cwd)?;
        }
    }

    // Driver: start a fresh PTY (lock held so a concurrent open can't double-start).
    let (id, session_uuid, stop) = super::spawn::spawn_claude(
        &app,
        &mgr,
        project.clone(),
        cwd,
        uuid,
        name.unwrap_or_else(|| "Claude".to_string()),
        model,
        cols,
        rows,
    )?;
    rt.register(id, project, session_uuid.clone(), label.clone(), stop); // T3
    Ok(ClaudeOpened { id, session_uuid, role: "driver".into(), driver: label, rev: 0 })
}

/// Driver-only input: write to the PTY only if `window` is the session's current
/// driver (single-writer — a mirror's stray input is a silent no-op, review
/// R7-1). Claude panels call this instead of `terminal_write`.
///
/// **Returns whether the bytes were actually written.** A mirror's write is
/// ignored, and that used to be reported as plain `Ok(())` — indistinguishable
/// from a real write. Keystrokes don't care, but the prompt-refine [적용] path
/// ends a session on the strength of the acknowledgement, so it needs the truth:
/// the frontend checks its own driver flag before calling, but that flag can be
/// one handover behind, and "the caller believed it was the driver" is not
/// evidence that anything landed (audit G1). Callers that don't care simply
/// ignore the value.
#[tauri::command]
pub fn claude_write(
    window: Window,
    mgr: State<'_, SessionManager>,
    claude: State<'_, ClaudeState>,
    id: u64,
    data: Vec<u8>,
    request_id: Option<String>,
) -> Result<bool, AppError> {
    let claim = {
        let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        rt.claim_write(id, window.label(), request_id.as_deref())
    };
    match claim {
        WriteClaim::NotDriver => Ok(false), // ignored, and the caller is told so
        // 같은 request_id로 이미 들어간 바이트 — 아무것도 쓰지 않고 성공을 알린다.
        WriteClaim::AlreadyDelivered => Ok(true),
        WriteClaim::Fresh => match mgr.write(id, &data) {
            Ok(()) => Ok(true),
            Err(e) => {
                // 실패한 쓰기는 배달이 아니다 — 원장에서 빼 재시도 가능하게 되돌린다.
                if let Some(rid) = request_id.as_deref() {
                    if let Ok(mut rt) = claude.rt.lock() {
                        rt.release_write(id, rid);
                    }
                }
                Err(AppError::new(e))
            }
        },
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
        rt.set_driver(id, &label) // T4 (전이표 순수 메서드)
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
    let outcome = {
        let mut rt = claude.rt.lock().map_err(|_| AppError::new("Claude state unavailable"))?;
        rt.detach(id, &label, close_if_last) // T5 (전이표 순수 메서드)
    };
    let Some((act, driver, rev)) = outcome else {
        return Ok(ClaudeDetached { closed: false, driver: String::new(), rev: 0 });
    };
    match act {
        DetachAct::Close(stop) => {
            stop.store(true, Ordering::Relaxed);
            mgr.remove(id).map_err(AppError::new)?;
            Ok(ClaudeDetached { closed: true, driver, rev })
        }
        DetachAct::Handoff(d, r) => {
            let _ = app.emit("claude-driver-changed", ClaudeDriver { id, driver: d, rev: r });
            Ok(ClaudeDetached { closed: false, driver, rev })
        }
        DetachAct::None => Ok(ClaudeDetached { closed: false, driver, rev }),
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
        rt.remove_session(id) // T6 (전이표 순수 메서드)
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
mod transition_tests {
    use super::*;
    // ---- P5 B-b: 드라이버 전이표 특성테스트 (T1~T7 / I1~I7 — 조사 §2-3.
    // 이전 커버리지 0이던 전이를 순수 메서드로 고정) ----

    fn rt_with(id: u64, project: &str, uuid: &str, label: &str) -> (ClaudeRuntime, Arc<AtomicBool>) {
        let mut rt = ClaudeRuntime::default();
        let stop = Arc::new(AtomicBool::new(false));
        rt.register(id, project.into(), uuid.into(), label.into(), stop.clone());
        (rt, stop)
    }

    // ---- H1: request_id 배달 원장 (같은 id는 정확히 한 번만 실린다) ----

    #[test]
    fn same_request_id_delivers_once() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
        // 늦은 실쓰기 뒤의 재시도 — 두 번째는 쓰지 않고 성공으로 보고된다.
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::AlreadyDelivered);
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::AlreadyDelivered);
    }

    #[test]
    fn different_request_ids_each_deliver() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
        assert_eq!(rt.claim_write(1, "main", Some("r2")), WriteClaim::Fresh);
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::AlreadyDelivered);
        assert_eq!(rt.claim_write(1, "main", Some("r2")), WriteClaim::AlreadyDelivered);
    }

    #[test]
    fn writes_without_request_id_are_never_deduped() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        // 키 입력·시드 — 원장을 타지 않으므로 몇 번이든 그대로 쓰인다(기존 동작).
        for _ in 0..3 {
            assert_eq!(rt.claim_write(1, "main", None), WriteClaim::Fresh);
        }
        // 원장이 오염되지 않아 식별된 쓰기도 정상.
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
    }

    #[test]
    fn failed_write_can_be_retried_with_the_same_id() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
        rt.release_write(1, "r1"); // 쓰기 실패 — 배달이 아니다
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
    }

    #[test]
    fn mirror_and_unknown_session_never_claim() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        assert_eq!(rt.claim_write(1, "other-window", Some("r1")), WriteClaim::NotDriver);
        assert_eq!(rt.claim_write(99, "main", Some("r1")), WriteClaim::NotDriver);
        // 미러의 시도는 원장을 건드리지 않는다 — driver가 같은 id로 쓸 수 있어야 한다.
        assert_eq!(rt.claim_write(1, "main", Some("r1")), WriteClaim::Fresh);
    }

    #[test]
    fn delivered_memory_is_bounded_and_keeps_the_newest() {
        let (mut rt, _) = rt_with(1, "/p", "u", "main");
        for i in 0..(DELIVERED_MEMORY + 4) {
            assert_eq!(rt.claim_write(1, "main", Some(&format!("r{i}"))), WriteClaim::Fresh);
        }
        assert_eq!(rt.by_id[&1].delivered.len(), DELIVERED_MEMORY);
        // 가장 오래된 것은 잊혀도(재시도는 초 단위라 도달 불가) 최신은 남는다.
        let newest = format!("r{}", DELIVERED_MEMORY + 3);
        assert_eq!(rt.claim_write(1, "main", Some(&newest)), WriteClaim::AlreadyDelivered);
        assert_eq!(rt.claim_write(1, "main", Some("r0")), WriteClaim::Fresh);
    }

    fn maps_consistent(rt: &ClaudeRuntime) -> bool {
        // I1: live의 모든 id가 by_id에 있고, by_id의 (project,uuid)가 live와 일치.
        rt.live.iter().all(|(k, id)| {
            rt.by_id.get(id).map(|s| (&s.project, &s.uuid) == (&k.0, &k.1)).unwrap_or(false)
        }) && rt.by_id.iter().all(|(id, s)| {
            rt.live.get(&(s.project.clone(), s.uuid.clone())) == Some(id)
        })
    }

    /// T3 + T1(미러 attach): 두 번째 창은 미러, 승격 없음, rev 불변.
    #[test]
    fn attach_live_second_window_is_mirror() {
        let (mut rt, _stop) = rt_with(1, "/p", "u1", "main");
        match rt.attach_live("/p", Some("u1"), "popout", |_| true) {
            AttachLive::Attached { id, driver, rev, handoff } => {
                assert_eq!((id, driver.as_str(), rev), (1, "main", 0));
                assert!(handoff.is_none());
            }
            _ => panic!("live 세션에 attach여야 한다"),
        }
        assert!(maps_consistent(&rt));
        assert_eq!(rt.by_id[&1].attached, vec!["main", "popout"]);
    }

    /// T1 고아 승격(I3 복구): driver가 attached에 없으면 새 뷰어가 승격 + rev+1
    /// + handoff(락 해제 후 emit 계약 — I4는 반환값으로 표현된다).
    #[test]
    fn attach_live_promotes_orphaned_driver() {
        let (mut rt, _stop) = rt_with(1, "/p", "u1", "main");
        // 전송 창: 드라이버가 detach(close_if_last=false)로 빠져 attached 비움(I6).
        let out = rt.detach(1, "main", false).unwrap();
        assert!(matches!(out.0, DetachAct::None));
        assert!(rt.by_id[&1].attached.is_empty());
        assert_eq!(rt.by_id[&1].driver, "main"); // driver 유지(전송 계약)
        match rt.attach_live("/p", Some("u1"), "popout", |_| true) {
            AttachLive::Attached { driver, rev, handoff, .. } => {
                assert_eq!(driver, "popout");
                assert_eq!(rev, 1); // I2 단조
                assert_eq!(handoff, Some(("popout".into(), 1)));
            }
            _ => panic!(),
        }
        assert!(maps_consistent(&rt));
    }

    /// T2: PTY 소멸 시 양 맵 동시 정리 + stop set → Cleaned(신규 스폰 낙하).
    #[test]
    fn attach_live_cleans_stale_entry() {
        let (mut rt, stop) = rt_with(1, "/p", "u1", "main");
        match rt.attach_live("/p", Some("u1"), "w2", |_| false) {
            AttachLive::Cleaned => {}
            _ => panic!("죽은 PTY는 Cleaned여야 한다"),
        }
        assert!(rt.live.is_empty() && rt.by_id.is_empty());
        assert!(stop.load(Ordering::Relaxed));
    }

    /// T1 uuid 미지정/미라이브 → NotLive(스폰 경로).
    #[test]
    fn attach_live_not_live_paths() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        assert!(matches!(rt.attach_live("/p", None, "w", |_| true), AttachLive::NotLive));
        assert!(matches!(rt.attach_live("/p", Some("u2"), "w", |_| true), AttachLive::NotLive));
        assert!(matches!(rt.attach_live("/q", Some("u1"), "w", |_| true), AttachLive::NotLive));
    }

    /// T4: attach된 미러만 실전이(rev+1); 이미 드라이버/미attach는 현재값,
    /// 미존재는 None. (emit은 driver==label일 때만 — I7은 호출부 계약.)
    #[test]
    fn set_driver_transitions() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        rt.attach_live("/p", Some("u1"), "popout", |_| true);
        assert_eq!(rt.set_driver(1, "popout"), Some(("popout".into(), 1)));
        assert_eq!(rt.set_driver(1, "popout"), Some(("popout".into(), 1))); // 재호출 무전이
        assert_eq!(rt.set_driver(1, "ghost"), Some(("popout".into(), 1))); // 미attach 무전이
        assert_eq!(rt.set_driver(9, "main"), None);
        assert!(maps_consistent(&rt));
    }

    /// T5(a): 마지막 뷰어 + close_if_last → Close(양 맵 제거).
    #[test]
    fn detach_last_viewer_closes() {
        let (mut rt, stop) = rt_with(1, "/p", "u1", "main");
        let (act, driver, rev) = rt.detach(1, "main", true).unwrap();
        assert!(matches!(act, DetachAct::Close(_)));
        assert_eq!((driver.as_str(), rev), ("", 0));
        assert!(rt.live.is_empty() && rt.by_id.is_empty());
        // stop은 호출부가 store(I4 — 계산과 부수효과 분리): 여기선 아직 false.
        assert!(!stop.load(Ordering::Relaxed));
    }

    /// T5(c): 드라이버 이탈 + 잔여 → attached[0] 승계 + rev+1 + Handoff.
    #[test]
    fn detach_driver_hands_off_in_attach_order() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        rt.attach_live("/p", Some("u1"), "w2", |_| true);
        rt.attach_live("/p", Some("u1"), "w3", |_| true);
        let (act, driver, rev) = rt.detach(1, "main", true).unwrap();
        assert!(matches!(act, DetachAct::Handoff(ref d, 1) if d == "w2"));
        assert_eq!((driver.as_str(), rev), ("w2", 1));
        assert_eq!(rt.by_id[&1].attached, vec!["w2", "w3"]);
        assert!(maps_consistent(&rt));
    }

    /// T5(d): 비드라이버 이탈 → 무전이(None), rev 불변.
    #[test]
    fn detach_mirror_is_no_transition() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        rt.attach_live("/p", Some("u1"), "w2", |_| true);
        let (act, driver, rev) = rt.detach(1, "w2", true).unwrap();
        assert!(matches!(act, DetachAct::None));
        assert_eq!((driver.as_str(), rev), ("main", 0));
        assert!(maps_consistent(&rt));
    }

    /// T6/T7: 강제 제거 — 양 맵 동시, stop 반환(저장은 호출부), 미존재 None.
    #[test]
    fn remove_session_clears_both_maps() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        assert!(rt.remove_session(1).is_some());
        assert!(rt.live.is_empty() && rt.by_id.is_empty());
        assert!(rt.remove_session(1).is_none());
    }

    /// I2 종합: 전이 시퀀스에서 rev가 단조 증가한다.
    #[test]
    fn rev_is_monotonic_across_transitions() {
        let (mut rt, _s) = rt_with(1, "/p", "u1", "main");
        rt.attach_live("/p", Some("u1"), "w2", |_| true);
        // 값 단언(리뷰 P3-9: >=만 보면 rev가 영원히 0이어도 통과한다).
        assert_eq!(rt.set_driver(1, "w2").unwrap().1, 1);
        assert_eq!(rt.set_driver(1, "main").unwrap().1, 2);
        let (_, _, rev) = rt.detach(1, "main", true).unwrap(); // handoff
        assert_eq!(rev, 3);
    }
}
