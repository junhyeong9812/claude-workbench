//! Native SSH transport (russh) — remote terminals on the **same** output
//! pipeline as local PTYs.
//!
//! This module owns a tokio runtime, but keeps it **encapsulated on a dedicated
//! OS thread per session** so [`crate::session::SessionManager`]'s public API
//! stays synchronous and the rest of `core` stays runtime-free. It is also
//! **tauri-free**: the host-key challenge is surfaced over a channel
//! ([`HostKeyChallenge`]); the Tauri layer turns it into a UI event and feeds the
//! decision back. `core` never knows about Tauri (review: F1).
//!
//! Design (review-log F1~F12, D1~D4, C2/C9):
//! - input is a **bounded** mpsc (`try_send`, never blocks the caller, bounds
//!   memory under remote back-pressure — F4/D2); resize is a `watch` coalescing
//!   to the latest size (D2/F7-resize).
//! - every await point is cancelled by dropping the run future via the outer
//!   `select!` against `cancel` (F3/C…); teardown joins the thread.
//! - an [`AliveGuard`] marks the session dead + emits `Closed` on **every** exit
//!   path (connect/auth/host-key/cancel/panic — C9).
//! - host-key check distinguishes match / mismatch / unknown (F7).

use std::path::PathBuf;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};

use russh::client;
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;

use crate::session::Shared;

/// Bounded input queue depth (messages). Beyond this, keystrokes are dropped with
/// an error rather than growing memory unbounded (review D2).
const INPUT_QUEUE: usize = 512;
/// Each input message is written to the channel in chunks this size, so one large
/// paste can't monopolize the select loop and starve output polling (review D3).
const WRITE_CHUNK: usize = 8192;
/// Depth (messages) of the **exec** event queue (stderr chunks + the terminal
/// event). Bounded so a remote command flooding stderr can't grow memory without
/// limit before a consumer drains it (review F1 — was unbounded = memory DoS).
/// The send side blocks on a full queue (`send().await`), which stops the channel
/// read loop and back-pressures the remote — the exec analogue of the local
/// scrollback's bounded ring. 256 chunks bounds the buffer to a few MB (russh
/// data chunks are ≤ the negotiated max packet, ~32 KB) — the same order as the
/// 1 MB stdout scrollback — while absorbing normal bursty stderr without
/// throttling. The queue is cancellable via the outer `select!`, so a stalled
/// consumer never blocks teardown.
const EXEC_EVENT_QUEUE: usize = 256;
/// Idle timeout for the connection (also bounds a hung connect/auth).
const INACTIVITY_SECS: u64 = 0; // 0 = disabled; keepalive handled below.
const KEEPALIVE_SECS: u64 = 30;

/// How the client authenticates to the server.
pub enum AuthMethod {
    Password(String),
    PublicKey {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

/// Everything needed to open a remote session (no secrets persisted here — the
/// Tauri layer assembles this transiently, sourcing passwords from the keychain
/// in phase 2).
///
/// Note (review P3): adding a required field to this struct is a non-additive
/// change for a struct-literal caller. It is fine here because `core` is an
/// **internal crate** (the only caller is `src-tauri`, updated in lockstep); if
/// this were ever published, switch to a builder / `#[non_exhaustive]` so new
/// fields don't break downstream literals.
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Remote execution mode (R0 seam — additive). `None` keeps the existing
    /// interactive **pty + shell** path byte-for-byte. `Some(command)` opens a
    /// **non-TTY exec channel** running `command`: stdout flows through the shared
    /// `terminal-output` pipeline (`Shared::emit`), stderr and the exit status are
    /// surfaced separately over [`ExecEvent`] (structured stream-json prep, R1+).
    /// This carries a generic command — remote claude/codex argv·env·cwd wiring is
    /// R1's job, not hardcoded here.
    pub exec: Option<String>,
}

/// Events specific to an **exec-channel** session (non-TTY remote command). Only
/// produced when [`SshConfig::exec`] is `Some`; the interactive shell path never
/// emits these. stdout is deliberately *not* here — it rides the same
/// `Shared::emit` / `terminal-output-{id}` byte pipeline as every other session,
/// so existing consumers render it unchanged.
pub enum ExecEvent {
    /// A chunk of the remote command's **stderr** (SSH extended data, `ext == 1`),
    /// kept separate from stdout so a structured consumer (R1+ stream-json) can
    /// distinguish the two streams.
    Stderr(Vec<u8>),
    /// The remote command finished. `code` is the exit status (`None` if the
    /// server sent no exit-status, e.g. death by signal); `signal` names the
    /// terminating signal when the command was killed (abnormal termination).
    /// This is the **normal** terminal event.
    Exit {
        code: Option<u32>,
        signal: Option<String>,
    },
    /// The exec could not run to a normal exit — the server **rejected** the exec
    /// request, or the request could not be sent. This is a terminal event too:
    /// a consumer always receives exactly one of `Exit` / `Error`, never a silent
    /// end (review F4 — the exec channel's "always terminal" contract).
    Error(String),
}

/// The user's verdict on an unknown host key.
pub enum HostKeyDecision {
    Accept,
    Reject,
}

/// Reply channel back into the connecting session thread (alias so the Tauri
/// layer needn't name tokio).
pub type HostKeyReply = oneshot::Sender<HostKeyDecision>;

/// Raised when connecting to a host whose key is not yet known (TOFU). The Tauri
/// layer shows the fingerprint and sends the decision through `reply`.
pub struct HostKeyChallenge {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub reply: HostKeyReply,
}

/// Connection lifecycle, relayed to the UI as `ssh-status` events.
pub enum SshStatus {
    Connecting,
    Ready,
    /// Terminal failure with a user-safe reason (no paths/stack).
    Failed(String),
    Closed,
}

/// Streams handed back to the Tauri layer at create time: host-key challenges to
/// prompt for, and status transitions to relay.
pub struct SshChannels {
    pub prompt_rx: mpsc::UnboundedReceiver<HostKeyChallenge>,
    pub status_rx: mpsc::UnboundedReceiver<SshStatus>,
    /// Exec-mode side channel (stderr + terminal event). Stays silent for the
    /// interactive shell path; only an [`SshConfig::exec`] session emits on it.
    /// **Bounded** (`EXEC_EVENT_QUEUE`): the sender blocks when full, so a stalled
    /// consumer back-pressures the remote instead of growing memory (review F1).
    pub exec_rx: mpsc::Receiver<ExecEvent>,
}

/// Manager-held handles for a live SSH session.
pub struct SshHandle {
    input_tx: mpsc::Sender<Vec<u8>>,
    size_tx: watch::Sender<(u16, u16)>,
    cancel_tx: watch::Sender<bool>,
    /// Signals a one-shot stdin **half-close** (EOF) for an exec session — flushes
    /// pending input, then sends `channel.eof()` so a stdin-reading remote command
    /// (e.g. `cat`) can finish (review F2). Distinct from [`cancel`], which aborts
    /// the whole session; this only closes the input direction. No effect on the
    /// interactive shell path (its loop ignores this watch).
    close_stdin_tx: watch::Sender<bool>,
    join: Option<JoinHandle<()>>,
}

impl SshHandle {
    /// Enqueue input (keystrokes). Never blocks the caller (F4); on a full queue
    /// or a closed session it returns an error instead of growing memory (D2).
    pub fn send_input(&self, data: &[u8]) -> Result<(), String> {
        use mpsc::error::TrySendError;
        match self.input_tx.try_send(data.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err("ssh input buffer full".into()),
            Err(TrySendError::Closed(_)) => Err("ssh session is closed".into()),
        }
    }

    /// Set the latest terminal size; the loop coalesces to this value (D2).
    pub fn set_size(&self, cols: u16, rows: u16) {
        let _ = self.size_tx.send((cols.max(1), rows.max(1)));
    }

    /// Signal cancellation — drops every pending await on the session thread.
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }

    /// Half-close stdin on an **exec** session: the session flushes any queued
    /// input, then sends channel EOF so a stdin-reading remote command can reach
    /// its exit (review F2). Idempotent; a no-op on the interactive shell path.
    /// This is *not* cancellation — the command keeps running until it exits.
    pub fn close_stdin(&self) {
        let _ = self.close_stdin_tx.send(true);
    }

    /// Join the session thread (call after [`cancel`]). Idempotent.
    pub fn join(&mut self) {
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }
}

/// Marks the session dead and emits `Closed` on drop — fires on *every* thread
/// exit path (success, error, host-key reject, cancel, panic). Review C9.
struct AliveGuard {
    shared: Arc<Shared>,
    status_tx: mpsc::UnboundedSender<SshStatus>,
}
impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.shared.set_dead();
        let _ = self.status_tx.send(SshStatus::Closed);
    }
}

/// Spawn the dedicated session thread (own tokio runtime). Returns immediately —
/// connect/auth happen on the thread; progress flows through `SshChannels`.
pub(crate) fn spawn_ssh(
    config: SshConfig,
    shared: Arc<Shared>,
    known_hosts_path: PathBuf,
    cols: u16,
    rows: u16,
) -> (SshHandle, SshChannels) {
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
    let (size_tx, size_rx) = watch::channel((cols.max(1), rows.max(1)));
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (prompt_tx, prompt_rx) = mpsc::unbounded_channel::<HostKeyChallenge>();
    let (status_tx, status_rx) = mpsc::unbounded_channel::<SshStatus>();
    // Bounded so stderr can't accumulate without limit (review F1).
    let (exec_tx, exec_rx) = mpsc::channel::<ExecEvent>(EXEC_EVENT_QUEUE);
    let (close_stdin_tx, close_stdin_rx) = watch::channel(false);

    let join = thread::spawn(move || {
        // current-thread runtime is enough (one connection per thread) but it
        // MUST have the IO driver enabled or russh's TCP I/O won't run (D4).
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = status_tx.send(SshStatus::Failed(format!("runtime init failed: {e}")));
                shared.set_dead();
                return;
            }
        };
        rt.block_on(async move {
            // Guard fires on any exit below (incl. the run future being dropped by
            // a cancel) — alive=false + Closed always emitted.
            let _guard = AliveGuard {
                shared: Arc::clone(&shared),
                status_tx: status_tx.clone(),
            };
            let mut cancel_rx = cancel_rx;
            tokio::select! {
                res = run(&config, &shared, &known_hosts_path, &prompt_tx, &status_tx, &exec_tx, input_rx, size_rx, close_stdin_rx) => {
                    if let Err(reason) = res {
                        let _ = status_tx.send(SshStatus::Failed(reason));
                    }
                }
                _ = cancel_rx.changed() => { /* cancelled — guard cleans up */ }
            }
        });
    });

    (
        SshHandle {
            input_tx,
            size_tx,
            cancel_tx,
            close_stdin_tx,
            join: Some(join),
        },
        SshChannels {
            prompt_rx,
            status_rx,
            exec_rx,
        },
    )
}

/// The connect → auth → pty → shell → IO pump. Returns `Err(reason)` with a
/// user-safe message on any failure (review F10: distinct causes).
#[allow(clippy::too_many_arguments)]
async fn run(
    config: &SshConfig,
    shared: &Arc<Shared>,
    known_hosts_path: &PathBuf,
    prompt_tx: &mpsc::UnboundedSender<HostKeyChallenge>,
    status_tx: &mpsc::UnboundedSender<SshStatus>,
    exec_tx: &mpsc::Sender<ExecEvent>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut size_rx: watch::Receiver<(u16, u16)>,
    close_stdin_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let _ = status_tx.send(SshStatus::Connecting);

    let mut cfg = client::Config::default();
    if INACTIVITY_SECS > 0 {
        cfg.inactivity_timeout = Some(Duration::from_secs(INACTIVITY_SECS));
    }
    cfg.keepalive_interval = Some(Duration::from_secs(KEEPALIVE_SECS));
    let cfg = Arc::new(cfg);

    let handler = ClientHandler {
        host: config.host.clone(),
        port: config.port,
        known_hosts_path: known_hosts_path.clone(),
        prompt_tx: prompt_tx.clone(),
    };

    let mut handle = client::connect(cfg, (config.host.as_str(), config.port), handler)
        .await
        .map_err(|e| map_connect_error(e))?;

    authenticate(&mut handle, config).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|_| "failed to open session channel".to_string())?;

    // R0 exec seam: a `Some(command)` config runs a non-TTY remote command on a
    // separate code path and returns here, so the interactive pty+shell block
    // below stays untouched (regression 0). `None` falls through to the shell.
    if let Some(command) = &config.exec {
        return run_exec(
            channel,
            command,
            shared,
            status_tx,
            exec_tx,
            input_rx,
            close_stdin_rx,
        )
        .await;
    }
    // Shell path does not use the stdin half-close seam (it stays open for the
    // life of the interactive session); drop the receiver explicitly.
    drop(close_stdin_rx);

    let (cols, rows) = *size_rx.borrow();
    // want_reply=true so a server that *rejects* the PTY surfaces as a
    // `ChannelMsg::Failure` we can act on, instead of silently starting a
    // shell with no PTY (review P1-R3).
    channel
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|_| "failed to request PTY".to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|_| "failed to start remote shell".to_string())?;

    let _ = status_tx.send(SshStatus::Ready);

    let mut channel = channel;
    // Outbound backlog: at most one WRITE_CHUNK is written per loop turn, so a
    // large paste never monopolizes the loop and starves output polling
    // (review P1-R1). New input is pulled only when the backlog is empty
    // (back-pressure); the always-ready flush branch guarantees the backlog
    // drains even when no output/resize events arrive.
    let mut pending: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => shared.emit(data),
                Some(ChannelMsg::ExtendedData { ref data, .. }) => shared.emit(data),
                // A request we made (PTY/shell) was rejected by the server.
                Some(ChannelMsg::Failure) => {
                    return Err("server rejected the PTY/shell request".into());
                }
                // Remote closed, EOF, or the stream ended (None) — done (D1).
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {} // Success and other acks
            },
            inp = input_rx.recv(), if pending.is_empty() => match inp {
                Some(bytes) => pending = bytes,
                None => break, // all input senders dropped (D1)
            },
            changed = size_rx.changed() => match changed {
                Ok(_) => {
                    let (c, r) = *size_rx.borrow();
                    let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                }
                Err(_) => break, // all size senders dropped -> teardown (review P1-R2)
            },
            // Flush one chunk of the backlog, fairly interleaved with the
            // branches above (select! picks randomly among ready branches).
            _ = std::future::ready(()), if !pending.is_empty() => {
                let take = pending.len().min(WRITE_CHUNK);
                if channel.data(&pending[..take]).await.is_err() {
                    break;
                }
                pending.drain(..take);
            }
        }
    }
    Ok(())
}

/// Non-TTY **exec** channel (R0). Runs `command` on the already-open session
/// channel and relays its streams onto the shared pipeline:
/// - **stdout** (`ChannelMsg::Data`) → `shared.emit` — the same `terminal-output`
///   byte contract as local PTYs and the interactive shell, so existing
///   consumers render it unchanged;
/// - **stderr** (`ChannelMsg::ExtendedData`, `ext == 1`) → [`ExecEvent::Stderr`],
///   kept separate for structured consumers (R1+ stream-json), with back-pressure
///   (bounded queue, blocking send — review F1);
/// - **exit status / signal** → captured and delivered as a terminal
///   [`ExecEvent::Exit`]; a rejected/failed exec yields [`ExecEvent::Error`] —
///   either way the consumer always receives exactly one terminal event (F4).
///
/// No PTY is requested (non-TTY). stdin is wired (input → `channel.data`) and can
/// be half-closed via `close_stdin_rx` so a stdin-reading command (`cat`) can
/// finish (F2). The shell resize path does not apply here.
///
/// Ordering (review F2/F3/F4):
/// - `Ready` is emitted only after the server **accepts** the exec (`Success`) —
///   `exec()` merely queues the request in russh 0.54, so signalling earlier would
///   report a not-yet-running (or about-to-be-rejected) command as ready;
/// - a server `Eof` closes only the data direction; the exit-status/signal may
///   still arrive **before** `Close`, so we keep draining past `Eof` and break
///   only on `Close`/end-of-stream.
async fn run_exec(
    channel: russh::Channel<client::Msg>,
    command: &str,
    shared: &Arc<Shared>,
    status_tx: &mpsc::UnboundedSender<SshStatus>,
    exec_tx: &mpsc::Sender<ExecEvent>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    mut close_stdin_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    // want_reply=true so a server that rejects the exec surfaces as
    // `ChannelMsg::Failure` we can act on (mirrors the pty/shell rationale).
    // NOTE: `exec()` only *queues* the request (russh 0.54); acceptance arrives
    // later as `ChannelMsg::Success`, so we do NOT signal `Ready` here (F4).
    if channel.exec(true, command.as_bytes().to_vec()).await.is_err() {
        let msg = "failed to start remote command".to_string();
        // Transmission failure is still a terminal outcome for the consumer (F4).
        let _ = exec_tx.send(ExecEvent::Error(msg.clone())).await;
        return Err(msg);
    }

    let mut channel = channel;
    // Same outbound back-pressure discipline as the shell loop (one WRITE_CHUNK
    // per turn); input feeds the remote command's stdin.
    let mut pending: Vec<u8> = Vec::new();
    let mut exit_code: Option<u32> = None;
    let mut exit_signal: Option<String> = None;
    let mut started = false; // exec accepted (Success seen) -> Ready emitted once
    let mut stdout_done = false; // server sent Eof: no more stdout, stop stdin too
    let mut close_requested = false; // caller asked to half-close stdin
    let mut eof_sent = false; // channel.eof() already delivered
    loop {
        // Once the caller half-closed stdin, flush everything still queued (the
        // caller enqueues all input *before* signalling close, so a non-blocking
        // drain captures it) and send channel EOF so a stdin-reading command can
        // finish (F2). Done inline so the flush is guaranteed to precede EOF.
        if close_requested && !eof_sent {
            while let Ok(more) = input_rx.try_recv() {
                pending.extend_from_slice(&more);
            }
            let mut off = 0;
            while off < pending.len() {
                let end = (off + WRITE_CHUNK).min(pending.len());
                if channel.data(&pending[off..end]).await.is_err() {
                    break;
                }
                off = end;
            }
            pending.clear();
            let _ = channel.eof().await;
            eof_sent = true;
        }
        tokio::select! {
            msg = channel.wait() => match msg {
                // stdout — shared byte pipeline (unchanged output contract).
                Some(ChannelMsg::Data { ref data }) => shared.emit(data),
                // Extended data: ext==1 is stderr (SSH_EXTENDED_DATA_STDERR) — kept
                // separate. Any other (unknown) extended type folds into stdout so
                // nothing is silently dropped. The bounded, blocking send is the
                // back-pressure: if the consumer stalls, this await stalls the read
                // loop and the remote is throttled (F1). A dropped receiver ends
                // the send (ignored — nobody is consuming).
                Some(ChannelMsg::ExtendedData { ref data, ext }) => {
                    if ext == 1 {
                        let _ = exec_tx.send(ExecEvent::Stderr(data.to_vec())).await;
                    } else {
                        shared.emit(data);
                    }
                }
                // exec accepted: only now is the command actually running (F4).
                Some(ChannelMsg::Success) => {
                    if !started {
                        started = true;
                        let _ = status_tx.send(SshStatus::Ready);
                    }
                }
                // The server rejected the exec request — deliver a terminal Error
                // so the consumer always sees a terminating event (F4), never a
                // silent early return.
                Some(ChannelMsg::Failure) => {
                    let msg = "server rejected the exec request".to_string();
                    let _ = exec_tx.send(ExecEvent::Error(msg.clone())).await;
                    return Err(msg);
                }
                // Capture terminal disposition. These may arrive AFTER Eof and
                // before Close, so we record and keep draining (F3).
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(ChannelMsg::ExitSignal { ref signal_name, .. }) => {
                    exit_signal = Some(sig_name(signal_name));
                }
                // Eof closes only the data direction — NOT the channel. The
                // exit-status/signal can still be in flight before Close, so we
                // stop stdin (no more output to react to) but keep draining (F3).
                Some(ChannelMsg::Eof) => stdout_done = true,
                // Channel fully closed / stream ended — done.
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            inp = input_rx.recv(), if pending.is_empty() && !close_requested && !stdout_done => match inp {
                Some(bytes) => pending = bytes,
                None => break, // all input senders dropped (teardown)
            },
            changed = close_stdin_rx.changed(), if !close_requested => match changed {
                // Caller requested a stdin half-close; the flush+EOF happens at the
                // top of the next loop turn.
                Ok(()) => {
                    if *close_stdin_rx.borrow() {
                        close_requested = true;
                    }
                }
                Err(_) => break, // SshHandle dropped -> teardown
            },
            _ = std::future::ready(()), if !pending.is_empty() && !close_requested && !stdout_done => {
                let take = pending.len().min(WRITE_CHUNK);
                if channel.data(&pending[..take]).await.is_err() {
                    break;
                }
                pending.drain(..take);
            }
        }
    }
    // Always deliver a terminal Exit event so a consumer can distinguish clean
    // exit, non-zero exit, and signal death (None/None = ended without a status).
    let _ = exec_tx
        .send(ExecEvent::Exit {
            code: exit_code,
            signal: exit_signal,
        })
        .await;
    Ok(())
}

/// Canonical short name for a terminating signal. russh's `Sig::name()` accessor
/// is private, so we match the variants ourselves and map the standard signals to
/// their canonical names (`TERM`, `KILL`, …); a server-specific `Custom` keeps its
/// raw string. Keeps the exec `Exit` event stable for a structured consumer (R1
/// stream-json) instead of leaking Rust's `Debug` form, e.g. `Custom("FOO")`
/// (review F5).
fn sig_name(sig: &russh::Sig) -> String {
    use russh::Sig;
    match sig {
        Sig::ABRT => "ABRT".into(),
        Sig::ALRM => "ALRM".into(),
        Sig::FPE => "FPE".into(),
        Sig::HUP => "HUP".into(),
        Sig::ILL => "ILL".into(),
        Sig::INT => "INT".into(),
        Sig::KILL => "KILL".into(),
        Sig::PIPE => "PIPE".into(),
        Sig::QUIT => "QUIT".into(),
        Sig::SEGV => "SEGV".into(),
        Sig::TERM => "TERM".into(),
        Sig::USR1 => "USR1".into(),
        Sig::Custom(name) => name.clone(),
    }
}

/// Run the configured auth method, mapping failures to distinct user-safe
/// reasons (review F10).
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    config: &SshConfig,
) -> Result<(), String> {
    let user = config.username.as_str();
    let result = match &config.auth {
        AuthMethod::Password(pw) => handle
            .authenticate_password(user, pw.as_str())
            .await
            .map_err(|_| "authentication error".to_string())?,
        AuthMethod::PublicKey { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref())
                .map_err(|_| "could not load private key (wrong path or passphrase)".to_string())?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|_| "authentication error".to_string())?
                .flatten();
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|_| "authentication error".to_string())?
        }
        AuthMethod::Agent => return authenticate_agent(handle, config).await,
    };
    if result.success() {
        Ok(())
    } else {
        Err("authentication failed (server rejected the credentials)".into())
    }
}

/// Try each identity offered by ssh-agent in turn. Distinguishes "no agent",
/// "no identities", and "all rejected" (review F10). Note: many identities can
/// trip the server's MaxAuthTries — a known limitation surfaced as a reject.
async fn authenticate_agent(
    handle: &mut client::Handle<ClientHandler>,
    config: &SshConfig,
) -> Result<(), String> {
    use russh::keys::agent::client::AgentClient;
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|_| "ssh-agent is not available".to_string())?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| "could not read ssh-agent identities".to_string())?;
    if identities.is_empty() {
        return Err("ssh-agent has no identities loaded".into());
    }
    let user = config.username.as_str();
    for key in identities {
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten();
        let result = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            .map_err(|_| "ssh-agent authentication error".to_string())?;
        if result.success() {
            return Ok(());
        }
    }
    Err("ssh-agent authentication failed (no identity accepted)".into())
}

/// Map a connect-phase error to a user-safe reason. A host-key rejection (our
/// handler returning `Ok(false)`) surfaces here as a generic connect failure;
/// the distinct reject reason is conveyed by the absence of a `Ready` plus the
/// host-key prompt flow.
fn map_connect_error(_e: russh::Error) -> String {
    "could not connect to the host (check address/port, host key, or network)".to_string()
}

/// russh client handler. The only behavior we add is host-key verification
/// against an **app-private** known_hosts file (the global ~/.ssh/known_hosts is
/// never touched — review F7).
struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    prompt_tx: mpsc::UnboundedSender<HostKeyChallenge>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts_path(&self.host, self.port, server_public_key, &self.known_hosts_path)
        {
            // Known and matching — trust.
            Ok(true) => Ok(true),
            // Key CHANGED (or unreadable) — reject. Mismatch = possible MITM; we
            // never silently trust (review F7).
            Err(_) => Ok(false),
            // Unknown host — TOFU: ask the user via the prompt channel and block
            // on their decision. If nobody is listening (sender dropped / no UI),
            // default to reject.
            Ok(false) => {
                let fingerprint = server_public_key
                    .fingerprint(ssh_key::HashAlg::Sha256)
                    .to_string();
                let (reply, answer) = oneshot::channel();
                let challenge = HostKeyChallenge {
                    host: self.host.clone(),
                    port: self.port,
                    fingerprint,
                    reply,
                };
                if self.prompt_tx.send(challenge).is_err() {
                    return Ok(false);
                }
                match answer.await {
                    Ok(HostKeyDecision::Accept) => {
                        // Persist the trust. If we can't, do NOT proceed as
                        // trusted — the next connect would re-prompt, so failing
                        // closed is the honest behavior (review F7).
                        match learn_known_hosts_path(
                            &self.host,
                            self.port,
                            server_public_key,
                            &self.known_hosts_path,
                        ) {
                            Ok(()) => Ok(true),
                            Err(_) => Ok(false),
                        }
                    }
                    // Reject, or the decision channel was dropped (e.g. the session
                    // was cancelled while prompting — review C2).
                    _ => Ok(false),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionManager;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static N: AtomicU64 = AtomicU64::new(0);

    fn temp_known_hosts(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("mt_ssh_kh_{tag}_{}_{n}", std::process::id()))
    }

    fn wait_until(timeout_ms: u64, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        f()
    }

    /// Connecting to a port with no listener must fail cleanly: the status stream
    /// reports a failure, the session is marked dead (RAII guard — C9), and
    /// `remove()` returns promptly without hanging on the runtime thread (F3).
    #[test]
    fn connect_refused_fails_and_tears_down() {
        let mgr = SessionManager::new();
        let cfg = SshConfig {
            // Port 1 has no SSH listener -> connection refused fast.
            host: "127.0.0.1".into(),
            port: 1,
            username: "nobody".into(),
            auth: AuthMethod::Password("nopass".into()),
            exec: None,
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts("refused"), 80, 24, None);

        // The status stream must surface a terminal outcome (Failed and/or Closed).
        let mut saw_terminal = false;
        let deadline = Instant::now() + Duration::from_millis(3000);
        while Instant::now() < deadline {
            match chans.status_rx.try_recv() {
                Ok(SshStatus::Failed(_)) | Ok(SshStatus::Closed) => {
                    saw_terminal = true;
                    break;
                }
                Ok(_) => {}
                Err(mpsc::error::TryRecvError::Empty) => thread::sleep(Duration::from_millis(10)),
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    saw_terminal = true;
                    break;
                }
            }
        }
        assert!(saw_terminal, "status stream should report Failed/Closed");

        // Session becomes dead, writes are rejected, and teardown is prompt.
        assert!(
            wait_until(3000, || mgr.is_alive(id) == Some(false)),
            "session should be dead after a failed connect"
        );
        assert!(mgr.write(id, b"x").is_err(), "write to dead ssh session errors");

        let start = Instant::now();
        mgr.remove(id).unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(2000),
            "remove must join the ssh thread promptly (no hang)"
        );
        assert!(mgr.is_alive(id).is_none(), "session gone after remove");
    }

    /// Unknown-id SSH-path ops never panic (transport-agnostic contract).
    #[test]
    fn unknown_ssh_session_ops_error_not_panic() {
        let mgr = SessionManager::new();
        assert!(mgr.write(424242, b"x").is_err());
        assert!(mgr.resize(424242, 80, 24).is_err());
        assert!(mgr.remove(424242).is_err());
    }

    // ---- in-process russh echo server (review F12: no external dependency) ----

    /// Fixed throwaway ed25519 host key (server side) so the test is deterministic.
    const TEST_HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
QyNTUxOQAAACBBuwFSOWYMcDc8xaLphwNGHVvApEi9mMfvlz/38RXv0QAAAJiSJFtikiRb\n\
YgAAAAtzc2gtZWQyNTUxOQAAACBBuwFSOWYMcDc8xaLphwNGHVvApEi9mMfvlz/38RXv0Q\n\
AAAEBF41GZC8GqqKv8oKO6aqO777gDMhXJeOfUZ/6kDS7DN0G7AVI5ZgxwNzzFoumHA0Yd\n\
W8CkSL2Yx++XP/fxFe/RAAAAD210LXRlc3QtaG9zdGtleQECAwQFBg==\n\
-----END OPENSSH PRIVATE KEY-----\n";

    /// Minimal server that accepts password "testpass" and echoes channel input —
    /// enough to exercise our client's connect→auth→pty→shell→output pipeline.
    #[derive(Clone)]
    struct EchoHandler;

    impl russh::server::Handler for EchoHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            if password == "testpass" {
                Ok(russh::server::Auth::Accept)
            } else {
                Ok(russh::server::Auth::reject())
            }
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            _session: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn shell_request(
            &mut self,
            channel: russh::ChannelId,
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn data(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, russh::CryptoVec::from(data))?;
            Ok(())
        }
    }

    /// End-to-end against a real (in-process) russh server: TOFU host-key accept,
    /// password auth, PTY+shell, and echoed input arriving through the shared
    /// scrollback — the full P1 transport contract, no external server.
    #[test]
    fn inprocess_password_auth_pty_echo() {
        use russh::keys::decode_secret_key;
        use russh::server::{run_stream, Config as ServerConfig};

        let host_key = decode_secret_key(TEST_HOST_KEY, None).expect("decode host key");
        let mut server_cfg = ServerConfig::default();
        server_cfg.keys = vec![host_key];
        server_cfg.auth_rejection_time = Duration::from_millis(100);
        let server_cfg = Arc::new(server_cfg);

        // Bind synchronously to learn the port, then hand the socket to the server
        // thread's runtime (avoids cross-runtime listener registration).
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        std_listener.set_nonblocking(true).unwrap();

        let server = thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
                if let Ok((stream, _)) = listener.accept().await {
                    if let Ok(running) = run_stream(server_cfg, stream, EchoHandler).await {
                        let _ = running.await; // drive the session until it closes
                    }
                }
            });
        });

        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: None,
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts("echo"), 80, 24, None);

        // Accept the first-seen host key (TOFU) and wait for Ready.
        let mut ready = false;
        let deadline = Instant::now() + Duration::from_millis(8000);
        while Instant::now() < deadline && !ready {
            if let Ok(ch) = chans.prompt_rx.try_recv() {
                let _ = ch.reply.send(HostKeyDecision::Accept);
            }
            match chans.status_rx.try_recv() {
                Ok(SshStatus::Ready) => ready = true,
                Ok(SshStatus::Failed(r)) => panic!("ssh connect failed: {r}"),
                _ => {}
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(ready, "ssh session never became ready");

        // Input is echoed by the server -> must surface in the shared scrollback.
        mgr.write(id, b"marker-xyz\n").unwrap();
        assert!(
            wait_until(4000, || {
                let (buf, _) = mgr.snapshot(id).unwrap();
                buf.windows(10).any(|w| w == b"marker-xyz")
            }),
            "echoed input should appear in the ssh scrollback"
        );

        mgr.remove(id).unwrap();
        let _ = server.join();
    }

    // ---- in-process exec-channel server (R0) ----

    /// Bind a throwaway russh server (fixed host key, password "testpass") that
    /// serves exactly one connection with `handler`, returning the bound port.
    /// Mirrors the echo test's bind→hand-off dance (avoids cross-runtime listener
    /// registration).
    fn serve_once<H>(handler: H) -> u16
    where
        H: russh::server::Handler + Send + 'static,
    {
        use russh::keys::decode_secret_key;
        use russh::server::{run_stream, Config as ServerConfig};

        let host_key = decode_secret_key(TEST_HOST_KEY, None).expect("decode host key");
        let mut server_cfg = ServerConfig::default();
        server_cfg.keys = vec![host_key];
        server_cfg.auth_rejection_time = Duration::from_millis(100);
        let server_cfg = Arc::new(server_cfg);

        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = std_listener.local_addr().unwrap().port();
        std_listener.set_nonblocking(true).unwrap();

        thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
                if let Ok((stream, _)) = listener.accept().await {
                    if let Ok(running) = run_stream(server_cfg, stream, handler).await {
                        let _ = running.await;
                    }
                }
            });
        });
        port
    }

    /// Server that, on any exec request, writes a stdout line, a stderr line
    /// (extended data, ext=1), then reports an exit status derived from the
    /// command (containing "fail" -> 3, else 0), and closes. Enough to exercise
    /// the client's stdout/stderr split and exit-code recovery with no external
    /// server.
    #[derive(Clone)]
    struct ExecHandler;

    impl russh::server::Handler for ExecHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            if password == "testpass" {
                Ok(russh::server::Auth::Accept)
            } else {
                Ok(russh::server::Auth::reject())
            }
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            _session: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            // Acknowledge the exec (want_reply=true on the client).
            session.channel_success(channel)?;
            let cmd = String::from_utf8_lossy(data);
            session.data(channel, russh::CryptoVec::from(&b"OUT:hello\n"[..]))?;
            // ext=1 == SSH_EXTENDED_DATA_STDERR.
            session.extended_data(channel, 1, russh::CryptoVec::from(&b"ERR:oops\n"[..]))?;
            let code: u32 = if cmd.contains("fail") { 3 } else { 0 };
            session.exit_status_request(channel, code)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    /// Outcome collected from driving an exec session end-to-end.
    #[derive(Default)]
    struct ExecOutcome {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        /// The terminal `Exit` event (code, signal), if that's how it ended.
        exit: Option<(Option<u32>, Option<String>)>,
        /// The terminal `Error` event message, if the exec failed/was rejected.
        error: Option<String>,
        /// Whether the session ever reported `Ready` (exec accepted).
        ready: bool,
        /// A `Failed` status reason, if the status stream surfaced one.
        failed: Option<String>,
    }

    /// Connect an exec session to `handler`, auto-accepting the host key, and pump
    /// status + exec events until a **terminal** exec event (`Exit` or `Error`) or
    /// timeout. `on_ready` runs exactly once, right after the session reports
    /// `Ready` — used to write stdin and half-close it. Generic over the server
    /// handler so each test can vary server behavior (EOF ordering, rejection, …).
    fn drive_exec<H, F>(handler: H, command: &str, tag: &str, on_ready: F) -> ExecOutcome
    where
        H: russh::server::Handler + Send + 'static,
        F: FnOnce(&SessionManager, crate::session::SessionId),
    {
        let port = serve_once(handler);
        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: Some(command.into()),
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts(tag), 80, 24, None);

        let mut out = ExecOutcome::default();
        let mut on_ready = Some(on_ready);
        let mut terminal = false;
        let deadline = Instant::now() + Duration::from_millis(8000);
        while Instant::now() < deadline && !terminal {
            // Accept the first-seen host key (TOFU).
            if let Ok(ch) = chans.prompt_rx.try_recv() {
                let _ = ch.reply.send(HostKeyDecision::Accept);
            }
            match chans.status_rx.try_recv() {
                Ok(SshStatus::Ready) => {
                    out.ready = true;
                    if let Some(f) = on_ready.take() {
                        f(&mgr, id);
                    }
                }
                Ok(SshStatus::Failed(r)) => out.failed = Some(r),
                _ => {}
            }
            match chans.exec_rx.try_recv() {
                Ok(ExecEvent::Stderr(b)) => out.stderr.extend_from_slice(&b),
                Ok(ExecEvent::Exit { code, signal }) => {
                    out.exit = Some((code, signal));
                    terminal = true;
                }
                Ok(ExecEvent::Error(e)) => {
                    out.error = Some(e);
                    terminal = true;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => break,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            thread::sleep(Duration::from_millis(5));
        }
        out.stdout = mgr.snapshot(id).map(|(b, _)| b).unwrap_or_default();
        let _ = mgr.remove(id);
        out
    }

    /// Exec channel: stdout rides the shared scrollback, stderr comes through the
    /// separate `ExecEvent::Stderr` (never polluting stdout), and a clean exit
    /// status is recovered.
    #[test]
    fn inprocess_exec_splits_stdout_stderr_and_recovers_exit() {
        let out = drive_exec(ExecHandler, "run-ok", "exec_ok", |_, _| {});
        assert!(
            out.stdout.windows(9).any(|w| w == b"OUT:hello"),
            "stdout must ride the shared scrollback, got: {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            out.stderr.windows(8).any(|w| w == b"ERR:oops"),
            "stderr must arrive on the exec channel"
        );
        assert!(
            !out.stdout.windows(8).any(|w| w == b"ERR:oops"),
            "stderr must NOT pollute the stdout scrollback (stream separation)"
        );
        assert_eq!(out.exit, Some((Some(0), None)), "clean exit status recovered");
    }

    /// A non-zero exit status is recovered verbatim (abnormal termination).
    #[test]
    fn inprocess_exec_recovers_nonzero_exit() {
        let out = drive_exec(ExecHandler, "run-fail", "exec_fail", |_, _| {});
        assert_eq!(out.exit, Some((Some(3), None)), "non-zero exit status recovered");
    }

}
