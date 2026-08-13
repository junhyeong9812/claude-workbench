//! R2a — attaching a remote host and bridging its events onto the workbench's
//! existing ones.
//!
//! Everything of substance is in `core_lib::remote`; this file is the two
//! things that cannot live there. One is the Tauri command surface (attach,
//! detach, poll, and two read-only calls). The other is the sink: three
//! `app.emit` lines that put a remote host's frames onto the **same** events a
//! local session has always produced.
//!
//! ## Why polling for the host list, and events for the timeline
//!
//! The timeline streams, because it is a stream and because `claude-timeline`
//! already exists to carry one. A connection's own state — attached, retrying,
//! which sessions exist, what the daemon said — has no existing event, and
//! inventing one would be a new frontend contract for a panel that is polled
//! only while it is open. So it is a snapshot ([`remote_hosts`]) instead: no
//! new event kind, and nothing to keep in sync.
//!
//! ## Read-only, and narrowly so
//!
//! The daemon's socket also carries `spawn` and `kill`. Nothing here can reach
//! them: the two calls exposed are `list` and `timeline`, spelled out as
//! separate commands rather than as a pass-through argv. R2b owns the write
//! surface, and giving the frontend a general "run this on the remote host"
//! command now would build it by accident.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use core_lib::remote::host::Emit;
use core_lib::remote::proto::{
    decode_response, DirReply, GitLogReply, GitRootsReply, GitStatusReply, KilledReply,
    ProjectsReply, ResizedReply, SessionsReply, SpawnedReply, TimelineSliceReply, WorktreesReply,
};
use core_lib::remote::{
    HostConfig, HostSnapshot, RemoteAuth, RemoteTimelinePayload, Registry, Sink,
};

use super::AppError;

/// Managed state: every attached host.
#[derive(Default)]
pub struct RemoteState {
    registry: Registry,
}

/// Teach the registry how to end a terminal — the one piece of the R15 contract
/// that cannot live in `core`.
///
/// `core::remote::Registry` knows *which* terminals belong to a host, and closes
/// them on detach, re-attach and shutdown. What it cannot do is the closing: the
/// session manager lives in Tauri's state map, and handing `core` a path to it
/// would invert the dependency. So the closure is installed here, once, at app
/// start — **and without it nothing is closed at all**, which is the state this
/// shipped in: "떼기" removed the card while the terminal kept carrying
/// keystrokes to the remote agent.
///
/// The order inside is deliberate. The reason is emitted **before** the session
/// is removed, because removing it tears down the SSH channel and the status
/// relay in [`remote_attach`] then reports the vaguer "연결이 끊어졌습니다".
/// Both reach the panel; the first one is the true one, and the panel keeps the
/// first (the same rule the `said` flag applies inside one attach).
pub fn install_terminal_closer(app: &AppHandle) {
    let handle = app.clone();
    app.state::<RemoteState>()
        .registry
        .on_close_terminal(move |host_id, id| {
            let _ = handle.emit(
                "remote-terminal-ended",
                RemoteTerminalEnded {
                    id,
                    host_id: host_id.to_string(),
                    code: None,
                    signal: None,
                    detail: "이 호스트에서 떼어져 터미널을 닫았습니다 — 원격 세션은 계속 돕니다."
                        .to_string(),
                },
            );
            let _ = handle.state::<core_lib::SessionManager>().remove(id);
        });
}

/// Turns a bridged event into the workbench event it has always been.
struct TauriSink {
    app: AppHandle,
}

impl Sink for TauriSink {
    fn emit(&self, e: Emit) {
        match e {
            Emit::Timeline(payload) => {
                let _ = self.app.emit("claude-timeline", payload);
            }
            Emit::Hook { uuid, event } => {
                let _ = self.app.emit(
                    "claude-hook-status",
                    super::hookserver::HookStatusEvent { uuid, event },
                );
            }
            Emit::Closed { id } => {
                let _ = self.app.emit("claude-session-closed", id);
            }
        }
    }
}

/// App-private known_hosts — the same file the SSH terminal learns keys into,
/// which is what makes "open a terminal to the host once" the way to trust it.
fn known_hosts_path(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("앱 데이터 경로를 찾을 수 없습니다."))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("known_hosts"))
}

/// A directly supplied secret wins; the saved connection's keychain entry is the
/// fallback; **an empty string is not a secret**. Returning `None` rather than
/// `""` is the whole point — see [`remote_connect`].
fn secret(direct: Option<String>, saved: Option<String>) -> Option<String> {
    direct
        .or(saved)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_string())
        .filter(|s| !s.is_empty())
}

/// Attach a remote host: subscribe to its daemon's event stream over SSH.
///
/// Returns the id it was filed under (the caller's `host_id`). Attaching an id
/// that is already attached replaces it, so a reconnect button cannot leave two
/// observation windows doubling every event.
///
/// Credentials follow `ssh_create`'s rule exactly: a directly supplied secret
/// wins, and only in its absence is the saved connection's keychain entry read
/// — so a fresh connection or agent auth never triggers a keychain unlock.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn remote_connect(
    app: AppHandle,
    remote: State<'_, RemoteState>,
    host_id: String,
    label: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    connection_id: Option<String>,
    cwcd: Option<String>,
    socket: Option<String>,
) -> Result<String, AppError> {
    let saved = || connection_id.as_deref().and_then(super::ssh::ssh_get_secret);
    let auth = match auth_kind.as_str() {
        "password" => RemoteAuth::Password(
            // **Never an empty default.** A remote host reconnects on its own
            // every ≤15s, so a missing secret quietly became an empty password
            // offered to the remote `sshd` at that rate forever — until
            // `MaxAuthTries`/fail2ban blocked the user's address. A secret that
            // is not there is an error the user can act on, at the one moment
            // they are looking at the panel.
            secret(password, saved()).ok_or_else(|| {
                AppError::new(
                    "이 연결의 비밀번호를 찾을 수 없습니다 — 터미널에서 이 SSH 연결로 한 번 접속해 비밀번호를 저장한 뒤 다시 연결하세요.",
                )
            })?,
        ),
        "publickey" => RemoteAuth::PublicKey {
            path: key_path.ok_or_else(|| AppError::new("키 파일 경로가 필요합니다."))?,
            // A passphrase, unlike a password, is legitimately absent (an
            // unencrypted key), so `None` is a real answer here.
            passphrase: secret(passphrase, saved()),
        },
        "agent" => RemoteAuth::Agent,
        _ => return Err(AppError::new("알 수 없는 인증 방식입니다.")),
    };
    let cwcd = cwcd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "cwcd".to_string());
    let socket = socket.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let cfg = HostConfig {
        host_id,
        label,
        host,
        port,
        username,
        auth,
        cwcd,
        socket,
        known_hosts: known_hosts_path(&app)?,
        timeouts: core_lib::remote::LinkTimeouts::default(),
    };
    let sink = Arc::new(TauriSink { app: app.clone() });
    Ok(remote.registry.attach(cfg, sink))
}

/// Stop observing a host. The remote daemon and every agent it owns keep
/// running — that is the whole point of the daemon owning them.
#[tauri::command]
pub fn remote_disconnect(remote: State<'_, RemoteState>, host_id: String) -> bool {
    remote.registry.detach(&host_id)
}

/// Every attached host: connection state, what the daemon said, its sessions,
/// and the notices the user must see.
#[tauri::command]
pub fn remote_hosts(remote: State<'_, RemoteState>) -> Vec<HostSnapshot> {
    remote.registry.snapshots()
}

/// Every attached host's timelines **as they stand now**.
///
/// The timeline arrives as events, and events only reach a listener that was
/// already there. A panel that is closed and reopened — a sidebar tab switched
/// away from and back — has missed all of them, and a session that has stopped
/// producing events (a finished one, most of all) would then show a permanently
/// blank screen. This is the seed for that case: the same payloads the events
/// carry, read out of the bridge's own state.
#[tauri::command]
pub fn remote_timelines(remote: State<'_, RemoteState>) -> Vec<RemoteTimelinePayload> {
    remote.registry.live_payloads()
}

/// One remote session's timeline, fetched on demand.
///
/// This is the address a finished session's `body_omitted` points at: the
/// daemon leaves a finished session's items out of every snapshot, and this is
/// how they come back. The `"<epoch>:k<n>"` address is composed here from the
/// stream's own epoch — a bare key would be refused, and worse, a bare key
/// after a daemon restart would name somebody else's session.
#[derive(Serialize)]
pub struct RemoteTimeline {
    pub session_id: String,
    pub total: usize,
    pub items: Vec<core_lib::TimelineItem>,
    pub turns: Vec<(u64, String)>,
    /// The same three the stream now carries (R2b ⓓ) — a body fetched for a
    /// finished session must not be poorer than the one that streamed.
    pub answers: Vec<(u64, String)>,
    pub dates: Vec<(u64, String)>,
    pub tokens: Vec<(u64, core_lib::TokenUsage)>,
    pub model: Option<String>,
    pub last_usage: Option<core_lib::TokenUsage>,
    /// Whose body this is — `None` = the session's own, `Some(id)` = that
    /// subagent's. Echoed from the daemon so a late reply cannot be filed
    /// against the session when both travel on this one command.
    pub subagent: Option<String>,
    /// The session's agents, meta only (the payload's own frames say the same;
    /// this is here so one fetch answers both questions for a finished session).
    pub subagents: Vec<core_lib::remote::RemoteSubagentFrame>,
}

/// One remote timeline, fetched on demand.
///
/// `subagent` is the **fetch half of deferred hydration**: the stream carries an
/// agent's counters and never its transcript (see `RemoteSubagentFrame`), and
/// this is the address that body has. Additive on the daemon's side too — the
/// same `timeline` command with one more flag, not a new one.
#[tauri::command]
pub fn remote_timeline(
    remote: State<'_, RemoteState>,
    host_id: String,
    id: u64,
    subagent: Option<String>,
) -> Result<RemoteTimeline, AppError> {
    let addr = remote.registry.addr_of(&host_id, id).ok_or_else(|| {
        AppError::new("이 세션의 원격 주소를 알 수 없습니다 — 연결이 끊겼거나 데몬이 다시 시작되었습니다.")
    })?;
    let mut argv: Vec<&str> = vec!["timeline", &addr];
    if let Some(agent) = subagent.as_deref() {
        argv.push("--subagent");
        argv.push(agent);
    }
    let out = remote.registry.call(&host_id, &argv).map_err(AppError::new)?;
    let slice: TimelineSliceReply = decode_response(&out).map_err(AppError::new)?;
    Ok(RemoteTimeline {
        session_id: slice.session_id,
        total: slice.total,
        items: slice.items,
        turns: slice.turns.into_iter().collect(),
        answers: slice.answers.into_iter().collect(),
        dates: slice.dates.into_iter().collect(),
        tokens: slice.tokens.into_iter().collect(),
        model: slice.model,
        last_usage: slice.last_usage,
        subagent: slice.subagent,
        subagents: slice.subagents.iter().map(Into::into).collect(),
    })
}


/// The address of a remote session, or the reason there is not one.
fn addr_of(remote: &State<'_, RemoteState>, host_id: &str, id: u64) -> Result<String, AppError> {
    remote.registry.addr_of(host_id, id).ok_or_else(|| {
        AppError::new(
            "이 세션의 원격 주소를 알 수 없습니다 — 연결이 끊겼거나 데몬이 다시 시작되었습니다.",
        )
    })
}

/// Start an agent **on the remote host**.
///
/// The identity is chosen by [`account`] — an id from `cwcd accounts`, never a
/// path. That is the daemon's rule, not this layer's convenience: the only way
/// to name an agent home used to be a path field, which made the account list
/// decoration, and it was removed from the wire for exactly that reason (R1b).
/// Passing a path here would have to invent it back.
#[tauri::command]
pub fn remote_spawn(
    remote: State<'_, RemoteState>,
    host_id: String,
    agent: String,
    cwd: String,
    account: Option<String>,
    model: Option<String>,
    prompt: Option<String>,
    label: Option<String>,
) -> Result<String, AppError> {
    let mut args: Vec<&str> = vec!["spawn", "--agent", &agent, "--cwd", &cwd];
    for (flag, value) in [
        ("--account", &account),
        ("--model", &model),
        ("--prompt", &prompt),
        ("--label", &label),
    ] {
        if let Some(v) = value.as_deref() {
            if !v.is_empty() {
                args.push(flag);
                args.push(v);
            }
        }
    }
    let out = remote
        .registry
        .call(&host_id, &args)
        .map_err(AppError::new)?;
    let spawned: SpawnedReply = decode_response(&out).map_err(AppError::new)?;
    Ok(spawned.session.key.to_string())
}

/// End a remote session. The reply reports the signal **actually delivered**,
/// which is not always the one asked for (the daemon falls back to `SIGHUP`
/// when the process group has already gone), so it is handed back rather than
/// echoed.
#[tauri::command]
pub fn remote_kill(
    remote: State<'_, RemoteState>,
    host_id: String,
    id: u64,
    signal: Option<i32>,
) -> Result<i32, AppError> {
    let addr = addr_of(&remote, &host_id, id)?;
    let signal = signal.map(|s| s.to_string());
    let mut args: Vec<&str> = vec!["kill", &addr];
    if let Some(s) = signal.as_deref() {
        args.push("--signal");
        args.push(s);
    }
    let out = remote
        .registry
        .call(&host_id, &args)
        .map_err(AppError::new)?;
    let killed: KilledReply = decode_response(&out).map_err(AppError::new)?;
    Ok(killed.signal)
}

/// Resize a remote session's pty.
///
/// A command of its own rather than something smuggled through the attach
/// stream: that stream is the agent's own bytes, and this one *answers*, so a
/// resize that did not happen is visible instead of assumed. It costs one SSH
/// round trip, so the caller should send settled sizes, not every frame of a
/// drag.
///
/// The answer is **read**, and handed back as the size the pty now has. It was
/// thrown away, which made the "answers" in the paragraph above untrue: the
/// underlying `exec_capture` only fails on empty stdout, so a daemon that
/// refused the resize — a finished session, an adopted one with no terminal —
/// replied `{"response":"error",…}` and this returned `Ok(())`. Returning the
/// size also gives the caller something to correct itself against, which a
/// caller tracking "the last size I sent" cannot do.
#[tauri::command]
pub fn remote_resize(
    remote: State<'_, RemoteState>,
    host_id: String,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<RemoteSize, AppError> {
    let addr = addr_of(&remote, &host_id, id)?;
    let (cols, rows) = (cols.max(1).to_string(), rows.max(1).to_string());
    let out = remote
        .registry
        .call(&host_id, &["resize", &addr, "--cols", &cols, "--rows", &rows])
        .map_err(AppError::new)?;
    let size: ResizedReply = decode_response(&out).map_err(AppError::new)?;
    Ok(RemoteSize {
        cols: size.cols,
        rows: size.rows,
    })
}

/// The size a remote pty has after [`remote_resize`] — the daemon's answer, not
/// the request.
#[derive(Clone, Copy, Serialize)]
pub struct RemoteSize {
    pub cols: u16,
    pub rows: u16,
}

/// Open a **terminal** onto a remote session, and file it in the app's own
/// session manager.
///
/// The returned id is an ordinary local session id: `terminal_write`,
/// `terminal_resize`, `terminal_snapshot` and `terminal-output-{id}` all address
/// it unchanged, because the transport underneath is the same byte relay every
/// other session uses. That is the whole reason this is one SSH exec running
/// `cwcd attach` rather than a new event kind — a remote terminal is the same
/// object as a local one, not a parallel one.
///
/// Its **pty** size still belongs to the daemon, so a later resize goes through
/// [`remote_resize`]; the SSH channel here is non-TTY and has no window of its
/// own to change.
#[tauri::command]
pub fn remote_attach(
    app: AppHandle,
    // The **same** type `lib.rs` manages, which is the whole requirement:
    // Tauri's state map is keyed by `TypeId`, so `State<Arc<SessionManager>>`
    // against a managed bare `SessionManager` is a different key and every call
    // fails at runtime with "state not managed" — while compiling cleanly,
    // because `State<T>` is generic. `tests/state_registration.rs` now compares
    // the two lists that have to agree, so the next one of these is a red test
    // rather than a discovery made in the running app.
    mgr: State<'_, core_lib::SessionManager>,
    remote: State<'_, RemoteState>,
    host_id: String,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<u64, AppError> {
    let (config, known_hosts) = remote
        .registry
        .attach_config(&host_id, id, cols, rows)
        .ok_or_else(|| {
            AppError::new(
                "이 세션의 터미널을 열 수 없습니다 — 연결이 끊겼거나 데몬이 다시 시작되었습니다.",
            )
        })?;
    let (local_id, channels) = mgr.create_ssh(config, known_hosts, cols, rows, None);
    // File it under the host **before** anything can fail: from here on the
    // registry is the only place that knows this terminal belongs to `host_id`,
    // and a detach that does not know cannot close it (R15).
    remote.registry.note_terminal(&host_id, local_id);
    let rx = mgr.subscribe(local_id).map_err(AppError::new)?;
    super::spawn_output_relay(app.clone(), local_id, rx, None);

    // The host key is already trusted (this host has a live link) — and a
    // background attach has no moment to ask, so an unknown key is refused
    // rather than prompted, exactly as the observation window does it.
    {
        let mut prompt_rx = channels.prompt_rx;
        std::thread::spawn(move || {
            while let Some(c) = prompt_rx.blocking_recv() {
                let _ = c.reply.send(core_lib::ssh::HostKeyDecision::Reject);
            }
        });
    }
    // Whichever of the two relays below gets to the end first is the one that
    // speaks, and the other stays quiet: a terminal that stopped once must not
    // be reported as having stopped twice, and the *first* reason is the real
    // one (the connection failing is why the exec never ran, not the reverse).
    let said = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // `exec_rx` is bounded and its sender blocks: held-but-undrained, it would
    // stall the read loop and, on a duplex session, the write direction with it.
    // Drained here so the exit is *said* — a terminal that stops because the
    // remote refused the command must not look like a quiet one.
    {
        let app = app.clone();
        let host = host_id.clone();
        let said = Arc::clone(&said);
        let mut exec_rx = channels.exec_rx;
        std::thread::spawn(move || {
            let mut stderr = String::new();
            while let Some(e) = exec_rx.blocking_recv() {
                match e {
                    core_lib::ssh::ExecEvent::Stderr(b) => {
                        if stderr.len() < 4096 {
                            stderr.push_str(&String::from_utf8_lossy(&b));
                        }
                    }
                    core_lib::ssh::ExecEvent::Exit { code, signal } => {
                        emit_terminal_ended(
                            &app,
                            &said,
                            local_id,
                            &host,
                            code,
                            signal,
                            stderr.trim(),
                        );
                    }
                    core_lib::ssh::ExecEvent::Error(msg) => {
                        emit_terminal_ended(&app, &said, local_id, &host, None, None, &msg);
                    }
                }
            }
        });
    }
    // The connection's own lifecycle, which the exec channel cannot report:
    // connect, auth, host-key and channel-open failures all happen *before*
    // there is an exec, and the contract for that case is **zero** `ExecEvent`s.
    // Dropped, as this was, they left the one symptom the whole path exists to
    // avoid — an empty black window that says nothing and never will, until the
    // user types into it and is told the session is dead.
    //
    // `Closed` also lands here (the link went away with no exec verdict). It
    // gets a sentence rather than a bare phase because at this point the panel's
    // only other information is that its terminal went quiet.
    {
        let app = app.clone();
        let host = host_id.clone();
        let said = Arc::clone(&said);
        let mut status_rx = channels.status_rx;
        std::thread::spawn(move || {
            while let Some(s) = status_rx.blocking_recv() {
                let detail = match s {
                    core_lib::ssh::SshStatus::Connecting | core_lib::ssh::SshStatus::Ready => {
                        continue
                    }
                    core_lib::ssh::SshStatus::Failed(reason) => {
                        format!("원격 호스트에 연결하지 못했습니다: {reason}")
                    }
                    core_lib::ssh::SshStatus::Closed => {
                        "원격 호스트와의 연결이 끊어졌습니다.".to_string()
                    }
                };
                emit_terminal_ended(&app, &said, local_id, &host, None, None, &detail);
            }
        });
    }
    Ok(local_id)
}

/// Say once that a remote terminal is over. See the `said` flag in
/// [`remote_attach`]: two relays watch two different ways for it to end, and a
/// panel that is told twice would report the second, vaguer reason.
///
/// This is also where the registry **forgets** the terminal. It has to be: a
/// terminal that ended on its own (the agent exited, `cwcd attach` was refused,
/// the connection dropped, the user pressed 닫기) is still filed under its host,
/// and a later detach would then close whatever id the session manager has since
/// handed out. That is the class R1a shipped — a detach that `SIGKILL`ed an
/// unrelated session — and the only thing standing between it and here is this
/// line.
fn emit_terminal_ended(
    app: &AppHandle,
    said: &Arc<std::sync::atomic::AtomicBool>,
    id: u64,
    host_id: &str,
    code: Option<u32>,
    signal: Option<String>,
    detail: &str,
) {
    // Outside the `said` guard: whichever relay speaks, both know the terminal
    // is over, and forgetting twice is a no-op while forgetting never is not.
    app.state::<RemoteState>().registry.forget_terminal(id);
    if said.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let _ = app.emit(
        "remote-terminal-ended",
        RemoteTerminalEnded {
            id,
            host_id: host_id.to_string(),
            code,
            signal,
            detail: detail.to_string(),
        },
    );
}

/// Why a remote terminal stopped. Its own event kind because there is no other
/// way to tell "the agent exited" from "`cwcd attach` was refused" — both leave
/// the same silent terminal otherwise.
#[derive(Clone, Serialize)]
pub struct RemoteTerminalEnded {
    pub id: u64,
    pub host_id: String,
    pub code: Option<u32>,
    pub signal: Option<String>,
    pub detail: String,
}

/// The accounts (agent homes) a host publishes — the input to [`remote_spawn`].
#[tauri::command]
pub fn remote_accounts(
    remote: State<'_, RemoteState>,
    host_id: String,
) -> Result<serde_json::Value, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["accounts"])
        .map_err(AppError::new)?;
    let v: serde_json::Value = serde_json::from_str(&out)
        .map_err(|e| AppError::new(format!("데몬 응답을 읽지 못했습니다: {e}")))?;
    if v.get("response").and_then(|r| r.as_str()) == Some("error") {
        return Err(AppError::new(
            v.get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("알 수 없는 오류")
                .to_string(),
        ));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// R2 — the host as a **data source**: its projects, trees, git and worktrees
// ---------------------------------------------------------------------------
//
// R2a made a host's *sessions* visible. What makes it a place you can work on
// rather than a list you can watch is everything around them, and the daemon has
// published all of it since R1b. These are the adapters: one command per daemon
// command, each decoding into the typed reply `core::remote::proto` mirrors and
// handing it to the panel unchanged.
//
// Two properties they all share, and neither is decoration:
//
// - **Read only, and narrowly so.** The same rule R2a set: `list`/`timeline`
//   were spelled out as separate commands rather than a pass-through argv, and
//   these are too. Nothing here can reach `spawn` or `kill` by composing a
//   string, because no caller composes one.
// - **A cut always arrives as a cut.** `truncated`, `next_cursor`, `total` and
//   `at_cap` are carried through to the frontend rather than collapsed into a
//   list. The workbench's own `git_roots` is a registered silent truncation —
//   a scan that gives up returns a plain, complete-looking list — and the point
//   of this layer is not to reproduce that over SSH.
//
// What they are **not** is a boundary: the daemon's path containment is a
// guardrail against reading the wrong tree on a socket that also carries
// `spawn`, and R1b settled that it is not a security boundary. Nothing here
// changes that in either direction.

/// The projects this host publishes — the `root` every other call here takes.
///
/// `notes` comes back with them and is the reason this is not just a list: an
/// empty project list is a legitimate answer, an unreadable configuration is
/// not, and without the notes the two are the same screen.
#[tauri::command]
pub fn remote_projects(
    remote: State<'_, RemoteState>,
    host_id: String,
    refresh: Option<bool>,
) -> Result<ProjectsReply, AppError> {
    let mut args: Vec<&str> = vec!["projects"];
    if refresh.unwrap_or(false) {
        args.push("--refresh");
    }
    let out = remote.registry.call(&host_id, &args).map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// One directory of one project, gitignore-aware — a **page** of it.
///
/// `from`/`limit` page a large directory, and the reply says `total` and
/// `truncated` so the caller can say "showing M of N" instead of showing M and
/// calling it the directory.
#[tauri::command]
pub fn remote_tree(
    remote: State<'_, RemoteState>,
    host_id: String,
    root: String,
    path: Option<String>,
    from: Option<usize>,
    limit: Option<usize>,
) -> Result<DirReply, AppError> {
    let from = from.unwrap_or(0).to_string();
    let limit = limit.map(|n| n.to_string());
    let mut args: Vec<&str> = vec!["tree", &root, "--from", &from];
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        args.push("--path");
        args.push(p);
    }
    if let Some(l) = limit.as_deref() {
        args.push("--limit");
        args.push(l);
    }
    let out = remote.registry.call(&host_id, &args).map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// One project's working-tree status. Not paged and not capped — the whole of it.
#[tauri::command]
pub fn remote_git_status(
    remote: State<'_, RemoteState>,
    host_id: String,
    root: String,
) -> Result<GitStatusReply, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["git-status", &root])
        .map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// One page of a project's history.
///
/// The `cursor` is the daemon's own, handed back **verbatim**. It is not a ref
/// and must not be treated as one: continuing by ref means `git log <hash>`,
/// which walks that commit's ancestors, so every branch outside the first page's
/// ancestry disappears after page 1 (the daemon measured 708 commits whole, 297
/// paged). A continuation the daemon refuses is an error the screen shows, not a
/// silently shorter history.
#[tauri::command]
pub fn remote_git_log(
    remote: State<'_, RemoteState>,
    host_id: String,
    root: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<GitLogReply, AppError> {
    let limit = limit.map(|n| n.to_string());
    let mut args: Vec<&str> = vec!["git-log", &root];
    if let Some(l) = limit.as_deref() {
        args.push("--limit");
        args.push(l);
    }
    if let Some(c) = cursor.as_deref().filter(|c| !c.is_empty()) {
        args.push("--cursor");
        args.push(c);
    }
    let out = remote.registry.call(&host_id, &args).map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// `git worktree list` for one project.
#[tauri::command]
pub fn remote_worktrees(
    remote: State<'_, RemoteState>,
    host_id: String,
    root: String,
) -> Result<WorktreesReply, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["worktrees", &root])
        .map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// Every git root at or under one project — the multi-repo case.
///
/// `at_cap` rides along and the panel shows it, because this scan is the one
/// truncation on the whole surface with **no continuation**: the scanner takes
/// no offset, so the way past 200 repositories is a narrower `root`.
#[tauri::command]
pub fn remote_git_roots(
    remote: State<'_, RemoteState>,
    host_id: String,
    root: String,
) -> Result<GitRootsReply, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["git-roots", &root])
        .map_err(AppError::new)?;
    decode_response(&out).map_err(AppError::new)
}

/// The host's own session list, asked directly rather than derived from the
/// stream — the way to tell "the workbench is behind" from "the host is idle".
#[tauri::command]
pub fn remote_sessions(
    remote: State<'_, RemoteState>,
    host_id: String,
) -> Result<usize, AppError> {
    let out = remote
        .registry
        .call(&host_id, &["list"])
        .map_err(AppError::new)?;
    let reply: SessionsReply = decode_response(&out).map_err(AppError::new)?;
    Ok(reply.sessions.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A missing secret must be **nothing**, never an empty string.
    ///
    /// While it defaulted to `""`, a saved connection whose keychain entry was
    /// gone (the panel never sends a password) offered an empty password to the
    /// remote `sshd` on every reconnect — every ≤15s, forever. That is what
    /// `MaxAuthTries` and fail2ban exist to punish, and the address they block
    /// is the user's own.
    #[test]
    fn a_missing_secret_is_none_not_an_empty_password() {
        assert_eq!(secret(None, None), None, "no secret anywhere");
        assert_eq!(secret(Some(String::new()), None), None, "an empty string is not a secret");
        assert_eq!(secret(None, Some(String::new())), None, "…and neither is an empty entry");
        assert_eq!(secret(Some("\r\n".into()), None), None, "nor a keychain entry of newlines");
        // …but whitespace *inside* a secret is part of it, so only the line
        // ending a keychain read can add is stripped.
        assert_eq!(secret(None, Some(" p w ".into())), Some(" p w ".into()));
        // A supplied secret wins over the saved one; the saved one is the
        // fallback (the same rule `ssh_create` follows).
        assert_eq!(secret(Some("typed".into()), Some("saved".into())), Some("typed".into()));
        assert_eq!(secret(None, Some("saved".into())), Some("saved".into()));
        // A trailing newline from the keychain is not part of the secret.
        assert_eq!(secret(None, Some("saved\n".into())), Some("saved".into()));
    }
}
