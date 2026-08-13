//! The transport: one SSH connection per remote host, driven by R0's
//! **output-only** exec channel.
//!
//! Two surfaces, exactly as the daemon's contract splits them:
//!
//! - **the observation window** — one long-lived `cwcd stream` exec whose stdout
//!   is NDJSON. Killing it is free: the daemon owns the agent processes, so a
//!   dropped window costs nothing but the frames it would have carried, and
//!   those are recovered by handing the stored cursor back on the next attach.
//! - **short calls** — one exec per command (`cwcd list`, `cwcd timeline …`),
//!   whose stdout is one JSON object.
//!
//! Neither reads stdin, which is why R0 is enough: an exec session here has no
//! write side at all (`ssh::SshConfig::exec` half-closes it), and every command
//! arrives as argv. Remote input — typing into a remote agent — is R2b's, and
//! nothing in this file pretends otherwise.
//!
//! ## Where the epoch comes from (the address question)
//!
//! The daemon addresses commands by `"<epoch>:k<n>"` but puts a bare key on
//! every event and on every `SessionView`; `cwcd list` therefore cannot be
//! copied into a command without pairing it with an epoch. The pairing is done
//! **here**, from the stream's own `Hello`, and not by adding an epoch field to
//! the daemon's `SessionView`:
//!
//! - the epoch is a property of the *connection*, not of each row. Repeating it
//!   on every session of every snapshot is N copies of one fact, and N copies
//!   can disagree;
//! - the consumer must discard its keys on a changed epoch regardless — so the
//!   place that composes an address and the place that invalidates one have to
//!   be the same object, and here they are (`host::Host`);
//! - a short call that races a daemon restart is then refused by the daemon
//!   (`BadRequest: minted by a different daemon incarnation`) instead of
//!   aiming at whatever holds that key now. Fail-closed, which is the property
//!   the epoch was added for.
//!
//! No change to the daemon's contract is needed for this, and none is made.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::session::SessionManager;
use crate::ssh::{AuthMethod, ExecEvent, HostKeyDecision, SshConfig};

use super::host::{Emit, Fatal, Host, HostSnapshot, NoticeLevel, Phase};
use super::proto::decode_frame;

/// Reconnect backoff bounds. The first retry is quick because the common cause
/// is a laptop lid or a Wi-Fi blip, and the ceiling is low because the whole
/// point of the cursor is that a late reconnect costs nothing.
const BACKOFF_MIN: Duration = Duration::from_millis(800);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

/// A line longer than this is dropped and the reader resynchronises at the next
/// newline. A snapshot of a busy host is legitimately megabytes (items are
/// capped at 4 KB each), so the bound is high; what it rules out is a server
/// that never sends a newline holding memory forever.
const MAX_LINE: usize = 64 * 1024 * 1024;

/// Bound on one short command's stdout. Also the reply collector's ring size,
/// which is the point: this is the number the code actually enforces, and a
/// reply that reaches it is reported as **truncated** rather than handed to the
/// JSON parser to fail as "not JSON".
const MAX_REPLY: usize = 64 * 1024 * 1024;

/// The deadlines a link runs on. Together in one struct so a test can shorten
/// them without every call site growing an argument.
#[derive(Debug, Clone, Copy)]
pub struct LinkTimeouts {
    /// How long a short command may take before it is abandoned. `cwcd projects`
    /// on a cold host scans directories, which is measured in seconds.
    pub command: Duration,
    /// How long an attach may go without a `Hello`.
    ///
    /// Connecting is not the same as being answered: a `cwcd stream` that starts
    /// and says nothing leaves the connection perfectly healthy and the panel on
    /// "연결 중" forever. With a deadline it becomes a stated failure and a retry.
    pub hello_deadline: Duration,
    /// How long the stream may go **without a complete frame** before the link
    /// is torn down and re-established.
    ///
    /// Frames, not bytes: a peer that dribbles characters without ever finishing
    /// a line leaves the screen exactly as stale as a silent one, and a watchdog
    /// fed by arrival would be held off by it forever — which is the failure
    /// this deadline exists to catch, not an exception to it. What counts is the
    /// same event that moves [`super::host::Host::last_frame_at_ms`], so the age
    /// the panel shows and the age the watchdog judges are one number.
    ///
    /// This is the whole of the workbench's liveness detection, and it exists
    /// because nothing else can do it: the observation window is *output-only*,
    /// so a peer that disappears produces no error on it; `ssh.rs` disables
    /// russh's inactivity timeout; and Linux keeps retransmitting for ~15
    /// minutes before a write ever fails. The daemon heartbeats every 15s on an
    /// idle stream (`cwc-core::ipc::heartbeat_interval`), so three missed beats
    /// is silence that means something.
    pub stale_after: Duration,
}

impl Default for LinkTimeouts {
    fn default() -> Self {
        LinkTimeouts {
            command: Duration::from_secs(30),
            hello_deadline: Duration::from_secs(20),
            stale_after: Duration::from_secs(45),
        }
    }
}

/// Credentials, in a form that can be cloned for each reconnect attempt.
/// [`AuthMethod`] cannot be, and a reconnect must not need the UI again.
#[derive(Clone)]
pub enum RemoteAuth {
    Password(String),
    PublicKey { path: String, passphrase: Option<String> },
    Agent,
}

impl RemoteAuth {
    fn to_method(&self) -> AuthMethod {
        match self {
            RemoteAuth::Password(p) => AuthMethod::Password(p.clone()),
            RemoteAuth::PublicKey { path, passphrase } => AuthMethod::PublicKey {
                path: path.clone(),
                passphrase: passphrase.clone(),
            },
            RemoteAuth::Agent => AuthMethod::Agent,
        }
    }
}

/// Everything needed to reach one host's daemon.
#[derive(Clone)]
pub struct HostConfig {
    /// Caller-chosen, stable for the life of the connection. Also the prefix of
    /// every namespaced uuid this host produces.
    pub host_id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: RemoteAuth,
    /// The daemon binary on the remote host. `cwcd` (resolved on the remote
    /// `PATH`) unless the operator installed it elsewhere.
    pub cwcd: String,
    /// `CWC_SOCKET` override for the remote daemon.
    pub socket: Option<String>,
    pub known_hosts: PathBuf,
    pub timeouts: LinkTimeouts,
}

impl HostConfig {
    /// An SSH session running `exec` on the remote host. `stdin` decides whether
    /// this is one of the observing calls (`stream`, the short commands — which
    /// must stay output-only) or a terminal attach that carries keystrokes.
    fn ssh(&self, exec: String, stdin: crate::ssh::ExecStdin) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth: self.auth.to_method(),
            exec: Some(crate::ssh::ExecSpec {
                command: exec,
                stdin,
            }),
        }
    }

    /// `[CWC_SOCKET=…] <cwcd> <args…>`, quoted for a POSIX shell — the server
    /// runs an exec request through the login shell.
    fn command(&self, args: &[&str]) -> String {
        let mut cmd = String::new();
        if let Some(sock) = &self.socket {
            cmd.push_str(&format!("CWC_SOCKET={} ", shell_quote(sock)));
        }
        cmd.push_str(&shell_quote(&self.cwcd));
        for a in args {
            cmd.push(' ');
            cmd.push_str(&shell_quote(a));
        }
        cmd
    }
}

/// Single-quote for `/bin/sh`. Everything is literal inside `'…'` except `'`
/// itself, which is closed, escaped and reopened.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Where the workbench's existing events are produced. Injected so that
/// everything above it stays tauri-free and testable — the Tauri layer's whole
/// job is one `app.emit` per variant.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, e: Emit);
}

/// A sink that keeps what it was given. Used by the integration test to assert
/// on the events a real daemon produced.
#[derive(Default)]
pub struct RecordingSink(pub Mutex<Vec<Emit>>);

impl Sink for RecordingSink {
    fn emit(&self, e: Emit) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(e);
    }
}

/// One live connection to a remote host.
pub struct Link {
    cfg: HostConfig,
    state: Arc<Mutex<Host>>,
    cancel: Arc<AtomicBool>,
    /// Behind a lock so [`Link::stop`] takes `&self`: the registry hands out
    /// shared handles (`Arc<Link>`) so a 30-second remote command can be run
    /// **without** holding the registry's own map lock.
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Link {
    /// Start observing `cfg`'s host. Returns immediately; the connection and
    /// every retry after it happen on the link's own thread, and progress is
    /// read with [`Link::snapshot`].
    pub fn start(cfg: HostConfig, sink: Arc<dyn Sink>) -> Link {
        let state = Arc::new(Mutex::new(Host::new(cfg.host_id.clone(), cfg.label.clone())));
        let cancel = Arc::new(AtomicBool::new(false));
        let join = {
            let (cfg, state, cancel) = (cfg.clone(), Arc::clone(&state), Arc::clone(&cancel));
            thread::spawn(move || run(cfg, state, cancel, sink))
        };
        Link { cfg, state, cancel, join: Mutex::new(Some(join)) }
    }

    pub fn snapshot(&self) -> HostSnapshot {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).snapshot()
    }

    /// Every session's timeline as it stands now — what a viewer that arrives
    /// after the events is seeded from ([`Host::live_payloads`]).
    pub fn live_payloads(&self) -> Vec<super::host::RemoteTimelinePayload> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .live_payloads()
    }


    /// The `"<epoch>:k<n>"` address of a remote session id, when this link has
    /// both halves. See the module docs.
    pub fn addr_of(&self, id: u64) -> Option<String> {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).addr_of(id)
    }

    /// Run one short command on the host and return its stdout.
    ///
    /// A fresh exec each time — the daemon's short surface takes its whole
    /// request as argv, so nothing here needs a persistent channel or stdin.
    pub fn call(&self, args: &[&str]) -> Result<String, String> {
        exec_capture(&self.cfg, &self.cfg.command(args), self.cfg.timeouts.command)
            .map(|o| o.stdout)
    }

    /// Stop observing. The remote daemon and everything it owns keep running —
    /// that is the property the whole design rests on.
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let handle = self
            .join
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(h) = handle {
            let _ = h.join();
        }
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_phase(Phase::Idle);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        // A link dropped without `stop` would leave its thread holding an SSH
        // connection open for the life of the process.
        self.cancel.store(true, Ordering::SeqCst);
        let handle = self.join.get_mut().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(h) = handle {
            let _ = h.join();
        }
    }
}

/// Why an attach ended.
enum Ended {
    /// The stream stopped for a reason a retry can fix.
    Transient(String),
    /// The daemon is one this workbench must not keep asking (protocol, host
    /// key). The phase is already `Failed` and the reason is already on screen.
    Fatal,
}

fn run(cfg: HostConfig, state: Arc<Mutex<Host>>, cancel: Arc<AtomicBool>, sink: Arc<dyn Sink>) {
    let mut backoff = BACKOFF_MIN;
    while !cancel.load(Ordering::SeqCst) {
        {
            let mut h = state.lock().unwrap_or_else(|p| p.into_inner());
            h.note_attempt();
            h.set_phase(Phase::Connecting);
        }
        match attach(&cfg, &state, &sink, &cancel) {
            Ok(()) => {
                // The window closed cleanly (the daemon stopped, or the exec
                // exited). Retry — but say so, because a screen that stopped
                // updating without a word is the failure this step exists to
                // prevent.
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let mut h = state.lock().unwrap_or_else(|p| p.into_inner());
                h.set_phase(Phase::Reconnecting);
                h.push_notice(
                    NoticeLevel::Warn,
                    "원격 이벤트 스트림이 끝났습니다 — 다시 붙습니다(데몬은 계속 돌고 있습니다).",
                    None,
                );
            }
            Err(Ended::Fatal) => break,
            Err(Ended::Transient(reason)) => {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .fail(Phase::Reconnecting, reason);
            }
        }
        // A window that actually worked resets the backoff. Without this the
        // delay only ever grows, so a host that drops once an hour ends up
        // waiting the full ceiling before *every* later reconnect, for the rest
        // of the session — the cost of one old failure charged forever.
        let progressed = state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .made_progress();
        if progressed {
            backoff = BACKOFF_MIN;
        }
        // Interruptible sleep — a `stop` during the backoff must not wait it out.
        let deadline = Instant::now() + backoff;
        while Instant::now() < deadline && !cancel.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    // Only a *cancel* leaves the host idle. A loop that ended because the
    // daemon is unreadable must keep saying `Failed` — overwriting it with
    // `Idle` would turn a refusal the user has to act on into a connection that
    // simply never happened, which is the quiet failure this step forbids.
    if cancel.load(Ordering::SeqCst) {
        state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_phase(Phase::Idle);
    }
}

/// One observation window: open the exec, read NDJSON until it ends.
fn attach(
    cfg: &HostConfig,
    state: &Arc<Mutex<Host>>,
    sink: &Arc<dyn Sink>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), Ended> {
    let cursor = state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .cursor()
        .map(str::to_string);
    let mut args: Vec<&str> = vec!["stream"];
    if let Some(c) = &cursor {
        args.push("--cursor");
        args.push(c);
    }
    let command = cfg.command(&args);

    let mgr = SessionManager::new();
    let (id, channels) = mgr.create_ssh(
        cfg.ssh(command, crate::ssh::ExecStdin::Eof),
        cfg.known_hosts.clone(),
        80,
        24,
        None,
    );
    // Removing the session is what cancels the SSH thread; a guard so every
    // exit path below (including a panic) tears the connection down.
    let _guard = SessionGuard { mgr: &mgr, id };

    // Subscribe *before* snapshotting: the documented no-loss order is
    // snapshot-then-apply-chunks-with-a-greater-seq, and subscribing first only
    // risks duplicates, which the seq filter removes.
    let rx = mgr
        .subscribe(id)
        .map_err(|e| Ended::Transient(format!("원격 출력을 구독하지 못했습니다: {e}")))?;
    let (seed, seed_seq) = mgr.snapshot(id).unwrap_or_default();
    // The seed comes out of the session's scrollback ring, which drops from the
    // *front* when it is full. A seed at the cap is therefore a stream whose
    // beginning is already gone, and feeding a headless fragment to the decoder
    // would report it as unreadable JSON instead of as what it is.
    if seed.len() >= crate::session::DEFAULT_SCROLLBACK_CAP {
        return Err(Ended::Transient(
            "원격 스트림의 시작 부분을 놓쳤습니다(버퍼 초과) — 다시 붙습니다.".into(),
        ));
    }

    let side = SideChannels::spawn(channels, Arc::clone(cancel));

    let mut lines = LineReader::default();
    let started = Instant::now();
    consume(&seed, &mut lines, state, sink)?;
    // The staleness clock ticks on **frames**. Arriving bytes are not evidence
    // that the daemon is still saying anything: a wedged writer that emits a
    // character now and then never completes a line, so the screen goes on
    // showing what it showed while the watchdog is pushed back every time.
    let mut last_frame_at = Instant::now();

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(chunk) => {
                // `chunk.seq <= seed_seq` is already in the seed.
                if chunk.seq > seed_seq && consume(&chunk.bytes, &mut lines, state, sink)? > 0 {
                    last_frame_at = Instant::now();
                }
            }
            Err(_) => {
                if mgr.is_alive(id) == Some(false) {
                    // Drain whatever is still queued before declaring the end.
                    while let Ok(chunk) = rx.try_recv() {
                        if chunk.seq > seed_seq {
                            consume(&chunk.bytes, &mut lines, state, sink)?;
                        }
                    }
                    return Err(side.verdict(state));
                }
            }
        }
        // Checked on **every** turn, not only on a quiet one: a stream that
        // dribbles bytes keeps `recv_timeout` returning `Ok`, and a deadline
        // that only ran when the channel went quiet would never run at all
        // against exactly the peer it is meant to catch.
        //
        // The connection being *up* is not the same as the daemon still talking
        // to us, and on an output-only stream it is the only thing the socket
        // can tell us — hence both deadlines.
        let live = state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .made_progress();
        if !live && started.elapsed() > cfg.timeouts.hello_deadline {
            return Err(Ended::Transient(format!(
                "원격 데몬이 {}초 안에 응답하지 않았습니다(cwcd stream 이 시작되지 않았거나 막혀 있습니다) — 다시 시도합니다.",
                cfg.timeouts.hello_deadline.as_secs()
            )));
        }
        if live && last_frame_at.elapsed() > cfg.timeouts.stale_after {
            return Err(Ended::Transient(format!(
                "원격 데몬에서 {}초 동안 프레임이 오지 않았습니다(하트비트도 없음) — 연결은 살아 있지만 화면이 낡습니다. 다시 붙습니다.",
                cfg.timeouts.stale_after.as_secs()
            )));
        }
    }
}

/// Splits a byte stream into NDJSON lines.
///
/// A line that grows past [`MAX_LINE`] is **dropped and resynchronised at the
/// next newline**, not turned into a disconnect: a reconnect resumes from the
/// same cursor, so the same oversized line arrives again and the link livelocks,
/// reconnecting forever without ever making progress. Dropping it loses one
/// line — which was unusable anyway — and says so.
#[derive(Default)]
struct LineReader {
    buf: Vec<u8>,
    /// Inside an oversized line: everything up to the next newline is its tail.
    skipping: bool,
}

impl LineReader {
    /// Feed bytes; returns the complete lines and how many bytes were dropped.
    fn feed(&mut self, bytes: &[u8]) -> (Vec<String>, usize) {
        let mut out = Vec::new();
        let mut dropped = 0usize;
        self.buf.extend_from_slice(bytes);
        loop {
            match self.buf.iter().position(|b| *b == b'\n') {
                Some(nl) => {
                    let line: Vec<u8> = self.buf.drain(..=nl).collect();
                    if self.skipping {
                        dropped += line.len();
                        self.skipping = false;
                        continue;
                    }
                    let line = String::from_utf8_lossy(&line[..line.len() - 1]);
                    if !line.trim().is_empty() {
                        out.push(line.to_string());
                    }
                }
                None => {
                    if self.buf.len() > MAX_LINE {
                        dropped += self.buf.len();
                        self.buf.clear();
                        self.skipping = true;
                    }
                    break;
                }
            }
        }
        (out, dropped)
    }
}

/// Feed bytes through the line splitter and apply every complete line.
///
/// Returns **how many complete lines were applied** — precisely the events that
/// move `Host::last_frame_at_ms`, which is why the staleness watchdog counts
/// this and not arriving bytes: the age on screen and the age the watchdog
/// judges have to be the same number, or the panel and the reconnect decision
/// disagree about whether anything is still coming.
fn consume(
    bytes: &[u8],
    lines: &mut LineReader,
    state: &Arc<Mutex<Host>>,
    sink: &Arc<dyn Sink>,
) -> Result<usize, Ended> {
    let (lines, dropped) = lines.feed(bytes);
    if dropped > 0 {
        state.lock().unwrap_or_else(|p| p.into_inner()).push_notice(
            NoticeLevel::Warn,
            format!(
                "원격 스트림의 한 줄이 너무 길어 {dropped}바이트를 버리고 다음 줄부터 다시 읽습니다."
            ),
            None,
        );
    }
    // An oversized line is deliberately *not* counted: it was dropped, no frame
    // came of it, and `Host::last_frame_at_ms` did not move either.
    let mut applied = 0usize;
    for line in lines {
        applied += 1;
        let emits = {
            let mut h = state.lock().unwrap_or_else(|p| p.into_inner());
            match decode_frame(&line) {
                Ok(frame) => match h.apply(frame) {
                    Ok(emits) => emits,
                    // The phase and the reason are already on screen (`on_hello`).
                    Err(Fatal(_)) => return Err(Ended::Fatal),
                },
                Err(reason) => {
                    h.on_undecodable(reason);
                    Vec::new()
                }
            }
        };
        for e in emits {
            sink.emit(e);
        }
    }
    Ok(applied)
}

/// Keeps the SSH session torn down on every exit path.
struct SessionGuard<'a> {
    mgr: &'a SessionManager,
    id: u64,
}

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        let _ = self.mgr.remove(self.id);
    }
}

/// The status / host-key / exec side channels of one SSH session, drained on
/// their own threads.
///
/// Draining `exec_rx` is not optional: it is bounded and its sender **blocks**,
/// so a receiver that is held but not polled stalls the whole read loop —
/// including stdout, which arrives on a different channel and would look
/// unrelated.
struct SideChannels {
    /// Set when the server's host key is not in our known_hosts. Retrying
    /// cannot fix it, so it turns the end of the attach into a fatal one.
    unknown_host_key: Arc<AtomicBool>,
    stderr: Arc<Mutex<String>>,
    status_error: Arc<Mutex<Option<String>>>,
    /// The remote command's exit status. `127` is the shell's "not found",
    /// which is how a missing `cwcd` arrives.
    exit_code: Arc<Mutex<Option<u32>>>,
}

impl SideChannels {
    fn spawn(channels: crate::ssh::SshChannels, cancel: Arc<AtomicBool>) -> SideChannels {
        let crate::ssh::SshChannels { mut prompt_rx, mut status_rx, mut exec_rx } = channels;
        let unknown_host_key = Arc::new(AtomicBool::new(false));
        let stderr = Arc::new(Mutex::new(String::new()));
        let status_error = Arc::new(Mutex::new(None));
        let exit_code = Arc::new(Mutex::new(None));

        {
            // An unknown host key is **refused**, not prompted for. A remote
            // host is attached in the background and reconnects on its own, so
            // a first-contact dialog would appear at an arbitrary moment (and
            // again on every retry). The user accepts a key the way they always
            // have — by opening a terminal to that host once.
            let flag = Arc::clone(&unknown_host_key);
            thread::spawn(move || {
                while let Some(c) = prompt_rx.blocking_recv() {
                    flag.store(true, Ordering::SeqCst);
                    let _ = c.reply.send(HostKeyDecision::Reject);
                }
            });
        }
        {
            let slot = Arc::clone(&status_error);
            thread::spawn(move || {
                while let Some(s) = status_rx.blocking_recv() {
                    if let crate::ssh::SshStatus::Failed(reason) = s {
                        *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(reason);
                    }
                }
            });
        }
        {
            let sink = Arc::clone(&stderr);
            let code = Arc::clone(&exit_code);
            thread::spawn(move || {
                while let Some(ev) = exec_rx.blocking_recv() {
                    if cancel.load(Ordering::SeqCst) {
                        // Keep draining so the sender never blocks, but stop
                        // accumulating.
                        continue;
                    }
                    match ev {
                        ExecEvent::Stderr(b) => {
                            let mut s = sink.lock().unwrap_or_else(|p| p.into_inner());
                            if s.len() < 4096 {
                                s.push_str(&String::from_utf8_lossy(&b));
                            }
                        }
                        ExecEvent::Exit { code: c, .. } => {
                            *code.lock().unwrap_or_else(|p| p.into_inner()) = c;
                        }
                        _ => {}
                    }
                }
            });
        }
        SideChannels { unknown_host_key, stderr, status_error, exit_code }
    }

    /// Why the window ended, in the user's words.
    fn verdict(&self, state: &Arc<Mutex<Host>>) -> Ended {
        if self.unknown_host_key.load(Ordering::SeqCst) {
            let msg = "이 호스트의 SSH 키를 아직 신뢰하지 않습니다 — 먼저 이 호스트로 SSH 터미널을 한 번 열어 키를 확인한 뒤 다시 연결하세요.";
            state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .fail(Phase::Failed, msg);
            return Ended::Fatal;
        }
        let err = self
            .status_error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let stderr = self.stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let stderr = stderr.trim().to_string();
        let code = *self.exit_code.lock().unwrap_or_else(|p| p.into_inner());

        // A failure a retry cannot fix must **stop**, not be re-offered every
        // few seconds — see [`permanent_reason`].
        if let Some(msg) = permanent_reason(err.as_deref(), &stderr, code) {
            state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .fail(Phase::Failed, msg);
            return Ended::Fatal;
        }

        Ended::Transient(match (err, stderr.is_empty()) {
            (Some(e), true) => format!("원격 연결이 끊겼습니다: {e}"),
            (Some(e), false) => format!("원격 연결이 끊겼습니다: {e} — {stderr}"),
            (None, false) => format!("원격 명령이 끝났습니다: {stderr}"),
            (None, true) => "원격 이벤트 스트림이 끊겼습니다.".into(),
        })
    }
}

/// The reason this attach must **not** be retried, in the user's words — or
/// `None` when a retry is the right answer.
///
/// The distinction is not cosmetic. A retry loop runs every ≤15s forever, so
/// classifying a rejected credential as transient means re-offering it to the
/// remote `sshd` at that rate indefinitely: `MaxAuthTries` and fail2ban then do
/// exactly what they are for, and the user's own address is blocked from the
/// host they were trying to reach. Every string matched here is a fixed one
/// produced by `crate::ssh` (`authenticate`, `authenticate_agent`) or by the
/// remote shell, and every one of them names something only the user can fix.
///
/// A bare `"authentication error"` is deliberately *not* here: `ssh.rs` produces
/// it for a transport error that happened during the auth phase, which is a
/// broken network rather than a rejected credential.
fn permanent_reason(status_error: Option<&str>, stderr: &str, exit_code: Option<u32>) -> Option<String> {
    let err = status_error.unwrap_or_default();
    if err.contains("authentication failed") {
        return Some(
            "SSH 인증이 거부되었습니다 — 자격 증명을 고치기 전에는 다시 시도해도 같습니다(계속 시도하면 원격 sshd 가 이 주소를 차단합니다). 연결 설정을 확인한 뒤 다시 연결하세요."
                .into(),
        );
    }
    if err.contains("could not load private key") {
        return Some(
            "개인 키를 읽지 못했습니다(경로 또는 passphrase가 맞지 않습니다) — 연결 설정을 고친 뒤 다시 연결하세요."
                .into(),
        );
    }
    if err.contains("ssh-agent is not available") || err.contains("ssh-agent has no identities") {
        return Some(
            "ssh-agent 를 쓸 수 없습니다(실행 중이 아니거나 등록된 키가 없습니다) — 키를 등록한 뒤 다시 연결하세요."
                .into(),
        );
    }
    // The remote shell's own verdict. 127 is "command not found"; the message
    // differs by shell, so the code is what is matched and the text is only
    // shown.
    if exit_code == Some(127) || stderr.contains("not found") {
        let detail = if stderr.is_empty() { String::new() } else { format!(" — {stderr}") };
        return Some(format!(
            "원격 호스트에서 cwcd 를 실행하지 못했습니다{detail}. 데몬을 설치하거나 이 연결의 cwcd 경로를 지정한 뒤 다시 연결하세요."
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// Short commands
// ---------------------------------------------------------------------------

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Assemble a short command's stdout, refusing a **truncated** one.
///
/// The collector is a byte ring that drops from the front when it is full, so a
/// reply at the cap is one whose beginning is gone. Handing that to the JSON
/// parser produces "daemon reply is not JSON" — a misdiagnosis that sends the
/// reader looking at the daemon's output instead of at the buffer that ate it.
fn assemble_reply(bytes: &[u8], cap: usize) -> Result<String, String> {
    if bytes.len() >= cap {
        return Err(format!(
            "원격 응답이 너무 커서({}MB 상한) 앞부분이 잘렸습니다 — 잘린 조각을 읽으려 하지 않았습니다.",
            cap / (1024 * 1024)
        ));
    }
    Ok(String::from_utf8_lossy(bytes).to_string())
}

/// Run one command over its own exec channel and collect stdout.
fn exec_capture(cfg: &HostConfig, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    // A collector sized for a **reply**, not a terminal's scrollback. The
    // default 1 MB ring is right for a PTY that scrolls forever and wrong for a
    // single JSON object that must arrive whole: `cwcd timeline` on a long
    // session is legitimately larger than that, and the ring drops from the
    // front, so the reply arrived headless and was reported as malformed JSON.
    let mgr = SessionManager::with_cap(MAX_REPLY);
    let (id, channels) =
        mgr.create_ssh(
        cfg.ssh(command.to_string(), crate::ssh::ExecStdin::Eof),
        cfg.known_hosts.clone(),
        80,
        24,
        None,
    );
    let _guard = SessionGuard { mgr: &mgr, id };
    let side = SideChannels::spawn(channels, Arc::new(AtomicBool::new(false)));

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if mgr.is_alive(id) == Some(false) {
            let (bytes, _) = mgr.snapshot(id).unwrap_or_default();
            let stderr = side.stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if side.unknown_host_key.load(Ordering::SeqCst) {
                return Err(
                    "이 호스트의 SSH 키를 아직 신뢰하지 않습니다 — 먼저 SSH 터미널로 한 번 접속해 키를 확인하세요."
                        .into(),
                );
            }
            let stdout = assemble_reply(&bytes, MAX_REPLY)?;
            if stdout.trim().is_empty() {
                let err = side
                    .status_error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                let code = *side.exit_code.lock().unwrap_or_else(|p| p.into_inner());
                // The same classification the stream uses, so "cwcd is not
                // installed" reads the same whichever surface hit it first.
                if let Some(msg) = permanent_reason(err.as_deref(), stderr.trim(), code) {
                    return Err(msg);
                }
                return Err(match (err, stderr.trim().is_empty()) {
                    (Some(e), _) => format!("원격 명령을 실행하지 못했습니다: {e}"),
                    (None, false) => format!("원격 명령이 실패했습니다: {}", stderr.trim()),
                    (None, true) => "원격 명령이 아무 것도 돌려주지 않았습니다.".into(),
                });
            }
            return Ok(ExecOutput { stdout, stderr });
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("원격 명령이 제한 시간 안에 끝나지 않았습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> HostConfig {
        HostConfig {
            host_id: "h1".into(),
            label: "l".into(),
            host: "127.0.0.1".into(),
            port: 22,
            username: "jun".into(),
            auth: RemoteAuth::Agent,
            cwcd: "cwcd".into(),
            socket: None,
            known_hosts: PathBuf::from("/tmp/kh"),
            timeouts: LinkTimeouts::default(),
        }
    }

    #[test]
    fn a_command_is_quoted_so_a_path_with_a_space_or_a_quote_cannot_split_it() {
        let mut c = cfg();
        c.cwcd = "/opt/my daemons/cwcd".into();
        c.socket = Some("/run/it's here/d.sock".into());
        assert_eq!(
            c.command(&["timeline", "e:k1"]),
            r#"CWC_SOCKET='/run/it'\''s here/d.sock' '/opt/my daemons/cwcd' 'timeline' 'e:k1'"#
        );
    }

    #[test]
    fn no_socket_override_means_the_daemons_own_default() {
        assert_eq!(cfg().command(&["list"]), "'cwcd' 'list'");
    }

    /// Every one of these is a failure the user has to fix, and a retry loop
    /// runs every ≤15s forever. The password case is the one with teeth: while
    /// it was "transient", a saved connection with no keychain entry sent an
    /// **empty password** at that rate until the remote `sshd` blocked the
    /// address.
    #[test]
    fn a_failure_only_the_user_can_fix_stops_the_retry_loop() {
        let permanent = [
            "authentication failed (server rejected the credentials)",
            "ssh-agent authentication failed (no identity accepted)",
            "could not load private key (wrong path or passphrase)",
            "ssh-agent is not available",
            "ssh-agent has no identities loaded",
        ];
        for e in permanent {
            assert!(
                permanent_reason(Some(e), "", None).is_some(),
                "must be terminal, not retried forever: {e}"
            );
        }
        // The daemon is not installed / not on PATH — the shell's own verdict.
        assert!(permanent_reason(None, "sh: 1: cwcd: not found", Some(127))
            .expect("127 is terminal")
            .contains("cwcd"));
        assert!(permanent_reason(None, "", Some(127)).is_some(), "the code alone is enough");

        // …and everything a retry *can* fix stays retryable.
        for e in [
            "could not connect to the host (check address/port, host key, or network)",
            "authentication error", // a transport error during auth = a broken network
            "runtime init failed: x",
        ] {
            assert_eq!(permanent_reason(Some(e), "", None), None, "must stay retryable: {e}");
        }
        assert_eq!(permanent_reason(None, "", Some(0)), None);
        assert_eq!(permanent_reason(None, "", None), None);
    }

    /// A reply that hit the collector's cap lost its **front**, so parsing it
    /// reports a malformed daemon rather than a buffer that ate the answer.
    #[test]
    fn a_truncated_reply_is_named_as_truncated_not_as_bad_json() {
        assert_eq!(assemble_reply(b"{\"response\":\"sessions\"}", 64).unwrap(), r#"{"response":"sessions"}"#);
        let err = assemble_reply(&vec![b'x'; 64], 64).unwrap_err();
        assert!(err.contains("잘렸"), "{err}");
        // The collector is sized for a reply, not for a terminal's scrollback —
        // the 1 MB default is what truncated `cwcd timeline` on a long session.
        assert!(MAX_REPLY > crate::session::DEFAULT_SCROLLBACK_CAP);
    }

    /// An over-long line is dropped and the reader picks up at the next newline.
    /// Returning a disconnect instead meant reconnecting from the *same* cursor,
    /// receiving the same line, and never making progress.
    #[test]
    fn an_oversized_line_is_dropped_and_the_reader_resynchronises() {
        let mut r = LineReader::default();
        let (lines, dropped) = r.feed(b"{\"frame\":\"a\"}\n");
        assert_eq!(lines, vec![r#"{"frame":"a"}"#]);
        assert_eq!(dropped, 0);

        // A line that never ends, fed in pieces.
        let huge = vec![b'x'; MAX_LINE / 2 + 1];
        assert_eq!(r.feed(&huge).0.len(), 0);
        let (lines, dropped) = r.feed(&huge);
        assert!(lines.is_empty());
        assert!(dropped > MAX_LINE, "the buffer must be released, not held");
        // Its tail is skipped, and the next whole line is read normally.
        let (lines, _) = r.feed(b"tail-of-the-monster\n{\"frame\":\"b\"}\n");
        assert_eq!(lines, vec![r#"{"frame":"b"}"#], "the reader must recover in place");
    }

    #[test]
    fn a_partial_line_waits_for_its_newline() {
        let mut r = LineReader::default();
        assert!(r.feed(b"{\"fra").0.is_empty());
        assert!(r.feed(b"me\":\"a\"}").0.is_empty());
        assert_eq!(r.feed(b"\n\n  \n").0, vec![r#"{"frame":"a"}"#]);
    }

    #[test]
    fn the_stream_command_carries_the_cursor_verbatim() {
        let c = cfg();
        // The cursor is the daemon's own string, colons and all.
        assert_eq!(
            c.command(&["stream", "--cursor", "0c44fa05:7"]),
            "'cwcd' 'stream' '--cursor' '0c44fa05:7'"
        );
    }
}
