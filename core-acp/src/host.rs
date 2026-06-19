//! ACP host thread — the Send-safe bridge over the `!Send` connection.
//!
//! The ACP `ClientSideConnection` is `!Send` and drives its I/O via
//! `spawn_local`, so it must live inside a `current_thread` runtime + `LocalSet`
//! (design D1). Tauri commands, however, run on arbitrary threads and need a
//! `Send + Sync` handle. [`AcpHost`] is that handle: it owns a dedicated OS
//! thread hosting the runtime and talks to it over two channels:
//!
//! - **inbound** ([`AcpCommand`]): a `tokio` unbounded channel. Its sender's
//!   `send` is synchronous, so Tauri commands push commands without blocking.
//! - **outbound** ([`AcpEvent`]): a `std::sync::mpsc` channel. The async host
//!   sends events synchronously; a Tauri relay thread drains them and re-emits
//!   them as webview events (mirroring the PTY `terminal-output` relay).
//!
//! The transport-agnostic [`run`] (connect → initialize → authenticate →
//! new_session → command/update loop) is split out so the fake-agent test can
//! drive it over in-memory pipes with no real `npx`.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::mpsc::Sender as StdSender;
use std::thread::JoinHandle;

use agent_client_protocol::{
    ContentBlock, Error, ErrorCode, PermissionOption, PermissionOptionId, SessionId, SessionUpdate,
    ToolCallContent, ToolCallUpdate,
};
use core_lib::{Timeline, WriteStatus};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

use crate::{AcpClient, ClientRequest};

/// A command sent *into* the host thread (synchronous send from any thread).
#[derive(Debug)]
pub enum AcpCommand {
    /// Send a user prompt to the active session.
    Prompt { text: String },
    /// The user's decision on a pending tool approval (S2b-2). `option_id` is
    /// the chosen `PermissionOption` id; an empty string cancels/declines.
    PermissionResponse { request_id: u64, option_id: String },
    /// Cancel the in-flight turn (best effort).
    Cancel,
    /// Tear down the session and kill the adapter subprocess.
    Shutdown,
}

/// An event emitted *out of* the host thread toward the UI. Serialized directly
/// onto the webview event by the Tauri relay.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpEvent {
    /// The session is live (handshake + new_session done). `session_id` is the
    /// adapter's id, carried for later commands/persistence (S3).
    Connected { session_id: String },
    /// One streamed chunk of the agent's reply (S1 renders text only).
    AgentMessageChunk { text: String },
    /// A new turn began (the user's prompt was sent). The timeline groups each
    /// turn's tool calls under this prompt (S3). `session_id` lets persistence
    /// key turns by session like items.
    TurnStarted {
        turn: u64,
        prompt: String,
        session_id: String,
    },
    /// A turn finished; `text` is the agent's accumulated answer for it (B3).
    /// Persisted and shown under the turn so a reopened session shows Q+A even
    /// when the turn made no changes.
    TurnAnswer {
        turn: u64,
        text: String,
        session_id: String,
    },
    /// The agent wants to run a tool; awaiting the user's approval (S2b-2).
    /// Answer with `AcpCommand::PermissionResponse { request_id, option_id }`.
    PermissionRequest {
        request_id: u64,
        title: String,
        /// Best-effort preview (an edit's new text, or text content).
        preview: String,
        locations: Vec<String>,
        options: Vec<PermissionOptionDto>,
    },
    /// The adapter reported `auth_required` (-32000): the user is not logged in.
    /// The `@zed-industries/claude-code-acp` adapter does **not** implement the
    /// `authenticate` RPC — login is out-of-band, so `command` is the shell
    /// command to run in a terminal (`claude /login`) before reconnecting.
    AuthRequired { command: String },
    /// A non-fatal error string for the UI (handshake/prompt failures, etc.).
    Error { message: String },
    /// A change-timeline item was created or updated (S3). Carries the merged
    /// item plus the `turn` it belongs to; the UI upserts by
    /// `(session_id, tool_call_id)`, groups by `turn`, and orders by `seq`.
    TimelineItem {
        #[serde(flatten)]
        item: core_lib::TimelineItem,
        turn: u64,
    },
    /// The host thread is finished (adapter exited or shutdown). Terminal.
    Disconnected,
}

/// A permission option surfaced to the UI (mirrors ACP `PermissionOption`).
#[derive(Debug, Clone, Serialize)]
pub struct PermissionOptionDto {
    pub id: String,
    pub name: String,
    /// `allow_once` | `allow_always` | `reject_once` | `reject_always`.
    pub kind: String,
}

impl From<&PermissionOption> for PermissionOptionDto {
    fn from(o: &PermissionOption) -> Self {
        use agent_client_protocol::PermissionOptionKind as K;
        let kind = match o.kind {
            K::AllowOnce => "allow_once",
            K::AllowAlways => "allow_always",
            K::RejectOnce => "reject_once",
            K::RejectAlways => "reject_always",
        };
        Self {
            id: o.id.0.to_string(),
            name: o.name.clone(),
            kind: kind.to_string(),
        }
    }
}

/// A `Send + Sync` handle to a running ACP adapter on its own thread.
///
/// Dropping the handle (or [`AcpHost::shutdown`]) asks the host to tear down;
/// the thread is detached (not joined on drop) so a slow adapter shutdown never
/// blocks the Tauri command thread.
pub struct AcpHost {
    commands: UnboundedSender<AcpCommand>,
    _thread: JoinHandle<()>,
}

impl AcpHost {
    /// Spawn `npx @zed-industries/claude-code-acp` rooted at `cwd` and host its
    /// connection on a dedicated thread. Lifecycle/error events flow to `events`.
    /// Returns an error only if the OS thread itself cannot be created (we never
    /// panic at the command boundary).
    pub fn spawn(cwd: PathBuf, events: StdSender<AcpEvent>) -> std::io::Result<AcpHost> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("acp-host".into())
            .spawn(move || host_main(cwd, cmd_rx, events))?;
        Ok(AcpHost {
            commands: cmd_tx,
            _thread: thread,
        })
    }

    /// Queue a prompt (no-op if the host thread has exited).
    pub fn prompt(&self, text: impl Into<String>) {
        let _ = self.commands.send(AcpCommand::Prompt { text: text.into() });
    }

    /// Answer a pending tool approval (S2b-2). An empty `option_id` declines.
    pub fn respond_permission(&self, request_id: u64, option_id: impl Into<String>) {
        let _ = self.commands.send(AcpCommand::PermissionResponse {
            request_id,
            option_id: option_id.into(),
        });
    }

    /// Cancel the in-flight turn.
    pub fn cancel(&self) {
        let _ = self.commands.send(AcpCommand::Cancel);
    }

    // NOTE: no `authenticate` — the fixed adapter does not implement the ACP
    // `authenticate` RPC (it always throws "Method not implemented"); login is
    // out-of-band via `claude /login` (see `AcpEvent::AuthRequired`).

    /// Ask the host to tear down (idempotent — also runs on drop).
    pub fn shutdown(&self) {
        let _ = self.commands.send(AcpCommand::Shutdown);
    }
}

impl Drop for AcpHost {
    fn drop(&mut self) {
        // Best effort: tell the thread to exit; don't join (avoid blocking).
        let _ = self.commands.send(AcpCommand::Shutdown);
    }
}

/// Thread entry: build a `current_thread` runtime + `LocalSet`, spawn the
/// adapter, run the connection, and always emit a terminal `Disconnected`.
fn host_main(cwd: PathBuf, cmd_rx: UnboundedReceiver<AcpCommand>, events: StdSender<AcpEvent>) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            let _ = events.send(AcpEvent::Error {
                message: format!("runtime: {e}"),
            });
            let _ = events.send(AcpEvent::Disconnected);
            return;
        }
    };
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        // Spawn the adapter with stdout reserved for pure JSON-RPC and stderr
        // split off (adapter logs must not corrupt the transport — spec §10).
        let mut child = match tokio::process::Command::new("npx")
            // `--yes` auto-confirms the first-run install prompt; without it npx
            // would block waiting on a stdin we've wired to the JSON-RPC pipe,
            // hanging initialize forever (spec §10 npx hygiene).
            .arg("--yes")
            .arg("@zed-industries/claude-code-acp")
            .current_dir(&cwd)
            // The adapter spawns its own Claude Code, which refuses to run
            // "inside another Claude Code session". If our app was launched from
            // a Claude Code terminal, that marker is inherited and aborts
            // `session/new`; drop it so the adapter's child starts cleanly.
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = events.send(AcpEvent::Error {
                    message: format!("spawn adapter (npx): {e}"),
                });
                let _ = events.send(AcpEvent::Disconnected);
                return;
            }
        };

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        if let Some(stderr) = child.stderr.take() {
            // Drain stderr so a chatty adapter never blocks on a full pipe, and
            // surface its lines on our own stderr (prefixed) for diagnosis —
            // these are adapter logs, kept off the JSON-RPC stdout (spec §10).
            tokio::task::spawn_local(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[claude-acp] {line}");
                }
            });
        }

        if let Err(message) = run(stdin, stdout, cwd, cmd_rx, &events).await {
            let _ = events.send(AcpEvent::Error { message });
        }
        // Best effort cleanup; `wait` reaps the child so it can't linger as a
        // zombie once we drop the runtime below (no-op if it already exited).
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = events.send(AcpEvent::Disconnected);
    });
}

/// Transport-agnostic connection driver: connect, handshake, (optional auth),
/// open a session, then pump commands and session updates until shutdown or the
/// connection closes. Factored out of [`host_main`] so the fake-agent test can
/// drive it over in-memory pipes (no real `npx`).
async fn run<W, R>(
    outgoing: W,
    incoming: R,
    cwd: PathBuf,
    mut cmd_rx: UnboundedReceiver<AcpCommand>,
    events: &StdSender<AcpEvent>,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin + 'static,
    R: AsyncRead + Unpin + 'static,
{
    let timeline_root = cwd.clone();
    let (client, io_task, mut updates, mut requests_rx) = AcpClient::new(outgoing, incoming);
    // Drive the JSON-RPC I/O for the lifetime of the connection.
    tokio::task::spawn_local(io_task);
    // `Rc` so prompt/cancel can run as concurrent local tasks while the main
    // loop keeps draining `updates` (otherwise a long turn would stall the
    // stream — `prompt` resolves only at end-of-turn).
    let client = Rc::new(client);

    // Each handshake RPC is raced against `Shutdown`: a hung/unresponsive
    // adapter must not pin this thread (and its subprocess) past a panel close
    // (codex finding #1). `None` = shutdown requested mid-handshake -> bail.
    match await_or_shutdown(client.initialize(), &mut cmd_rx).await {
        Some(r) => {
            r.map_err(|e| format!("initialize: {e}"))?;
        }
        None => return Ok(()),
    }

    // We deliberately ignore the advertised `auth_methods`: the fixed adapter
    // always advertises `claude-login` but its `authenticate` RPC is a stub
    // that throws (kill-switch finding, 2026-06-19). Login is out-of-band
    // (`claude /login`), and the real "not logged in" signal is the
    // `auth_required` (-32000) error returned by `new_session`/`prompt` below.
    let session_id = match await_or_shutdown(client.new_session(cwd), &mut cmd_rx).await {
        Some(Ok(sid)) => sid,
        Some(Err(e)) => {
            let _ = events.send(error_event("new_session", &e));
            return Ok(()); // host exits; `Disconnected` follows in host_main
        }
        None => return Ok(()),
    };
    let _ = events.send(AcpEvent::Connected {
        session_id: session_id.0.to_string(),
    });

    // Serialize turns: ACP is turn-based, so we keep at most one `session/prompt`
    // in flight and queue the rest (codex finding #3). Each prompt runs as a
    // detached task (so updates keep streaming) and signals `done` on
    // completion, which pulls the next queued prompt.
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<()>();
    let mut in_flight = false;
    let mut queue: VecDeque<String> = VecDeque::new();

    // The change timeline (S2a mapping) + the in-flight tool approvals (S2b-2).
    // `request_permission` is the gate; `write_text_file` is execute-only and
    // correlates to a timeline item by path (it carries no tool_call_id).
    let session = session_id.0.to_string();
    let mut timeline = Timeline::new(timeline_root);
    let mut pending_perms: HashMap<u64, oneshot::Sender<Option<PermissionOptionId>>> =
        HashMap::new();
    let mut next_request_id: u64 = 0;
    // Turn tracking (S3): each prompt opens a turn; tool calls that arrive while
    // it runs (turns are serialized) are attributed to it. `turn_of` pins each
    // item's turn at first sighting so later updates keep the same group.
    let mut current_turn: u64 = 0;
    let mut turn_of: HashMap<u64, u64> = HashMap::new();
    // The agent's answer text accumulated for the in-flight turn (B3).
    let mut current_answer = String::new();

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => match cmd {
                Some(AcpCommand::Prompt { text }) => {
                    if in_flight {
                        queue.push_back(text);
                    } else {
                        in_flight = true;
                        current_turn += 1;
                        let _ = events.send(AcpEvent::TurnStarted { turn: current_turn, prompt: text.clone(), session_id: session.clone() });
                        spawn_prompt(client.clone(), session_id.clone(), text, events.clone(), done_tx.clone());
                    }
                }
                Some(AcpCommand::PermissionResponse { request_id, option_id }) => {
                    if let Some(respond) = pending_perms.remove(&request_id) {
                        // Empty id = the user declined -> `None` -> Cancelled.
                        let choice = if option_id.is_empty() {
                            None
                        } else {
                            Some(PermissionOptionId(option_id.into()))
                        };
                        let _ = respond.send(choice);
                    }
                }
                Some(AcpCommand::Cancel) => {
                    let _ = client.cancel(session_id.clone()).await;
                }
                Some(AcpCommand::Shutdown) | None => break,
            },
            _ = done_rx.recv() => {
                // The finished turn's answer is now complete — persist/show it.
                if !current_answer.is_empty() {
                    let _ = events.send(AcpEvent::TurnAnswer {
                        turn: current_turn,
                        text: std::mem::take(&mut current_answer),
                        session_id: session.clone(),
                    });
                }
                // Current turn finished; start the next queued prompt, if any.
                match queue.pop_front() {
                    Some(next) => {
                        current_turn += 1;
                        let _ = events.send(AcpEvent::TurnStarted { turn: current_turn, prompt: next.clone(), session_id: session.clone() });
                        spawn_prompt(client.clone(), session_id.clone(), next, events.clone(), done_tx.clone());
                    }
                    None => in_flight = false,
                }
            }
            req = requests_rx.recv() => match req {
                // The gate: surface the tool for approval, park the responder
                // until the user picks an option (never auto-approve).
                Some(ClientRequest::Permission { tool_call, options, respond }) => {
                    let request_id = next_request_id;
                    next_request_id += 1;
                    let (title, preview, locations) = describe_tool(&tool_call);
                    let _ = events.send(AcpEvent::PermissionRequest {
                        request_id,
                        title,
                        preview,
                        locations,
                        options: options.iter().map(PermissionOptionDto::from).collect(),
                    });
                    pending_perms.insert(request_id, respond);
                }
                // Execute-only: permission was already granted via the gate.
                Some(ClientRequest::Write { path, content, respond }) => {
                    let (result, idx) = perform_write(&mut timeline, &path, &content);
                    emit_item(&timeline, idx, current_turn, &mut turn_of, events);
                    let _ = respond.send(result);
                }
                None => break, // client/handler dropped
            },
            note = updates.recv() => match note {
                Some(note) => {
                    // Feed tool calls into the timeline (S2a) and emit the merged
                    // item (S3). `apply` borrows; `forward` then moves the update.
                    let idx = timeline.apply(&session, &note.update);
                    emit_item(&timeline, idx, current_turn, &mut turn_of, events);
                    // Accumulate the agent's answer for the current turn (B3).
                    if let SessionUpdate::AgentMessageChunk {
                        content: ContentBlock::Text(t),
                    } = &note.update
                    {
                        current_answer.push_str(&t.text);
                    }
                    forward_update(note.update, events);
                }
                None => break, // connection closed (adapter exited / I/O ended)
            }
        }
    }
    Ok(())
}

/// Perform a (already-approved) disk write and record the outcome on the
/// timeline by path. The approval happened earlier via `request_permission`.
/// Returns the write result plus the affected timeline item index (if matched).
fn perform_write(
    timeline: &mut Timeline,
    path: &std::path::Path,
    content: &str,
) -> (Result<(), String>, Option<usize>) {
    match std::fs::write(path, content) {
        Ok(()) => {
            let idx = timeline.set_write_status_by_path(path, WriteStatus::Written);
            (Ok(()), idx)
        }
        Err(e) => {
            let idx = timeline.set_write_status_by_path(path, WriteStatus::WriteFailed);
            (Err(format!("write failed: {e}")), idx)
        }
    }
}

/// Emit the timeline item at `idx` (if any) to the UI, attributing it to the
/// turn it was first seen in (pinned in `turn_of` so updates keep their group).
fn emit_item(
    timeline: &Timeline,
    idx: Option<usize>,
    current_turn: u64,
    turn_of: &mut HashMap<u64, u64>,
    events: &StdSender<AcpEvent>,
) {
    if let Some(idx) = idx {
        let item = &timeline.items()[idx];
        let turn = *turn_of.entry(item.seq).or_insert(current_turn);
        let _ = events.send(AcpEvent::TimelineItem {
            item: item.clone(),
            turn,
        });
    }
}

/// Extract a UI-friendly `(title, preview, locations)` from a tool-call update
/// for the approval prompt. `preview` is the diff's new text or text content.
fn describe_tool(tu: &ToolCallUpdate) -> (String, String, Vec<String>) {
    let f = &tu.fields;
    let title = f.title.clone().unwrap_or_default();
    let preview = f
        .content
        .as_ref()
        .map(|c| preview_content(c))
        .unwrap_or_default();
    let locations = f
        .locations
        .as_ref()
        .map(|ls| ls.iter().map(|l| l.path.display().to_string()).collect())
        .unwrap_or_default();
    (title, preview, locations)
}

/// First diff `new_text` (or first text content) in a tool call's content.
fn preview_content(content: &[ToolCallContent]) -> String {
    for c in content {
        match c {
            ToolCallContent::Diff { diff } => return diff.new_text.clone(),
            ToolCallContent::Content {
                content: ContentBlock::Text(t),
            } => return t.text.clone(),
            _ => {}
        }
    }
    String::new()
}

/// Await `fut`, returning `None` if a `Shutdown` (or a closed command channel)
/// arrives first. Used to guard the handshake RPCs, which have no session to
/// act on yet, so any other command received here is simply dropped.
async fn await_or_shutdown<T>(
    fut: impl Future<Output = T>,
    cmd_rx: &mut UnboundedReceiver<AcpCommand>,
) -> Option<T> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            out = &mut fut => return Some(out),
            cmd = cmd_rx.recv() => match cmd {
                Some(AcpCommand::Shutdown) | None => return None,
                Some(_) => {} // ignore non-shutdown commands during handshake
            }
        }
    }
}

/// Run a prompt as a detached local task so the main loop keeps streaming
/// updates during the turn. Failures surface as an `Error` event; completion
/// (success or failure) signals `done` so the next queued turn can start.
fn spawn_prompt(
    client: Rc<AcpClient>,
    session_id: SessionId,
    text: String,
    events: StdSender<AcpEvent>,
    done: UnboundedSender<()>,
) {
    tokio::task::spawn_local(async move {
        if let Err(e) = client.prompt(session_id, text).await {
            let _ = events.send(error_event("prompt", &e));
        }
        let _ = done.send(());
    });
}

/// Classify an ACP error into a UI event: `auth_required` (-32000) becomes an
/// actionable [`AcpEvent::AuthRequired`] pointing at the out-of-band login
/// command; anything else is a generic [`AcpEvent::Error`].
fn error_event(context: &str, e: &Error) -> AcpEvent {
    if e.code == ErrorCode::AUTH_REQUIRED.code {
        AcpEvent::AuthRequired {
            command: "claude /login".to_string(),
        }
    } else {
        AcpEvent::Error {
            message: format!("{context}: {}", e.message),
        }
    }
}

/// Map a `session/update` to a UI event. S1 only renders agent message text;
/// tool-call events become timeline items in S2a/S2b.
fn forward_update(update: SessionUpdate, events: &StdSender<AcpEvent>) {
    if let SessionUpdate::AgentMessageChunk {
        content: ContentBlock::Text(t),
    } = update
    {
        let _ = events.send(AcpEvent::AgentMessageChunk { text: t.text });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::{
        Agent, AgentSideConnection, AuthenticateRequest, AuthenticateResponse, CancelNotification,
        Client, Diff, Error, InitializeRequest, InitializeResponse, NewSessionRequest,
        NewSessionResponse, PermissionOption, PermissionOptionId, PermissionOptionKind,
        PromptRequest, PromptResponse, RequestPermissionOutcome, RequestPermissionRequest,
        RequestPermissionResponse, SessionNotification, StopReason, ToolCallContent, ToolCallId,
        ToolCallLocation, ToolCallUpdate, ToolCallUpdateFields, ToolKind, WriteTextFileRequest,
        VERSION,
    };
    use std::cell::RefCell;
    use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

    /// Fake agent that completes the handshake and emits one text chunk per
    /// prompt — deterministic, no real `npx`. `concurrency` tracks
    /// `(current, max)` simultaneous `prompt` calls so a test can assert the
    /// host serializes turns. `auth_required` makes `new_session` return the
    /// `-32000` error the real adapter raises when the user is not logged in.
    struct FakeAgent {
        conn: Rc<RefCell<Option<Rc<AgentSideConnection>>>>,
        concurrency: Rc<RefCell<(u32, u32)>>,
        auth_required: bool,
        /// If set, `prompt` calls `fs/write_text_file` for this path (content
        /// "WRITTEN"), blocking on the client's approval gate.
        write_path: Option<PathBuf>,
    }

    #[async_trait::async_trait(?Send)]
    impl Agent for FakeAgent {
        async fn initialize(&self, _: InitializeRequest) -> Result<InitializeResponse, Error> {
            Ok(InitializeResponse {
                protocol_version: VERSION,
                agent_capabilities: Default::default(),
                auth_methods: vec![], // login reused -> no auth step
                meta: None,
            })
        }
        async fn authenticate(&self, _: AuthenticateRequest) -> Result<AuthenticateResponse, Error> {
            Ok(AuthenticateResponse::default())
        }
        async fn new_session(&self, _: NewSessionRequest) -> Result<NewSessionResponse, Error> {
            if self.auth_required {
                return Err(Error::auth_required());
            }
            Ok(NewSessionResponse {
                session_id: SessionId("host-session".into()),
                modes: None,
                meta: None,
            })
        }
        async fn prompt(&self, args: PromptRequest) -> Result<PromptResponse, Error> {
            // Enter the turn; record peak concurrency, then hold a window open
            // (yields) so an overlapping turn would be observed if it existed.
            {
                let mut c = self.concurrency.borrow_mut();
                c.0 += 1;
                c.1 = c.1.max(c.0);
            }
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            if let Some(conn) = self.conn.borrow().clone() {
                let _ = conn
                    .session_notification(SessionNotification {
                        session_id: args.session_id.clone(),
                        update: SessionUpdate::AgentMessageChunk {
                            content: ContentBlock::from("hello".to_string()),
                        },
                        meta: None,
                    })
                    .await;
            }
            // Optionally exercise the gate: ask permission for an edit, then —
            // only if approved — write the file. Blocks on the host's approval.
            if let Some(path) = self.write_path.clone() {
                if let Some(conn) = self.conn.borrow().clone() {
                    let resp = conn
                        .request_permission(RequestPermissionRequest {
                            session_id: args.session_id.clone(),
                            tool_call: ToolCallUpdate {
                                id: ToolCallId("edit-1".into()),
                                fields: ToolCallUpdateFields {
                                    kind: Some(ToolKind::Edit),
                                    title: Some("Edit sample".into()),
                                    content: Some(vec![ToolCallContent::Diff {
                                        diff: Diff {
                                            path: path.clone(),
                                            old_text: None,
                                            new_text: "WRITTEN".into(),
                                            meta: None,
                                        },
                                    }]),
                                    locations: Some(vec![ToolCallLocation {
                                        path: path.clone(),
                                        line: None,
                                        meta: None,
                                    }]),
                                    ..Default::default()
                                },
                                meta: None,
                            },
                            options: vec![
                                PermissionOption {
                                    id: PermissionOptionId("allow".into()),
                                    name: "Allow".into(),
                                    kind: PermissionOptionKind::AllowOnce,
                                    meta: None,
                                },
                                PermissionOption {
                                    id: PermissionOptionId("reject".into()),
                                    name: "Reject".into(),
                                    kind: PermissionOptionKind::RejectOnce,
                                    meta: None,
                                },
                            ],
                            meta: None,
                        })
                        .await;
                    if let Ok(RequestPermissionResponse {
                        outcome: RequestPermissionOutcome::Selected { option_id },
                        ..
                    }) = resp
                    {
                        if &*option_id.0 == "allow" {
                            let _ = conn
                                .write_text_file(WriteTextFileRequest {
                                    session_id: args.session_id.clone(),
                                    path,
                                    content: "WRITTEN".to_string(),
                                    meta: None,
                                })
                                .await;
                        }
                    }
                }
            }
            self.concurrency.borrow_mut().0 -= 1;
            Ok(PromptResponse {
                stop_reason: StopReason::EndTurn,
                meta: None,
            })
        }
        async fn cancel(&self, _: CancelNotification) -> Result<(), Error> {
            Ok(())
        }
    }

    /// Drive the real host `run` loop over in-memory pipes: connect, prompt,
    /// shutdown — and assert Connected + the streamed chunk reach `events`.
    #[test]
    fn host_run_connects_prompts_and_streams() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (client_end, agent_end) = tokio::io::duplex(8192);
            let (c_read, c_write) = tokio::io::split(client_end);
            let (a_read, a_write) = tokio::io::split(agent_end);

            // Agent side.
            let slot: Rc<RefCell<Option<Rc<AgentSideConnection>>>> = Rc::new(RefCell::new(None));
            let (agent_conn, agent_io) = AgentSideConnection::new(
                FakeAgent {
                    conn: slot.clone(),
                    concurrency: Rc::new(RefCell::new((0, 0))),
                    auth_required: false,
                    write_path: None,
                },
                a_write.compat_write(),
                a_read.compat(),
                |fut| {
                    tokio::task::spawn_local(fut);
                },
            );
            *slot.borrow_mut() = Some(Rc::new(agent_conn));
            tokio::task::spawn_local(async move {
                let _ = agent_io.await;
            });

            // Host side: drive `run` with a command channel and event sink.
            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (ev_tx, ev_rx) = std::sync::mpsc::channel();
            let run_handle = tokio::task::spawn_local(async move {
                run(c_write, c_read, PathBuf::from("/tmp"), cmd_rx, &ev_tx).await
            });

            // Mirror real usage (the UI gates prompts on `ready`): pump until
            // `Connected`, *then* prompt. A prompt sent mid-handshake would be
            // dropped by the shutdown-guard — the UI never does that.
            let mut got: Vec<AcpEvent> = Vec::new();
            for _ in 0..1000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    got.push(ev);
                }
                if got.iter().any(|e| matches!(e, AcpEvent::Connected { .. })) {
                    break;
                }
            }
            cmd_tx.send(AcpCommand::Prompt { text: "hi".into() }).unwrap();
            for _ in 0..1000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    got.push(ev);
                }
                if got
                    .iter()
                    .any(|e| matches!(e, AcpEvent::AgentMessageChunk { .. }))
                {
                    break;
                }
            }
            cmd_tx.send(AcpCommand::Shutdown).unwrap();
            run_handle.await.unwrap().expect("run ok");
            while let Ok(ev) = ev_rx.try_recv() {
                got.push(ev);
            }

            assert!(
                matches!(got.first(), Some(AcpEvent::Connected { session_id }) if session_id == "host-session"),
                "first event should be Connected, got {got:?}"
            );
            assert!(
                got.iter().any(|e| matches!(e, AcpEvent::AgentMessageChunk { text } if text == "hello")),
                "expected the streamed chunk, got {got:?}"
            );
        });
    }

    /// Two prompts issued back-to-back must not run concurrently: ACP is
    /// turn-based, so the host serializes them (codex finding #3). The fake
    /// agent records peak `prompt` concurrency, which must stay at 1.
    #[test]
    fn host_run_serializes_prompts() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (client_end, agent_end) = tokio::io::duplex(8192);
            let (c_read, c_write) = tokio::io::split(client_end);
            let (a_read, a_write) = tokio::io::split(agent_end);

            let slot: Rc<RefCell<Option<Rc<AgentSideConnection>>>> = Rc::new(RefCell::new(None));
            let concurrency = Rc::new(RefCell::new((0u32, 0u32)));
            let (agent_conn, agent_io) = AgentSideConnection::new(
                FakeAgent {
                    conn: slot.clone(),
                    concurrency: concurrency.clone(),
                    auth_required: false,
                    write_path: None,
                },
                a_write.compat_write(),
                a_read.compat(),
                |fut| {
                    tokio::task::spawn_local(fut);
                },
            );
            *slot.borrow_mut() = Some(Rc::new(agent_conn));
            tokio::task::spawn_local(async move {
                let _ = agent_io.await;
            });

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (ev_tx, ev_rx) = std::sync::mpsc::channel();
            let run_handle = tokio::task::spawn_local(async move {
                run(c_write, c_read, PathBuf::from("/tmp"), cmd_rx, &ev_tx).await
            });

            // Pump to Connected (UI gates prompts on `ready`).
            let mut connected = false;
            for _ in 0..1000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    if matches!(ev, AcpEvent::Connected { .. }) {
                        connected = true;
                    }
                }
                if connected {
                    break;
                }
            }
            assert!(connected, "session never connected");

            // Fire two prompts with no gap.
            let mut chunks = 0usize;
            cmd_tx.send(AcpCommand::Prompt { text: "a".into() }).unwrap();
            cmd_tx.send(AcpCommand::Prompt { text: "b".into() }).unwrap();

            // Pump until both turns have streamed their chunk.
            for _ in 0..4000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    if matches!(ev, AcpEvent::AgentMessageChunk { .. }) {
                        chunks += 1;
                    }
                }
                if chunks >= 2 {
                    break;
                }
            }
            cmd_tx.send(AcpCommand::Shutdown).unwrap();
            run_handle.await.unwrap().expect("run ok");

            assert_eq!(chunks, 2, "both prompts should have streamed a chunk");
            assert_eq!(
                concurrency.borrow().1,
                1,
                "prompts must be serialized (peak concurrency 1)"
            );
        });
    }

    /// When the adapter reports `auth_required` (-32000) from `new_session` —
    /// what the real adapter does when the user is not logged in — the host
    /// surfaces an actionable `AuthRequired` (with the login command), not a
    /// raw error, and never `Connected`.
    #[test]
    fn host_run_surfaces_auth_required() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (client_end, agent_end) = tokio::io::duplex(8192);
            let (c_read, c_write) = tokio::io::split(client_end);
            let (a_read, a_write) = tokio::io::split(agent_end);

            let slot: Rc<RefCell<Option<Rc<AgentSideConnection>>>> = Rc::new(RefCell::new(None));
            let (agent_conn, agent_io) = AgentSideConnection::new(
                FakeAgent {
                    conn: slot.clone(),
                    concurrency: Rc::new(RefCell::new((0, 0))),
                    auth_required: true,
                    write_path: None,
                },
                a_write.compat_write(),
                a_read.compat(),
                |fut| {
                    tokio::task::spawn_local(fut);
                },
            );
            *slot.borrow_mut() = Some(Rc::new(agent_conn));
            tokio::task::spawn_local(async move {
                let _ = agent_io.await;
            });

            let (_cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (ev_tx, ev_rx) = std::sync::mpsc::channel();
            let run_handle = tokio::task::spawn_local(async move {
                run(c_write, c_read, PathBuf::from("/tmp"), cmd_rx, &ev_tx).await
            });
            // `new_session` fails -> run returns Ok and drops ev_tx; the loop ends.
            run_handle.await.unwrap().expect("run returns ok even on auth error");

            let got: Vec<AcpEvent> = ev_rx.try_iter().collect();
            assert!(
                got.iter().any(|e| matches!(e, AcpEvent::AuthRequired { command } if command == "claude /login")),
                "expected AuthRequired with login command, got {got:?}"
            );
            assert!(
                !got.iter().any(|e| matches!(e, AcpEvent::Connected { .. })),
                "must not report Connected when auth is required, got {got:?}"
            );
        });
    }

    /// The tool approval gate (S2b-2): a `request_permission` surfaces a
    /// `PermissionRequest` and the agent's edit writes **nothing** until the
    /// user selects an allow option; then the file lands on disk.
    #[test]
    fn host_run_gates_tool_then_writes_on_approval() {
        let tmp = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static N: AtomicU64 = AtomicU64::new(0);
            std::env::temp_dir().join(format!(
                "mt-acp-write-{}-{}.txt",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ))
        };
        let _ = std::fs::remove_file(&tmp);

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (client_end, agent_end) = tokio::io::duplex(8192);
            let (c_read, c_write) = tokio::io::split(client_end);
            let (a_read, a_write) = tokio::io::split(agent_end);

            let slot: Rc<RefCell<Option<Rc<AgentSideConnection>>>> = Rc::new(RefCell::new(None));
            let (agent_conn, agent_io) = AgentSideConnection::new(
                FakeAgent {
                    conn: slot.clone(),
                    concurrency: Rc::new(RefCell::new((0, 0))),
                    auth_required: false,
                    write_path: Some(tmp.clone()),
                },
                a_write.compat_write(),
                a_read.compat(),
                |fut| {
                    tokio::task::spawn_local(fut);
                },
            );
            *slot.borrow_mut() = Some(Rc::new(agent_conn));
            tokio::task::spawn_local(async move {
                let _ = agent_io.await;
            });

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            let (ev_tx, ev_rx) = std::sync::mpsc::channel();
            let run_handle = tokio::task::spawn_local(async move {
                run(c_write, c_read, PathBuf::from("/work"), cmd_rx, &ev_tx).await
            });

            // Connect, then prompt (the fake agent issues the write mid-turn).
            let mut connected = false;
            for _ in 0..1000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    if matches!(ev, AcpEvent::Connected { .. }) {
                        connected = true;
                    }
                }
                if connected {
                    break;
                }
            }
            assert!(connected, "never connected");
            cmd_tx.send(AcpCommand::Prompt { text: "go".into() }).unwrap();

            // Wait for the permission request; nothing must be written yet.
            let mut request_id = None;
            for _ in 0..4000 {
                tokio::task::yield_now().await;
                while let Ok(ev) = ev_rx.try_recv() {
                    if let AcpEvent::PermissionRequest {
                        request_id: rid,
                        preview,
                        options,
                        ..
                    } = &ev
                    {
                        assert_eq!(preview, "WRITTEN");
                        assert!(options.iter().any(|o| o.id == "allow"));
                        request_id = Some(*rid);
                    }
                }
                if request_id.is_some() {
                    break;
                }
            }
            let request_id = request_id.expect("a PermissionRequest");
            assert!(!tmp.exists(), "must not write before approval");

            // Select the allow option -> the agent then writes the file.
            cmd_tx
                .send(AcpCommand::PermissionResponse {
                    request_id,
                    option_id: "allow".into(),
                })
                .unwrap();
            for _ in 0..4000 {
                tokio::task::yield_now().await;
                if tmp.exists() {
                    break;
                }
            }
            cmd_tx.send(AcpCommand::Shutdown).unwrap();
            run_handle.await.unwrap().expect("run ok");

            assert_eq!(std::fs::read_to_string(&tmp).unwrap(), "WRITTEN");
        });
        let _ = std::fs::remove_file(&tmp);
    }
}
