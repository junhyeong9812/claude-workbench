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

/// How long a short command may take before it is abandoned. `cwcd projects`
/// on a cold host scans directories, which is measured in seconds.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// A line longer than this is treated as a broken stream rather than buffered.
/// A snapshot of a busy host is legitimately megabytes (items are capped at 4
/// KB each), so the bound is high; what it rules out is a server that never
/// sends a newline holding memory forever.
const MAX_LINE: usize = 64 * 1024 * 1024;

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
}

impl HostConfig {
    fn ssh(&self, exec: String) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth: self.auth.to_method(),
            exec: Some(exec),
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
    join: Option<JoinHandle<()>>,
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
        Link { cfg, state, cancel, join: Some(join) }
    }

    pub fn snapshot(&self) -> HostSnapshot {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).snapshot()
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
        exec_capture(&self.cfg, &self.cfg.command(args), COMMAND_TIMEOUT).map(|o| o.stdout)
    }

    /// Stop observing. The remote daemon and everything it owns keep running —
    /// that is the property the whole design rests on.
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(h) = self.join.take() {
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
        if let Some(h) = self.join.take() {
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
        // Interruptible sleep — a `stop` during the backoff must not wait it out.
        let deadline = Instant::now() + backoff;
        while Instant::now() < deadline && !cancel.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(50));
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
    state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .set_phase(Phase::Idle);
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
    let (id, channels) = mgr.create_ssh(cfg.ssh(command), cfg.known_hosts.clone(), 80, 24, None);
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

    let side = SideChannels::spawn(channels, Arc::clone(cancel));

    let mut buf: Vec<u8> = Vec::new();
    let mut fatal = false;
    consume(&seed, &mut buf, state, sink, &mut fatal)?;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(chunk) => {
                if chunk.seq <= seed_seq {
                    continue; // already in the seed
                }
                consume(&chunk.bytes, &mut buf, state, sink, &mut fatal)?;
                if buf.len() > MAX_LINE {
                    return Err(Ended::Transient(
                        "원격 스트림의 한 줄이 너무 길어 연결을 끊었습니다.".into(),
                    ));
                }
            }
            Err(_) => {
                if mgr.is_alive(id) == Some(false) {
                    // Drain whatever is still queued before declaring the end.
                    while let Ok(chunk) = rx.try_recv() {
                        if chunk.seq > seed_seq {
                            consume(&chunk.bytes, &mut buf, state, sink, &mut fatal)?;
                        }
                    }
                    return Err(side.verdict(state));
                }
            }
        }
    }
}

/// Feed bytes through the line splitter and apply every complete line.
fn consume(
    bytes: &[u8],
    buf: &mut Vec<u8>,
    state: &Arc<Mutex<Host>>,
    sink: &Arc<dyn Sink>,
    fatal: &mut bool,
) -> Result<(), Ended> {
    buf.extend_from_slice(bytes);
    while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buf.drain(..=nl).collect();
        let line = String::from_utf8_lossy(&line[..line.len() - 1]).to_string();
        if line.trim().is_empty() {
            continue;
        }
        let emits = {
            let mut h = state.lock().unwrap_or_else(|p| p.into_inner());
            match decode_frame(&line) {
                Ok(frame) => match h.apply(frame) {
                    Ok(emits) => emits,
                    Err(Fatal(_)) => {
                        *fatal = true;
                        return Err(Ended::Fatal);
                    }
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
    Ok(())
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
}

impl SideChannels {
    fn spawn(channels: crate::ssh::SshChannels, cancel: Arc<AtomicBool>) -> SideChannels {
        let crate::ssh::SshChannels { mut prompt_rx, mut status_rx, mut exec_rx } = channels;
        let unknown_host_key = Arc::new(AtomicBool::new(false));
        let stderr = Arc::new(Mutex::new(String::new()));
        let status_error = Arc::new(Mutex::new(None));

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
            thread::spawn(move || {
                while let Some(ev) = exec_rx.blocking_recv() {
                    if cancel.load(Ordering::SeqCst) {
                        // Keep draining so the sender never blocks, but stop
                        // accumulating.
                        continue;
                    }
                    if let ExecEvent::Stderr(b) = ev {
                        let mut s = sink.lock().unwrap_or_else(|p| p.into_inner());
                        if s.len() < 4096 {
                            s.push_str(&String::from_utf8_lossy(&b));
                        }
                    }
                }
            });
        }
        SideChannels { unknown_host_key, stderr, status_error }
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
        Ended::Transient(match (err, stderr.is_empty()) {
            (Some(e), true) => format!("원격 연결이 끊겼습니다: {e}"),
            (Some(e), false) => format!("원격 연결이 끊겼습니다: {e} — {stderr}"),
            (None, false) => format!("원격 명령이 끝났습니다: {stderr}"),
            (None, true) => "원격 이벤트 스트림이 끊겼습니다.".into(),
        })
    }
}

// ---------------------------------------------------------------------------
// Short commands
// ---------------------------------------------------------------------------

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Run one command over its own exec channel and collect stdout.
fn exec_capture(cfg: &HostConfig, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    let mgr = SessionManager::new();
    let (id, channels) =
        mgr.create_ssh(cfg.ssh(command.to_string()), cfg.known_hosts.clone(), 80, 24, None);
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
            let stdout = String::from_utf8_lossy(&bytes).to_string();
            if stdout.trim().is_empty() {
                let err = side
                    .status_error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
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
