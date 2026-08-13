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
//!
//! Three session shapes share all of the above and differ only in what the
//! channel is: the interactive **pty + shell** ([`SshConfig::exec`] = `None`),
//! an **output-only exec** ([`ExecStdin::Eof`]), and a **duplex exec**
//! ([`ExecStdin::Stream`]). The last one is the only place in this file where
//! reads and writes race, and it is deliberately built out of
//! [`russh::Channel::split`] halves under one `join!` rather than one `select!`
//! — see [`ExecStdin::Stream`] for the measurement behind that.

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
    /// interactive **pty + shell** path byte-for-byte. `Some(spec)` opens a
    /// **non-TTY exec channel** running `spec.command`: stdout flows through the
    /// shared `terminal-output` pipeline (`Shared::emit`), stderr and the exit
    /// status are surfaced separately over [`ExecEvent`]. This carries a generic
    /// command — remote claude/codex argv·env·cwd wiring belongs to the caller.
    pub exec: Option<ExecSpec>,
}

/// A remote command to run on an exec channel, and what its **stdin** carries.
///
/// The two live in one type on purpose: an stdin mode without a command is not a
/// state this transport can be in, and a second field would let a caller set one
/// and forget the other.
pub struct ExecSpec {
    pub command: String,
    pub stdin: ExecStdin,
}

impl ExecSpec {
    /// R0's shape: run `command`, never send it a byte (see [`ExecStdin::Eof`]).
    pub fn output_only(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            stdin: ExecStdin::Eof,
        }
    }

    /// R2b's shape: run `command` and stream this session's input to it (see
    /// [`ExecStdin::Stream`]).
    pub fn duplex(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            stdin: ExecStdin::Stream,
        }
    }
}

/// What the write direction of an exec channel carries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExecStdin {
    /// **Output-only** (R0). The write direction is half-closed (**EOF**) the
    /// moment the exec is accepted, so a command that reads stdin sees
    /// end-of-input and exits instead of waiting forever. No data is ever
    /// written, so the send window is never consulted and the write-window
    /// deadlock class cannot arise on this setting at all.
    Eof,
    /// **Full duplex** (R2b). Bytes handed to [`SshHandle::send_input`] are
    /// streamed to the remote command's stdin, and EOF follows when the input
    /// side closes.
    ///
    /// The read and write directions are driven as **two futures over
    /// [`russh::Channel::split`] halves**, never as two branches of one
    /// `select!`. That distinction is the whole reason R0 shipped without stdin:
    /// a `select!` whose branch body awaits `channel.data(..)` stops polling the
    /// read branch for the duration of that await; the channel's receive queue
    /// then fills, which parks russh's connection loop, which is the only thing
    /// that could deliver the `WINDOW_ADJUST` the write is waiting for. Measured
    /// (2026-08-13, russh 0.54.5, 3 MB in against a 6.4 MB flood out): the
    /// `select!` shape wedged **5/5** rounds on the 20 s deadline, the split
    /// shape completed **35/35** in ~200 ms. The regression test
    /// `an_exec_that_is_flooded_while_it_floods_does_not_wedge` holds this.
    Stream,
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
    /// request, or the request could not be sent. This is a terminal event too.
    ///
    /// **Contract (review F4), scoped:** *once the exec request has been sent*,
    /// a consumer receives exactly one of `Exit` / `Error`, never a silent end.
    /// The scope matters for a state machine built on top (R1): a session that
    /// dies **before** the exec is requested — connect / auth / host-key
    /// rejection / `channel_open` failure, or a cancel-teardown at any point —
    /// emits **zero** `ExecEvent`s. There the consumer's signal is `exec_rx`
    /// closing (all senders dropped) together with [`SshStatus::Failed`] /
    /// [`SshStatus::Closed`] — so "no terminal event" must be treated as a
    /// legitimate end state, not as a still-running command.
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
    ///
    /// **Hold it only if you drain it.** Because the queue is bounded and the
    /// send side blocks, a receiver that is kept alive but never polled stalls the
    /// exec read loop entirely — including **stdout**, which rides `Shared::emit`
    /// and would otherwise look unrelated. On an [`ExecStdin::Stream`] session it
    /// stalls the **input** direction too, for the same reason the split exists:
    /// the write parks on a send window that only the (now stalled) reader could
    /// reopen. Either consume it or drop it; the current `src-tauri` shell path
    /// drops it immediately, which is why an unsubscribed session cannot stall.
    pub exec_rx: mpsc::Receiver<ExecEvent>,
}

/// Manager-held handles for a live SSH session.
pub struct SshHandle {
    input_tx: mpsc::Sender<Vec<u8>>,
    size_tx: watch::Sender<(u16, u16)>,
    cancel_tx: watch::Sender<bool>,
    join: Option<JoinHandle<()>>,
    /// `true` for an [`ExecStdin::Eof`] session, which has **no remote stdin**.
    /// Decided at handle creation so `send_input` rejects from the very first
    /// call — dropping the receiver alone would only take effect once connect,
    /// auth and channel-open finished, leaving an early window where writes were
    /// accepted and then discarded (codex final audit P2). An
    /// [`ExecStdin::Stream`] exec and the interactive shell both accept input.
    output_only: bool,
}

impl SshHandle {
    /// Enqueue input (keystrokes). Never blocks the caller (F4); on a full queue
    /// or a closed session it returns an error instead of growing memory (D2).
    pub fn send_input(&self, data: &[u8]) -> Result<(), String> {
        use mpsc::error::TrySendError;
        if self.output_only {
            return Err("exec session has no stdin (output-only)".into());
        }
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
    // Read before `config` moves into the session thread: an output-only exec
    // takes no input, and the handle must know that from its first moment.
    let output_only = matches!(&config.exec, Some(spec) if spec.stdin == ExecStdin::Eof);
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
    let (size_tx, size_rx) = watch::channel((cols.max(1), rows.max(1)));
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (prompt_tx, prompt_rx) = mpsc::unbounded_channel::<HostKeyChallenge>();
    let (status_tx, status_rx) = mpsc::unbounded_channel::<SshStatus>();
    // Bounded so stderr can't accumulate without limit (review F1).
    let (exec_tx, exec_rx) = mpsc::channel::<ExecEvent>(EXEC_EVENT_QUEUE);

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
                res = run(&config, &shared, &known_hosts_path, &prompt_tx, &status_tx, &exec_tx, input_rx, size_rx) => {
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
            join: Some(join),
            output_only,
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

    // Exec seam: a `Some(spec)` config runs a non-TTY remote command on a
    // separate code path and returns here, so the interactive pty+shell block
    // below stays untouched (regression 0). `None` falls through to the shell.
    if let Some(spec) = &config.exec {
        let input_rx = match spec.stdin {
            // Drop the receiver *before* running, so `SessionManager::write()` on
            // an output-only exec fails immediately (closed channel) instead of
            // silently buffering up to the channel capacity and reporting `Ok` —
            // a caller would otherwise believe input reached the remote (codex
            // audit P2).
            ExecStdin::Eof => {
                drop(input_rx);
                None
            }
            ExecStdin::Stream => Some(input_rx),
        };
        return run_exec(channel, spec, shared, status_tx, exec_tx, input_rx).await;
    }

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
///   either way, **once the exec request has been sent**, the consumer receives
///   exactly one terminal event (F4). Before that point (connect/auth/host-key/
///   `channel_open` failure, or cancellation) this function is never reached and
///   *no* `ExecEvent` is produced at all — the consumer learns of the outcome
///   from `exec_rx` closing plus [`SshStatus::Failed`]/[`SshStatus::Closed`].
///
/// No PTY is requested (non-TTY). What the write direction carries is
/// [`ExecSpec::stdin`]:
/// - [`ExecStdin::Eof`] — "no stdin" is signalled *explicitly* as EOF as soon as
///   the exec is accepted, so a command that reads stdin (`cat`, anything waiting
///   on end-of-input) exits instead of blocking forever. Blocking forever would
///   mean `wait()` never yields a status, silently breaking the "exactly one
///   terminal event" contract while the thread and TCP connection stay pinned.
/// - [`ExecStdin::Stream`] — `input_rx` is drained onto the channel, then EOF.
///
/// **Structure (the deadlock class):** the channel is [`russh::Channel::split`]
/// into halves and driven by **two futures under one `join!`**. This is not a
/// stylistic choice. Writing is what parks: `data()` goes through
/// `ChannelTx::poll_write` (russh 0.54.5 `channels/io/tx.rs:78-106`), which waits
/// on a `WINDOW_ADJUST` that only russh's connection loop can deliver — and that
/// loop parks as soon as this channel's receive queue fills (capacity
/// `channel_buffer_size` = 100, `client/mod.rs:1691`). So a write that stops the
/// reads deadlocks itself. Two branches of one `select!` do exactly that, because
/// an `.await` inside a branch body suspends the whole `select!`; two futures
/// under `join!` do not, because `join!` polls the reader again on every wake.
/// `eof()` is exempt either way — it is `send_msg` (`channels/mod.rs:347`), a
/// control message that never consults `window_size`.
///
/// Ordering (review F3/F4):
/// - `Ready` is emitted only after the server **accepts** the exec (`Success`) —
///   `exec()` merely queues the request in russh 0.54, so signalling earlier would
///   report a not-yet-running (or about-to-be-rejected) command as ready;
/// - a server `Eof` closes only the data direction; the exit-status/signal may
///   still arrive **before** `Close`, so we keep draining past `Eof` and break
///   only on `Close`/end-of-stream.
async fn run_exec(
    channel: russh::Channel<client::Msg>,
    spec: &ExecSpec,
    shared: &Arc<Shared>,
    status_tx: &mpsc::UnboundedSender<SshStatus>,
    exec_tx: &mpsc::Sender<ExecEvent>,
    input_rx: Option<mpsc::Receiver<Vec<u8>>>,
) -> Result<(), String> {
    let (mut read, write) = channel.split();

    // want_reply=true so a server that rejects the exec surfaces as
    // `ChannelMsg::Failure` we can act on (mirrors the pty/shell rationale).
    // NOTE: `exec()` only *queues* the request (russh 0.54); acceptance arrives
    // later as `ChannelMsg::Success`, so we do NOT signal `Ready` here (F4).
    if write
        .exec(true, spec.command.as_bytes().to_vec())
        .await
        .is_err()
    {
        let msg = "failed to start remote command".to_string();
        // Transmission failure is still a terminal outcome for the consumer (F4).
        let _ = exec_tx.send(ExecEvent::Error(msg.clone())).await;
        return Err(msg);
    }

    // reader -> writer: the server accepted the exec (nothing may be written
    // before that, and on a rejection nothing is written at all).
    let (start_tx, start_rx) = oneshot::channel::<()>();
    // reader -> writer: the channel is finished. Without this the writer would
    // sit on `recv()` (or on a send window that will never open again) after the
    // remote is gone, and `join!` below would never complete.
    let (done_tx, done_rx) = watch::channel(false);

    let reader = async {
        let mut exit_code: Option<u32> = None;
        let mut exit_signal: Option<String> = None;
        let mut rejected = false;
        let mut start_tx = Some(start_tx);
        // Single await source: this future only ever reads.
        loop {
            match read.wait().await {
                // stdout — shared byte pipeline (unchanged output contract).
                Some(ChannelMsg::Data { ref data }) => shared.emit(data),
                // Extended data: ext==1 is stderr (SSH_EXTENDED_DATA_STDERR) —
                // kept separate. Any other (unknown) extended type folds into
                // stdout so nothing is silently dropped. The bounded, blocking
                // send is the back-pressure: if the consumer stalls, this await
                // stalls the read loop and the remote is throttled (F1). A
                // dropped receiver ends the send (ignored — nobody is consuming).
                Some(ChannelMsg::ExtendedData { ref data, ext }) => {
                    if ext == 1 {
                        let _ = exec_tx.send(ExecEvent::Stderr(data.to_vec())).await;
                    } else {
                        shared.emit(data);
                    }
                }
                // exec accepted: only now is the command actually running (F4),
                // and only now may anything be written to it.
                Some(ChannelMsg::Success) => {
                    if let Some(tx) = start_tx.take() {
                        let _ = tx.send(());
                        let _ = status_tx.send(SshStatus::Ready);
                    }
                }
                // The server rejected the exec request. Reported as a terminal
                // Error below (F4) — never a silent end.
                Some(ChannelMsg::Failure) => {
                    rejected = true;
                    break;
                }
                // Capture terminal disposition. These may arrive AFTER Eof and
                // before Close, so we record and keep draining (F3).
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(ChannelMsg::ExitSignal { ref signal_name, .. }) => {
                    exit_signal = Some(sig_name(signal_name));
                }
                // Eof closes only the data direction — NOT the channel. The
                // exit-status/signal can still be in flight before Close, so we
                // keep draining (F3).
                Some(ChannelMsg::Eof) => {}
                // Channel fully closed / stream ended — done.
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        // Release the writer however this ended (accepted, rejected, or gone).
        let _ = done_tx.send(true);
        (rejected, exit_code, exit_signal)
    };

    let writer = async move {
        let mut done_rx = done_rx;
        // Nothing may be written before the server accepts the exec. If the
        // channel ends first (rejection, teardown), there is nothing to write.
        tokio::select! {
            accepted = start_rx => {
                if accepted.is_err() {
                    return;
                }
            }
            _ = done_rx.changed() => return,
        }
        let Some(mut input_rx) = input_rx else {
            // Output-only: say "no stdin" as EOF, not as silence.
            let _ = write.eof().await;
            return;
        };
        loop {
            let msg = tokio::select! {
                m = input_rx.recv() => m,
                _ = done_rx.changed() => return,
            };
            // `None` = every sender dropped, i.e. the session is going away.
            let Some(bytes) = msg else { break };
            // This is the await that parks on the send window. It is safe here
            // only because `reader` above is a *separate* future that keeps
            // draining the channel while this one waits (see the fn docs).
            let sent = tokio::select! {
                r = write.data(&bytes[..]) => r.is_ok(),
                _ = done_rx.changed() => return,
            };
            if !sent {
                return;
            }
        }
        let _ = write.eof().await;
    };

    let ((rejected, exit_code, exit_signal), ()) = tokio::join!(reader, writer);

    if rejected {
        let msg = "server rejected the exec request".to_string();
        let _ = exec_tx.send(ExecEvent::Error(msg.clone())).await;
        return Err(msg);
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
        serve_once_with_window(handler, None)
    }

    /// As [`serve_once`], but able to advertise a **small receive window**.
    ///
    /// A window this side of a megabyte is what makes the duplex test mean
    /// something: with russh's 2 MB default the client's writes almost never park
    /// on the send window, and a test that never reaches the parked state cannot
    /// tell a deadlock-free design from a lucky one. Measured with the real
    /// prototype: at the default window the single-`select!` shape (the one this
    /// module deliberately does *not* use) passed 6/6; at 64 KB it wedged 5/5.
    fn serve_once_with_window<H>(handler: H, window_size: Option<u32>) -> u16
    where
        H: russh::server::Handler + Send + 'static,
    {
        use russh::keys::decode_secret_key;
        use russh::server::{run_stream, Config as ServerConfig};

        let host_key = decode_secret_key(TEST_HOST_KEY, None).expect("decode host key");
        let mut server_cfg = ServerConfig::default();
        server_cfg.keys = vec![host_key];
        server_cfg.auth_rejection_time = Duration::from_millis(100);
        if let Some(w) = window_size {
            server_cfg.window_size = w;
        }
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
    /// `Ready` — a post-ready hook (R0's exec path is output-only, so the kept
    /// tests pass a no-op). Generic over the server handler so each test can vary
    /// server behavior (EOF ordering, rejection, …).
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
            exec: Some(ExecSpec::output_only(command)),
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

    /// A command that produces **no output** at all must still deliver a terminal
    /// Exit (the seam never hangs waiting for bytes that never come).
    #[derive(Clone)]
    struct ExecNoOutputHandler;
    impl russh::server::Handler for ExecNoOutputHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            // No stdout, no stderr — just exit 0 and close.
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_no_output_still_terminates() {
        let out = drive_exec(ExecNoOutputHandler, "silent", "exec_silent", |_, _| {});
        assert!(out.ready, "exec accepted -> Ready");
        assert!(out.stderr.is_empty(), "no stderr for a silent command");
        assert_eq!(out.exit, Some((Some(0), None)), "silent command still yields a terminal Exit");
    }

    /// R0's exec path is **output-only**, so writing to an exec session must fail
    /// *immediately* rather than buffering silently and reporting `Ok` — a caller
    /// that got `Ok` would believe the bytes reached the remote (codex audit P2).
    /// Remote stdin arrives in R1 via channel halves / a writer task.
    ///
    /// The flood handler makes this decisive: it queues more stderr than
    /// `EXEC_EVENT_QUEUE`, so the sender is still blocked on back-pressure when
    /// `on_ready` runs. The session is therefore provably **alive** at the moment
    /// we write — without that, a write could error merely because the command had
    /// already finished, and the test would pass with or without the fix.
    /// The rejection must hold from the handle's *first moment* — before connect,
    /// auth or the host-key answer. Dropping the input receiver alone only takes
    /// effect once channel-open finishes, so writes in that early window were
    /// accepted and silently discarded (codex final audit P2). No server is even
    /// needed: an unreachable port keeps the session in connect while we write.
    #[test]
    fn exec_session_rejects_write_before_ready() {
        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port: 1, // nothing listens — the session stays in connect/auth
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: Some(ExecSpec::output_only("irrelevant")),
        };
        let (id, _chans) = mgr.create_ssh(cfg, temp_known_hosts("exec_early_write"), 80, 24, None);
        // Immediately, with no status observed yet.
        assert!(mgr.write(id, b"x").is_err(), "exec session rejects stdin before Ready too");
        let _ = mgr.remove(id);
    }

    #[test]
    fn inprocess_exec_session_rejects_write() {
        let handler = ExecStderrFloodHandler { chunks: EXEC_EVENT_QUEUE + 10 };
        let out = drive_exec(handler, "flood", "exec_nowrite", |mgr, id| {
            assert_eq!(mgr.is_alive(id), Some(true), "command still streaming — session alive");
            assert!(mgr.write(id, b"x").is_err(), "write to an output-only exec session must error");
        });
        assert!(out.ready, "rejecting writes does not disturb the exec itself");
        assert_eq!(out.exit.map(|(c, _)| c), Some(Some(0)), "command still terminates normally");
    }

    /// A command that writes **only stderr** (no stdout) — stderr must arrive on
    /// the exec channel and the exit be recovered, with an empty scrollback.
    #[derive(Clone)]
    struct ExecStderrOnlyHandler;
    impl russh::server::Handler for ExecStderrOnlyHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.extended_data(channel, 1, russh::CryptoVec::from(&b"only-stderr\n"[..]))?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_stderr_only() {
        let out = drive_exec(ExecStderrOnlyHandler, "err", "exec_erronly", |_, _| {});
        assert!(
            out.stderr.windows(11).any(|w| w == b"only-stderr"),
            "stderr-only output must arrive on the exec channel"
        );
        assert!(
            !out.stdout.windows(11).any(|w| w == b"only-stderr"),
            "stderr must not leak into stdout"
        );
        assert_eq!(out.exit, Some((Some(0), None)));
    }

    /// Death by signal: no exit-status, an exit-signal instead. The signal name
    /// must be the canonical short form (F5), never a Rust `Debug` rendering.
    #[derive(Clone)]
    struct ExecSignalHandler;
    impl russh::server::Handler for ExecSignalHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            // Killed by SIGTERM: exit-signal, no exit-status.
            session.exit_signal_request(channel, russh::Sig::TERM, false, "terminated", "")?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_reports_signal_death() {
        let out = drive_exec(ExecSignalHandler, "killme", "exec_signal", |_, _| {});
        let (code, signal) = out.exit.expect("signal death still yields a terminal Exit");
        assert_eq!(code, None, "no exit-status when killed by a signal");
        assert_eq!(signal.as_deref(), Some("TERM"), "canonical signal name, not Debug form");
    }

    /// EOF arrives BEFORE the exit-status (data direction closes, then the server
    /// reports the status, then closes). This is the case a naive `break`-on-EOF
    /// loop loses (review F3). The server here deliberately orders
    /// data → eof → exit-status → close.
    #[derive(Clone)]
    struct ExecEofBeforeExitHandler;
    impl russh::server::Handler for ExecEofBeforeExitHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, russh::CryptoVec::from(&b"payload\n"[..]))?;
            // Order that breaks a break-on-EOF client: EOF first, status AFTER.
            session.eof(channel)?;
            session.exit_status_request(channel, 42)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_recovers_exit_status_sent_after_eof() {
        let out = drive_exec(ExecEofBeforeExitHandler, "eof-first", "exec_eof_first", |_, _| {});
        assert!(
            out.stdout.windows(7).any(|w| w == b"payload"),
            "stdout emitted before EOF must still be captured"
        );
        assert_eq!(
            out.exit,
            Some((Some(42), None)),
            "exit-status sent AFTER eof must be drained (not reported as None)"
        );
    }

    /// The server REJECTS the exec (channel_failure). The consumer must receive a
    /// terminal `Error`, never a silent end (review F4).
    #[derive(Clone)]
    struct ExecRejectHandler;
    impl russh::server::Handler for ExecRejectHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            // Reject the exec — the client must surface this as a terminal Error.
            session.channel_failure(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_rejection_yields_terminal_error() {
        let out = drive_exec(ExecRejectHandler, "denied", "exec_reject", |_, _| {});
        assert!(!out.ready, "a rejected exec must NOT report Ready");
        assert!(out.exit.is_none(), "a rejected exec is not a normal Exit");
        assert!(
            out.error.is_some(),
            "a rejected exec must deliver a terminal ExecEvent::Error"
        );
    }

    /// Large / bursty stderr under back-pressure: a slow consumer must still
    /// receive **every** stderr byte in order (the bounded queue blocks the sender
    /// rather than dropping), and the terminal Exit must arrive last (review F1).
    #[derive(Clone)]
    struct ExecStderrFloodHandler {
        chunks: usize,
    }
    impl russh::server::Handler for ExecStderrFloodHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            // Many stderr chunks, more than the bounded EXEC_EVENT_QUEUE, so the
            // client's sender blocks (back-pressure) while a slow consumer drains.
            for _ in 0..self.chunks {
                session.extended_data(channel, 1, russh::CryptoVec::from(&b"XXXXXXXX"[..]))?;
            }
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_stderr_backpressure_lossless() {
        // More chunks than EXEC_EVENT_QUEUE (256) so back-pressure actually engages.
        let chunks = EXEC_EVENT_QUEUE * 3;
        let port = serve_once(ExecStderrFloodHandler { chunks });
        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: Some(ExecSpec::output_only("flood")),
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts("exec_flood"), 80, 24, None);

        // Deliberately slow consumer: sleep between drains so the sender must block
        // on the bounded queue. All bytes must still arrive, in order, then Exit.
        let mut stderr_total = 0usize;
        let mut exit: Option<(Option<u32>, Option<String>)> = None;
        let deadline = Instant::now() + Duration::from_millis(15000);
        while Instant::now() < deadline && exit.is_none() {
            if let Ok(ch) = chans.prompt_rx.try_recv() {
                let _ = ch.reply.send(HostKeyDecision::Accept);
            }
            let _ = chans.status_rx.try_recv();
            match chans.exec_rx.try_recv() {
                Ok(ExecEvent::Stderr(b)) => stderr_total += b.len(),
                Ok(ExecEvent::Exit { code, signal }) => exit = Some((code, signal)),
                Ok(ExecEvent::Error(e)) => panic!("unexpected exec error: {e}"),
                Err(mpsc::error::TryRecvError::Disconnected) => break,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            // Slow drain -> forces the bounded queue full -> exercises back-pressure.
            thread::sleep(Duration::from_millis(1));
        }
        let _ = mgr.remove(id);
        assert_eq!(exit, Some((Some(0), None)), "flood still ends with a clean Exit");
        assert_eq!(
            stderr_total,
            chunks * 8,
            "every stderr byte must survive back-pressure (bounded queue blocks, never drops)"
        );
    }

    /// A remote command that **reads stdin** and only finishes on EOF (`cat`,
    /// and every streaming consumer R1 will run). The server here mirrors that:
    /// it acknowledges the exec but sends **no** exit-status until the client
    /// half-closes its write direction (`channel_eof`).
    ///
    /// Without the client's post-`Success` `channel.eof()`, remote stdin stays
    /// open forever: no exit-status is ever sent, `wait()` never returns a
    /// terminal message, and the "exactly one terminal event" contract breaks
    /// *silently* while the session thread and TCP connection stay pinned. The
    /// test then fails on the deadline with `exit == None`.
    #[derive(Clone)]
    struct ExecWaitsForStdinEofHandler;
    impl russh::server::Handler for ExecWaitsForStdinEofHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            // Running, but blocked on stdin: NO exit-status, NO eof, NO close.
            session.data(channel, russh::CryptoVec::from(&b"reading-stdin\n"[..]))?;
            Ok(())
        }
        async fn channel_eof(&mut self, channel: russh::ChannelId, session: &mut russh::server::Session) -> Result<(), Self::Error> {
            // Client half-closed its write side -> our "command" sees EOF and exits.
            session.data(channel, russh::CryptoVec::from(&b"saw-eof\n"[..]))?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_sends_stdin_eof_so_stdin_readers_terminate() {
        let out = drive_exec(ExecWaitsForStdinEofHandler, "cat", "exec_stdin_eof", |_, _| {});
        assert!(out.ready, "exec accepted -> Ready");
        assert_eq!(
            out.exit,
            Some((Some(0), None)),
            "an output-only exec must half-close stdin so an EOF-waiting command exits \
             (None here = the client never sent EOF and the command hung until the deadline)"
        );
        assert!(
            out.stdout.windows(7).any(|w| w == b"saw-eof"),
            "the remote must observe our stdin EOF, got: {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
    }

    /// **Unknown** extended-data type (anything but ext==1/stderr). The contract
    /// is "fold into stdout" — nothing is silently dropped — so the bytes must
    /// surface in the shared scrollback, and never on the stderr side channel.
    #[derive(Clone)]
    struct ExecUnknownExtHandler;
    impl russh::server::Handler for ExecUnknownExtHandler {
        type Error = russh::Error;
        async fn auth_password(&mut self, _u: &str, p: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(if p == "testpass" { russh::server::Auth::Accept } else { russh::server::Auth::reject() })
        }
        async fn channel_open_session(&mut self, _c: russh::Channel<russh::server::Msg>, _s: &mut russh::server::Session) -> Result<bool, Self::Error> {
            Ok(true)
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _data: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            // ext=2 is not SSH_EXTENDED_DATA_STDERR — an unknown stream type.
            session.extended_data(channel, 2, russh::CryptoVec::from(&b"unknown-ext-payload\n"[..]))?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    #[test]
    fn inprocess_exec_folds_unknown_ext_into_stdout() {
        let out = drive_exec(ExecUnknownExtHandler, "weird-ext", "exec_unknown_ext", |_, _| {});
        assert!(
            out.stdout.windows(19).any(|w| w == b"unknown-ext-payload"),
            "unknown extended data must fold into stdout (zero silent drops), got: {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(out.stderr.is_empty(), "unknown ext is not stderr");
        assert_eq!(out.exit, Some((Some(0), None)));
    }

    // ---- duplex exec (R2b): remote stdin ----

    /// Server for the duplex tests: on exec it starts flooding stdout, counts
    /// every byte the client sends, and only reports an exit once it has the
    /// whole expected payload. "Flooding while being flooded" is the shape that
    /// deadlocked R0, so both directions must be under pressure at once.
    #[derive(Clone)]
    struct ExecDuplexFloodHandler {
        inbound: Arc<AtomicU64>,
        expect_in: u64,
        out_chunk: usize,
        out_chunks: usize,
    }

    impl russh::server::Handler for ExecDuplexFloodHandler {
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
            _data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let handle = session.handle();
            let inbound = Arc::clone(&self.inbound);
            let (expect_in, out_chunk, out_chunks) =
                (self.expect_in, self.out_chunk, self.out_chunks);
            // Flood from a task so the server's own event loop keeps serving —
            // otherwise the server, not the client, would be the thing that stops.
            tokio::spawn(async move {
                let chunk = russh::CryptoVec::from(vec![b'o'; out_chunk]);
                for _ in 0..out_chunks {
                    if handle.data(channel, chunk.clone()).await.is_err() {
                        return;
                    }
                }
                let deadline = Instant::now() + Duration::from_secs(25);
                while inbound.load(Ordering::Relaxed) < expect_in && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let _ = handle.exit_status_request(channel, 0).await;
                let _ = handle.eof(channel).await;
                let _ = handle.close(channel).await;
            });
            Ok(())
        }

        async fn data(
            &mut self,
            _channel: russh::ChannelId,
            data: &[u8],
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.inbound.fetch_add(data.len() as u64, Ordering::Relaxed);
            Ok(())
        }
    }

    /// The R2b regression test, and the reason this module splits the channel.
    ///
    /// A remote agent floods its terminal while the user keeps typing. R0 drove
    /// both directions from one `select!`, and this exact situation wedged it:
    /// the write parks on the send window, the parked branch stops the reads, the
    /// unread channel queue parks russh's connection loop, and the `WINDOW_ADJUST`
    /// that would release the write never gets processed. Measured against the
    /// same server: `select!` 5/5 wedged, split halves 35/35 clean (~200 ms).
    ///
    /// The deadline is the assertion: a deadlock here is an `exit` of `None`
    /// after the wait, never a hung test run.
    #[test]
    fn an_exec_that_is_flooded_while_it_floods_does_not_wedge() {
        const OUT_CHUNK: usize = 32 * 1024;
        const OUT_CHUNKS: usize = 200; // 6.4 MB out
        const IN_CHUNK: usize = 8 * 1024;
        const IN_CHUNKS: usize = 384; // 3 MB in — several times the 64 KB window
        let expect_in = (IN_CHUNK * IN_CHUNKS) as u64;

        let inbound = Arc::new(AtomicU64::new(0));
        let port = serve_once_with_window(
            ExecDuplexFloodHandler {
                inbound: Arc::clone(&inbound),
                expect_in,
                out_chunk: OUT_CHUNK,
                out_chunks: OUT_CHUNKS,
            },
            Some(64 * 1024),
        );

        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: Some(ExecSpec::duplex("flood")),
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts("exec_duplex"), 80, 24, None);

        let mut ready = false;
        let mut exit: Option<(Option<u32>, Option<String>)> = None;
        let mut sent = 0usize;
        let payload = vec![b'i'; IN_CHUNK];
        let deadline = Instant::now() + Duration::from_millis(20_000);
        while Instant::now() < deadline && exit.is_none() {
            if let Ok(ch) = chans.prompt_rx.try_recv() {
                let _ = ch.reply.send(HostKeyDecision::Accept);
            }
            if let Ok(SshStatus::Ready) = chans.status_rx.try_recv() {
                ready = true;
            }
            // Keep typing into the flood. A full queue is back-pressure, not
            // loss: retry on the next turn rather than dropping the bytes.
            while ready && sent < IN_CHUNKS && mgr.write(id, &payload).is_ok() {
                sent += 1;
            }
            match chans.exec_rx.try_recv() {
                Ok(ExecEvent::Exit { code, signal }) => exit = Some((code, signal)),
                Ok(ExecEvent::Error(e)) => panic!("exec failed: {e}"),
                Ok(_) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => break,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            thread::sleep(Duration::from_millis(2));
        }

        let stdout = mgr.snapshot(id).map(|(b, _)| b).unwrap_or_default();
        let got_in = inbound.load(Ordering::Relaxed);
        let _ = mgr.remove(id);

        assert_eq!(sent, IN_CHUNKS, "the whole payload must be handed over");
        assert_eq!(
            exit,
            Some((Some(0), None)),
            "no terminal event within the deadline = the write direction wedged \
             (input delivered so far: {got_in}/{expect_in})"
        );
        assert_eq!(got_in, expect_in, "every byte typed must reach the remote");
        // The scrollback is a bounded ring, so the flood is measured by it being
        // full, not by its total (6.4 MB does not fit in 1 MB).
        assert_eq!(
            stdout.len(),
            crate::session::DEFAULT_SCROLLBACK_CAP,
            "the flood must still have reached the scrollback while input flowed"
        );
    }

    /// Server that echoes stdin back on stdout and exits only when it sees EOF —
    /// so the test can tell "the bytes arrived" from "the write side was closed".
    #[derive(Clone)]
    struct ExecStdinEchoHandler;

    impl russh::server::Handler for ExecStdinEchoHandler {
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
            _data: &[u8],
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

        async fn channel_eof(
            &mut self,
            channel: russh::ChannelId,
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, russh::CryptoVec::from(&b"SAW-EOF"[..]))?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }
    }

    /// A duplex exec carries typed bytes to the remote command — the plain
    /// round trip behind ⓐ, with no flood in the way.
    ///
    /// Note what is *not* asserted: EOF on teardown. `SessionManager::remove`
    /// cancels the session future before the input senders drop, so the writer's
    /// closing `eof()` is not reachable from the manager today (recorded as a
    /// known window). The `Eof` mode's `eof()` — the one production depends on —
    /// is held by `inprocess_exec_sends_stdin_eof_so_stdin_readers_terminate`.
    #[test]
    fn a_duplex_exec_carries_typed_bytes_to_the_remote() {
        let port = serve_once(ExecStdinEchoHandler);
        let mgr = SessionManager::new();
        let cfg = SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("testpass".into()),
            exec: Some(ExecSpec::duplex("attach")),
        };
        let (id, mut chans) = mgr.create_ssh(cfg, temp_known_hosts("exec_echo"), 80, 24, None);

        let mut ready = false;
        let deadline = Instant::now() + Duration::from_millis(8000);
        while Instant::now() < deadline && !ready {
            if let Ok(ch) = chans.prompt_rx.try_recv() {
                let _ = ch.reply.send(HostKeyDecision::Accept);
            }
            if let Ok(SshStatus::Ready) = chans.status_rx.try_recv() {
                ready = true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(ready, "duplex exec never became ready");

        mgr.write(id, b"typed-into-the-remote\n")
            .expect("a duplex exec accepts input");
        assert!(
            wait_until(4000, || {
                let b = mgr.snapshot(id).map(|(b, _)| b).unwrap_or_default();
                b.windows(21).any(|w| w == b"typed-into-the-remote")
            }),
            "typed bytes must reach the remote command and come back on stdout"
        );

        let _ = mgr.remove(id);
    }
}
