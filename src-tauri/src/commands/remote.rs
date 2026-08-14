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
//! which sessions exist, what the daemon said, **why a terminal stopped** — has
//! no existing event, and inventing one would be a new frontend contract for a
//! panel that is polled only while it is open. So it is a snapshot
//! ([`remote_hosts`], [`remote_terminal_end`]) instead: no new event kind, and
//! nothing to keep in sync.
//!
//! That last one shipped as an event (`remote-terminal-ended`) and came back:
//! the rule was never lifted, and following it turned out to be the better
//! design anyway. Events have no replay, so a terminal that failed before its
//! listener existed lost its reason forever and the frontend grew a subscribe-
//! before-attach dance to narrow the window. State is readable late — by a panel
//! mounted afterwards, or reopened — so the window closed instead of narrowing.
//! `tests/remote_event_contract.rs` now states the rule that only a comment
//! used to.
//!
//! ## Read-only, and narrowly so
//!
//! The daemon's socket also carries `spawn` and `kill`. Nothing here can reach
//! them: the two calls exposed are `list` and `timeline`, spelled out as
//! separate commands rather than as a pass-through argv. R2b owns the write
//! surface, and giving the frontend a general "run this on the remote host"
//! command now would build it by accident.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

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

/// Managed state: every attached host, and why each remote terminal stopped.
#[derive(Default)]
pub struct RemoteState {
    registry: Registry,
    ended: EndedTerminals,
}

/// How many ended terminals are remembered. One panel opens one terminal at a
/// time, so this is a few dozen sessions of history — kept small on purpose,
/// because a reason nobody has read within that many terminals is a reason
/// nobody is going to read.
const ENDED_CAP: usize = 32;

/// Why remote terminals stopped, oldest first.
///
/// This is the R2a answer to "state with no event of its own": a snapshot the
/// panel asks for, not a kind of event invented for it. It buys more than
/// obedience to that rule. A Tauri event has no replay, so a terminal that died
/// before its listener existed — a refused `cwcd attach`, a host that rejected
/// the key — said its one sentence into an empty room and the screen kept a
/// silent black box. Recorded state is readable *late*: by a panel mounted
/// afterwards, by a panel that was closed and reopened, by the second look of a
/// user who dismissed the first.
///
/// ## Nothing leaves this store in silence
///
/// A plain FIFO at the cap dropped whichever reason was oldest, read or not.
/// The panel that owns a terminal polls until it gets an answer, so a reason
/// evicted before its owner asked left that poll returning `None` forever: the
/// terminal is over, the screen says nothing, and the question never stops being
/// asked. Two rules close it — a reason somebody has already read is evicted
/// **first** (it has done its job), and one that has to go unread leaves a
/// marker behind so the answer becomes "it was dropped" instead of "still
/// running". Both lists are bounded; the marker is an id and a host name.
#[derive(Default)]
pub struct EndedTerminals(Mutex<Ended>);

#[derive(Default)]
struct Ended {
    /// Oldest first.
    reasons: VecDeque<Recorded>,
    /// `(id, host)` of every reason dropped before anyone read it.
    lost: VecDeque<(u64, String)>,
}

struct Recorded {
    e: RemoteTerminalEnded,
    /// Whether [`EndedTerminals::get`] has handed this out. The panel asks once
    /// and keeps what it got, so a reason that has been read is the right thing
    /// to drop when room is needed.
    read: bool,
}

impl Ended {
    /// Make room for one more, preferring a reason that has already been read.
    /// When every one of them is unread, the oldest still goes — but its id is
    /// remembered, because a poll that gets `None` reads as "still running".
    fn evict_one(&mut self) {
        let victim = self.reasons.iter().position(|r| r.read).unwrap_or(0);
        let Some(gone) = self.reasons.remove(victim) else {
            return;
        };
        if gone.read {
            return;
        }
        self.lost.push_back((gone.e.id, gone.e.host_id));
        while self.lost.len() > ENDED_CAP {
            self.lost.pop_front();
        }
    }
}

impl EndedTerminals {
    /// **The first reason is the true one.**
    ///
    /// A terminal can be told about twice: detaching the host closes it ("이
    /// 호스트에서 떼어져…"), and closing it drops the SSH channel, which the
    /// status relay then reports as the vaguer "연결이 끊어졌습니다". The
    /// second one is a consequence of the first, so a store that overwrote
    /// would leave the screen explaining the effect and not the cause. Two
    /// relays inside one attach race the same way — this one rule covers both,
    /// where there used to be an `AtomicBool` for the attach and a "keep the
    /// first" rule in the frontend for the rest.
    fn record(&self, e: RemoteTerminalEnded) {
        let mut q = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if q.reasons.iter().any(|prev| prev.e.id == e.id) {
            return;
        }
        q.reasons.push_back(Recorded { e, read: false });
        while q.reasons.len() > ENDED_CAP {
            q.evict_one();
        }
    }

    /// A local session id that has just been handed to a **new** terminal.
    ///
    /// Ids come from a counter in the session manager and are reused, so the
    /// reason filed under one is only this terminal's while this terminal is the
    /// one holding it. Without this line the store answered a live terminal's
    /// poll with the previous terminal's last words — and then, by the "first
    /// one wins" rule above, refused to record the reason that was actually
    /// this terminal's, forever. That is the R1a class: a stale id acted on as
    /// though it were the current one.
    ///
    /// Called by [`remote_attach`] the moment it has the id, which is before
    /// either relay of that attach exists and therefore before anything can race
    /// it.
    fn opened(&self, id: u64) {
        let mut q = self.0.lock().unwrap_or_else(|p| p.into_inner());
        q.reasons.retain(|r| r.e.id != id);
        // The marker goes with it: "this id's reason was dropped" is a statement
        // about the terminal that has just been replaced, not about this one.
        q.lost.retain(|(lost, _)| *lost != id);
    }

    /// Why one terminal stopped, or `None` while it is still running.
    ///
    /// Reading marks the reason as delivered, which is what lets the cap fall on
    /// reasons that have been seen before it falls on ones that have not. A
    /// reason that *was* dropped unread answers with the fact rather than with
    /// `None`, because `None` means "still running" to the caller and would
    /// leave it polling a terminal that ended long ago.
    fn get(&self, id: u64) -> Option<RemoteTerminalEnded> {
        let mut q = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(r) = q.reasons.iter_mut().find(|r| r.e.id == id) {
            r.read = true;
            return Some(r.e.clone());
        }
        let host = q
            .lost
            .iter()
            .find(|(lost, _)| *lost == id)
            .map(|(_, host)| host.clone())?;
        Some(RemoteTerminalEnded {
            id,
            host_id: host,
            code: None,
            signal: None,
            detail: format!(
                "이 터미널이 왜 멈췄는지는 더 이상 알 수 없습니다 — 그 뒤로 원격 터미널이 \
                 너무 많이(보관 한도 {ENDED_CAP}개) 끝나면서 사유가 밀려났습니다."
            ),
        })
    }
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
/// The order inside is deliberate. The reason is recorded **before** the session
/// is removed, because removing it tears down the SSH channel and the status
/// relay in [`remote_attach`] then reports the vaguer "연결이 끊어졌습니다".
/// Both are offered; [`EndedTerminals::record`] keeps the first, which is the
/// true one.
pub fn install_terminal_closer(app: &AppHandle) {
    let handle = app.clone();
    app.state::<RemoteState>()
        .registry
        .on_close_terminal(move |host_id, id| {
            handle.state::<RemoteState>().ended.record(RemoteTerminalEnded {
                id,
                host_id: host_id.to_string(),
                code: None,
                signal: None,
                detail: "이 호스트에서 떼어져 터미널을 닫았습니다 — 원격 세션은 계속 돕니다."
                    .to_string(),
            });
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
///
/// There is **no `prompt`**. The daemon takes one (`spawn --prompt …`) and this
/// used to pass it through, unreachable — the form has no such field. Reviving
/// it would put the user's first message on the remote command line, where
/// every other account on that host reads it out of `ps`; the terminal sends the
/// same text down the encrypted channel a moment later, so the leak buys
/// nothing. If it is ever wanted, it belongs on stdin, not in argv.
#[tauri::command]
pub fn remote_spawn(
    remote: State<'_, RemoteState>,
    host_id: String,
    agent: String,
    cwd: String,
    account: Option<String>,
    model: Option<String>,
    label: Option<String>,
) -> Result<String, AppError> {
    let mut args: Vec<&str> = vec!["spawn", "--agent", &agent, "--cwd", &cwd];
    for (flag, value) in [("--account", &account), ("--model", &model), ("--label", &label)] {
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
    // The id came out of a counter, so some earlier terminal may have held it
    // and left its reason behind. That reason is not this terminal's, and
    // leaving it in place would answer this terminal's poll with a sentence
    // about one that closed before it existed — while blocking its own reason
    // from ever being written. Cleared here, before either relay below exists.
    remote.ended.opened(local_id);
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
    // Whichever of the two relays below gets to the end first is the one the
    // store keeps: a terminal that stopped once must not be reported as having
    // stopped twice, and the *first* reason is the real one (the connection
    // failing is why the exec never ran, not the reverse). That rule lives in
    // `EndedTerminals::record` now — it has to cover the detach path too, which
    // is a different thread entirely and never saw this attach's flag.

    // `exec_rx` is bounded and its sender blocks: held-but-undrained, it would
    // stall the read loop and, on a duplex session, the write direction with it.
    // Drained here so the exit is *said* — a terminal that stops because the
    // remote refused the command must not look like a quiet one.
    {
        let app = app.clone();
        let host = host_id.clone();
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
                    core_lib::ssh::ExecEvent::Exit {
                        code,
                        signal,
                        undelivered,
                    } => {
                        record_terminal_ended(
                            &app,
                            local_id,
                            &host,
                            code,
                            signal,
                            &exit_detail(stderr.trim(), undelivered),
                        );
                    }
                    core_lib::ssh::ExecEvent::Error(msg) => {
                        record_terminal_ended(&app, local_id, &host, None, None, &msg);
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
                record_terminal_ended(&app, local_id, &host, None, None, &detail);
            }
        });
    }
    Ok(local_id)
}

/// Write down that a remote terminal is over. Two relays watch two different
/// ways for it to end, and the store keeps whichever spoke first — see
/// [`EndedTerminals::record`].
///
/// This is also where the registry **forgets** the terminal. It has to be: a
/// terminal that ended on its own (the agent exited, `cwcd attach` was refused,
/// the connection dropped, the user pressed 닫기) is still filed under its host,
/// and a later detach would then close whatever id the session manager has since
/// handed out. That is the class R1a shipped — a detach that `SIGKILL`ed an
/// unrelated session — and the only thing standing between it and here is this
/// line. Outside the "first one wins" rule on purpose: whichever relay speaks,
/// both know the terminal is over, and forgetting twice is a no-op while
/// forgetting never is not.
fn record_terminal_ended(
    app: &AppHandle,
    id: u64,
    host_id: &str,
    code: Option<u32>,
    signal: Option<String>,
    detail: &str,
) {
    let state = app.state::<RemoteState>();
    state.registry.forget_terminal(id);
    state.ended.record(RemoteTerminalEnded {
        id,
        host_id: host_id.to_string(),
        code,
        signal,
        detail: detail.to_string(),
    });
}

/// What the panel is told when a terminal ends: the keystrokes that never got
/// there — only when there were any — and then the command's own last words.
///
/// A terminal that ends while the user's last line is still queued has one
/// symptom on screen: the line was typed and nothing happened. `core::ssh`
/// counts those bytes rather than dropping them quietly (`ExecEvent::Exit`);
/// this is where the count becomes a sentence, joined to the reason the panel
/// already asks for instead of a second thing it must listen for.
///
/// **The loss goes first, and that is not a style choice.** `endedReason` in the
/// frontend cuts the detail at 300 characters, and remote stderr runs to 4 KB —
/// appended, the one sentence the user cannot reconstruct would be the first
/// thing thrown away. Stderr is at least still on the screen above.
fn exit_detail(stderr: &str, undelivered: u64) -> String {
    if undelivered == 0 {
        return stderr.to_string();
    }
    let lost = format!("입력 {undelivered}바이트가 원격 명령에 전달되지 못했습니다.");
    if stderr.is_empty() {
        lost
    } else {
        format!("{lost}\n{stderr}")
    }
}

/// Why a remote terminal stopped — the answer to [`remote_terminal_end`].
///
/// Recorded rather than emitted: there is no existing event that carries a
/// reason (`claude-session-closed` is a bare id, and widening it would change a
/// contract five local consumers read), and inventing one is the thing R2a ④
/// forbids. It has to be said *somehow*, because "the agent exited" and
/// "`cwcd attach` was refused" leave the same silent black box otherwise.
#[derive(Clone, Serialize)]
pub struct RemoteTerminalEnded {
    pub id: u64,
    pub host_id: String,
    pub code: Option<u32>,
    pub signal: Option<String>,
    pub detail: String,
}

/// Why one remote terminal stopped, or `None` while it is still running.
///
/// Polled by the panel that owns the terminal, on the same footing as
/// [`remote_hosts`]: a question asked while the panel is open, rather than a
/// broadcast the panel must have been listening for at the right moment.
#[tauri::command]
pub fn remote_terminal_end(
    remote: State<'_, RemoteState>,
    id: u64,
) -> Option<RemoteTerminalEnded> {
    remote.ended.get(id)
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

    fn ended(id: u64, detail: &str) -> RemoteTerminalEnded {
        RemoteTerminalEnded {
            id,
            host_id: "h1".into(),
            code: None,
            signal: None,
            detail: detail.into(),
        }
    }

    /// **The cause, not the consequence.**
    ///
    /// Detaching a host closes its terminal ("떼어져 닫았습니다") and *that*
    /// drops the SSH channel, which the status relay reports as "연결이
    /// 끊어졌습니다". Both are true; only the first explains anything. A store
    /// that took the last write would leave the screen describing the effect of
    /// the user's own click as if it were an unexplained disconnection.
    #[test]
    fn the_first_reason_is_the_one_kept() {
        let store = EndedTerminals::default();
        store.record(ended(7, "이 호스트에서 떼어져 터미널을 닫았습니다"));
        store.record(ended(7, "원격 호스트와의 연결이 끊어졌습니다."));
        assert_eq!(
            store.get(7).expect("the terminal's reason").detail,
            "이 호스트에서 떼어져 터미널을 닫았습니다"
        );
        // …and a *different* terminal is a different answer, not an overwrite.
        store.record(ended(8, "exit 127"));
        assert_eq!(store.get(8).expect("another terminal").detail, "exit 127");
        assert!(store.get(9).is_none(), "a terminal still running has no reason yet");
    }

    /// **An id the manager handed out again is a different terminal.**
    ///
    /// Local session ids come from a counter and are reused. While the store
    /// kept the first reason for an id forever, a terminal that opened on a
    /// recycled id answered `remote_terminal_end` with the *previous*
    /// terminal's reason — a live terminal reported as dead, and its own real
    /// reason refused later by the same "first one wins" rule, so it could
    /// never be recorded at all. This is the R1a class (a stale id acted on as
    /// if it were the current one), and the comment on `record_terminal_ended`
    /// already takes id reuse as a fact.
    #[test]
    fn a_recycled_id_is_a_new_terminal_and_not_the_old_ones_reason() {
        let store = EndedTerminals::default();
        store.record(ended(7, "이 호스트에서 떼어져 터미널을 닫았습니다"));

        // The session manager hands 7 out again. `remote_attach` says so the
        // moment it has the id — before either relay can speak.
        store.opened(7);
        assert!(
            store.get(7).is_none(),
            "a terminal that is still running was told it had already ended, with a sentence \
             about a terminal that closed before it existed"
        );

        // …and its own reason is recordable, instead of being swallowed as a
        // second write for an id that already had one.
        store.record(ended(7, "원격 호스트에 연결하지 못했습니다: refused"));
        assert_eq!(
            store.get(7).expect("this terminal's own reason").detail,
            "원격 호스트에 연결하지 못했습니다: refused"
        );
    }

    /// The store is bounded. It is read by polling and never emptied by the
    /// reader, so without a cap it is the same unbounded webview-side growth
    /// this project already paid for once, moved to the backend.
    #[test]
    fn the_store_is_bounded_and_keeps_the_newest() {
        let store = EndedTerminals::default();
        for id in 0..(ENDED_CAP as u64 + 10) {
            store.record(ended(id, "끝"));
        }
        {
            let q = store.0.lock().unwrap();
            assert_eq!(q.reasons.len(), ENDED_CAP);
            assert!(q.lost.len() <= ENDED_CAP, "the record of what was dropped is bounded too");
        }
        assert!(
            store.get(ENDED_CAP as u64 + 9).is_some(),
            "the newest reason — the one somebody is about to ask for — is kept"
        );
    }

    /// **A reason nobody has read yet must not be evicted for one that was.**
    ///
    /// The panel polls `remote_terminal_end(id)` until it gets an answer, so a
    /// reason dropped before its owner asked leaves that poll returning `None`
    /// forever — the terminal ended, the screen says nothing, and the question
    /// never stops being asked. A plain FIFO dropped by age alone, which meant
    /// 32 terminals closing after yours took your reason with them however
    /// recently it was written.
    #[test]
    fn a_reason_nobody_has_read_outlives_the_ones_that_were_read() {
        let store = EndedTerminals::default();
        store.record(ended(1, "아직 아무도 읽지 않은 사유"));
        // The cap fills with reasons whose owners each read theirs.
        for id in 2..=(ENDED_CAP as u64 + 8) {
            store.record(ended(id, "끝"));
            store.get(id).expect("its owner reads it");
        }
        assert_eq!(
            store.get(1).expect("the unread reason is still there").detail,
            "아직 아무도 읽지 않은 사유",
            "the owner of terminal 1 was still polling; its answer was thrown away for reasons \
             that had already been delivered"
        );
    }

    /// …and when there is nothing read to drop, the drop is **said**.
    ///
    /// `None` means "still running" to the caller. A reason that was pushed out
    /// unread therefore cannot answer with `None`: that is the silent loss this
    /// whole surface exists to prevent, and it would keep the panel polling a
    /// terminal that ended long ago.
    #[test]
    fn a_reason_that_had_to_be_dropped_says_so_instead_of_reading_as_still_running() {
        let store = EndedTerminals::default();
        for id in 1..=(ENDED_CAP as u64 + 1) {
            store.record(ended(id, "끝"));
        }
        let dropped = store
            .get(1)
            .expect("a reason pushed out unread must still answer, and say what happened");
        assert!(
            dropped.detail.contains("보관 한도"),
            "the answer has to name the cap that ate it, not describe an ending: {}",
            dropped.detail
        );
        assert_eq!(dropped.host_id, "h1", "…and which host it was on survives the eviction");
        assert!(
            store.get(9_999).is_none(),
            "a terminal that never ended is still `None` — the overflow answer must not become \
             the answer to everything"
        );
    }

    /// **A terminal that ate a keystroke has to say so.**
    ///
    /// The exit reason is the only place the panel looks, so the count `core`
    /// hands up has to arrive there — and only when there is one, or every
    /// ordinary exit grows a sentence about a loss that did not happen.
    #[test]
    fn undelivered_input_joins_the_exit_reason_and_nothing_else_does() {
        assert_eq!(exit_detail("", 0), "", "an ordinary exit says only what the command said");
        assert_eq!(exit_detail("boom", 0), "boom");
        assert_eq!(
            exit_detail("", 12),
            "입력 12바이트가 원격 명령에 전달되지 못했습니다.",
            "a silent command that lost input still has to report the loss"
        );
        assert_eq!(
            exit_detail("boom", 12),
            "입력 12바이트가 원격 명령에 전달되지 못했습니다.\nboom",
            "the loss leads, because the frontend cuts the detail at 300 chars and \
             stderr can be 4 KB — appended, it would be the first thing lost"
        );
    }

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
