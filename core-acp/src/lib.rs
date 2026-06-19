//! ACP client island (async) — P2b-2 S1.
//!
//! This crate is the **async boundary** kept out of the synchronous, tauri-free
//! `core` crate (codex design review D1): `agent-client-protocol` + tokio live
//! here only, so `cargo test -p core` stays headless. The connection is `!Send`
//! and spawns via `tokio::task::spawn_local`, so it must run inside a
//! `current_thread` runtime + `LocalSet`.
//!
//! S1 scope: spawn/connect an ACP agent, `initialize` (capability negotiation),
//! `new_session` (cwd = session root), `prompt`, and forward `session/update`
//! notifications. fs/terminal capabilities are advertised `false` here and
//! turned on in S2b when their handlers exist (advertising a capability we would
//! reject would be a protocol lie).

mod host;
pub use host::{AcpCommand, AcpEvent, AcpHost};

use std::path::PathBuf;

use agent_client_protocol::{
    Agent, AuthMethodId, AuthenticateRequest, AuthenticateResponse, CancelNotification, Client,
    ClientCapabilities, ClientSideConnection, ContentBlock, Error, FileSystemCapability,
    InitializeRequest, InitializeResponse, NewSessionRequest, PermissionOption, PermissionOptionId,
    PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionId,
    SessionNotification, ToolCallUpdate, VERSION, WriteTextFileRequest, WriteTextFileResponse,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// A client request that needs the host loop to act (it owns the UI events, the
/// user approval gate, and the timeline). The thin handler forwards these and
/// awaits the reply on the embedded oneshot.
pub enum ClientRequest {
    /// `session/request_permission`: the agent wants to run a tool. The host
    /// surfaces it for approval and replies with the chosen option (or `None`
    /// to cancel). This is the real gate for **every** tool (edit, write, exec).
    Permission {
        tool_call: ToolCallUpdate,
        options: Vec<PermissionOption>,
        respond: oneshot::Sender<Option<PermissionOptionId>>,
    },
    /// `fs/write_text_file`: permission was already granted via `Permission`,
    /// so the host just performs the disk write and records the timeline.
    Write {
        path: PathBuf,
        content: String,
        respond: oneshot::Sender<Result<(), String>>,
    },
}

/// Handles agent -> client requests. Kept deliberately thin: notifications and
/// approval/write requests are forwarded to the host loop; only the
/// side-effect-free read is served inline. It never auto-approves (spec
/// invariant — the user decides every tool via `request_permission`).
struct ClientHandler {
    updates: UnboundedSender<SessionNotification>,
    requests: UnboundedSender<ClientRequest>,
}

#[async_trait::async_trait(?Send)]
impl Client for ClientHandler {
    /// The approval gate for every tool the agent wants to run (S2b-2). We never
    /// auto-allow: the host surfaces the request to the user and we return the
    /// option they pick (or `Cancelled` if they decline / the host is gone).
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, Error> {
        let (respond, outcome) = oneshot::channel();
        let req = ClientRequest::Permission {
            tool_call: args.tool_call,
            options: args.options,
            respond,
        };
        let chosen = if self.requests.send(req).is_err() {
            None
        } else {
            outcome.await.ok().flatten()
        };
        Ok(RequestPermissionResponse {
            outcome: match chosen {
                Some(option_id) => RequestPermissionOutcome::Selected { option_id },
                None => RequestPermissionOutcome::Cancelled,
            },
            meta: None,
        })
    }

    async fn session_notification(&self, args: SessionNotification) -> Result<(), Error> {
        // Drop is fine if the receiver is gone (panel closed).
        let _ = self.updates.send(args);
        Ok(())
    }

    /// Serve the agent's file reads from disk (S2b-1). Reads don't mutate state,
    /// so they need no approval gate — only the write path (S2b-2) does. The
    /// adapter routes Claude's Read tool through here once we advertise the
    /// `fs.readTextFile` capability, giving us a faithful view of what it reads.
    async fn read_text_file(
        &self,
        args: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse, Error> {
        let content = std::fs::read_to_string(&args.path).map_err(Error::into_internal_error)?;
        Ok(ReadTextFileResponse {
            content: slice_lines(&content, args.line, args.limit),
            meta: None,
        })
    }

    /// Execute a file write (S2b-2). Permission was already granted via
    /// `request_permission`, so the host loop just performs the disk write and
    /// records it to the timeline; we report the outcome back to the agent.
    async fn write_text_file(
        &self,
        args: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, Error> {
        let (respond, outcome) = oneshot::channel();
        let req = ClientRequest::Write {
            path: args.path,
            content: args.content,
            respond,
        };
        if self.requests.send(req).is_err() {
            return Err(Error::internal_error());
        }
        match outcome.await {
            Ok(Ok(())) => Ok(WriteTextFileResponse { meta: None }),
            Ok(Err(msg)) => Err(Error::internal_error().with_data(msg)),
            Err(_) => Err(Error::internal_error()), // host loop gone
        }
    }
}

/// Apply ACP's optional 1-based `line` start and `limit` line count to file
/// content. With neither set, returns the content unchanged (exact bytes).
fn slice_lines(content: &str, line: Option<u32>, limit: Option<u32>) -> String {
    if line.is_none() && limit.is_none() {
        return content.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let selected = content.lines().skip(start);
    match limit {
        Some(n) => selected.take(n as usize).collect::<Vec<_>>().join("\n"),
        None => selected.collect::<Vec<_>>().join("\n"),
    }
}

/// A connected ACP client. Construct with the agent subprocess's stdin
/// (`outgoing`) and stdout (`incoming`); also returns the I/O driver future
/// (spawn it on the LocalSet) and a receiver of session updates.
pub struct AcpClient {
    conn: ClientSideConnection,
}

impl AcpClient {
    #[allow(clippy::type_complexity)]
    pub fn new<W, R>(
        outgoing: W,
        incoming: R,
    ) -> (
        AcpClient,
        impl std::future::Future<Output = ()>,
        UnboundedReceiver<SessionNotification>,
        UnboundedReceiver<ClientRequest>,
    )
    where
        W: AsyncWrite + Unpin + 'static,
        R: AsyncRead + Unpin + 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let (req_tx, req_rx) = mpsc::unbounded_channel();
        let handler = ClientHandler {
            updates: tx,
            requests: req_tx,
        };
        // The ACP crate speaks `futures` AsyncRead/Write; bridge from tokio.
        let (conn, io_task) = ClientSideConnection::new(
            handler,
            outgoing.compat_write(),
            incoming.compat(),
            |fut| {
                tokio::task::spawn_local(fut);
            },
        );
        // The driver resolves to the crate's anyhow Result; callers just run it.
        let driver = async move {
            let _ = io_task.await;
        };
        (AcpClient { conn }, driver, rx, req_rx)
    }

    /// `initialize` handshake — negotiate version, advertise client capabilities.
    pub async fn initialize(&self) -> Result<InitializeResponse, Error> {
        self.conn
            .initialize(InitializeRequest {
                protocol_version: VERSION,
                client_capabilities: ClientCapabilities {
                    fs: FileSystemCapability {
                        // S2b: serve reads inline; route writes through the host
                        // loop's approval gate (`write_text_file` handler).
                        read_text_file: true,
                        write_text_file: true,
                        meta: None,
                    },
                    terminal: false,
                    meta: None,
                },
                meta: None,
            })
            .await
    }

    /// Create a session rooted at `cwd` (the active project = session root).
    pub async fn new_session(&self, cwd: PathBuf) -> Result<SessionId, Error> {
        let resp = self
            .conn
            .new_session(NewSessionRequest {
                cwd,
                mcp_servers: vec![],
                meta: None,
            })
            .await?;
        Ok(resp.session_id)
    }

    /// Authenticate with one of the methods advertised in `initialize`.
    pub async fn authenticate(&self, method_id: impl Into<String>) -> Result<AuthenticateResponse, Error> {
        self.conn
            .authenticate(AuthenticateRequest {
                method_id: AuthMethodId(method_id.into().into()),
                meta: None,
            })
            .await
    }

    /// Send a text prompt to the session.
    pub async fn prompt(
        &self,
        session_id: SessionId,
        text: impl Into<String>,
    ) -> Result<PromptResponse, Error> {
        self.conn
            .prompt(PromptRequest {
                session_id,
                prompt: vec![ContentBlock::from(text.into())],
                meta: None,
            })
            .await
    }

    /// Cancel any in-flight turn for the session (best effort — notification).
    pub async fn cancel(&self, session_id: SessionId) -> Result<(), Error> {
        self.conn
            .cancel(CancelNotification {
                session_id,
                meta: None,
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::{
        AgentSideConnection, AuthenticateRequest, AuthenticateResponse, CancelNotification,
        NewSessionResponse, SessionUpdate, StopReason,
    };
    use std::cell::RefCell;
    use std::rc::Rc;

    /// In-memory fake agent (no real npx) — deterministic fixture for S1
    /// handshake + a single agent message chunk on prompt.
    struct FakeAgent {
        // Set after construction so the agent can push notifications to the client.
        conn: Rc<RefCell<Option<Rc<AgentSideConnection>>>>,
    }

    #[async_trait::async_trait(?Send)]
    impl Agent for FakeAgent {
        async fn initialize(&self, _: InitializeRequest) -> Result<InitializeResponse, Error> {
            Ok(InitializeResponse {
                protocol_version: VERSION,
                agent_capabilities: Default::default(),
                auth_methods: vec![],
                meta: None,
            })
        }
        async fn authenticate(
            &self,
            _: AuthenticateRequest,
        ) -> Result<AuthenticateResponse, Error> {
            Ok(AuthenticateResponse::default())
        }
        async fn new_session(
            &self,
            _: NewSessionRequest,
        ) -> Result<NewSessionResponse, Error> {
            Ok(NewSessionResponse {
                session_id: SessionId("fake-session".into()),
                modes: None,
                meta: None,
            })
        }
        async fn prompt(&self, args: PromptRequest) -> Result<PromptResponse, Error> {
            if let Some(conn) = self.conn.borrow().clone() {
                let _ = conn
                    .session_notification(SessionNotification {
                        session_id: args.session_id.clone(),
                        update: SessionUpdate::AgentMessageChunk {
                            content: ContentBlock::from("pong".to_string()),
                        },
                        meta: None,
                    })
                    .await;
            }
            Ok(PromptResponse {
                stop_reason: StopReason::EndTurn,
                meta: None,
            })
        }
        async fn cancel(&self, _: CancelNotification) -> Result<(), Error> {
            Ok(())
        }
    }

    #[test]
    fn slice_lines_honors_line_and_limit() {
        let c = "a\nb\nc\nd";
        assert_eq!(slice_lines(c, None, None), "a\nb\nc\nd"); // exact, unchanged
        assert_eq!(slice_lines(c, Some(2), None), "b\nc\nd"); // from line 2
        assert_eq!(slice_lines(c, Some(2), Some(2)), "b\nc"); // 2 lines from line 2
        assert_eq!(slice_lines(c, None, Some(2)), "a\nb"); // first 2 lines
        assert_eq!(slice_lines(c, Some(99), None), ""); // past end
    }

    #[test]
    fn handshake_new_session_and_notification() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            // Two in-memory pipes wired as client<->agent.
            let (client_end, agent_end) = tokio::io::duplex(8192);
            let (c_read, c_write) = tokio::io::split(client_end);
            let (a_read, a_write) = tokio::io::split(agent_end);

            // Agent side: build connection, then hand it back to the FakeAgent so
            // it can send notifications during prompt handling.
            let slot: Rc<RefCell<Option<Rc<AgentSideConnection>>>> = Rc::new(RefCell::new(None));
            let fake = FakeAgent { conn: slot.clone() };
            let (agent_conn, agent_io) = AgentSideConnection::new(
                fake,
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

            // Client side.
            let (client, client_io, mut updates, _writes) = AcpClient::new(c_write, c_read);
            tokio::task::spawn_local(async move {
                let _ = client_io.await;
            });

            let init = client.initialize().await.expect("initialize");
            assert_eq!(init.protocol_version, VERSION);

            let sid = client
                .new_session(PathBuf::from("/tmp"))
                .await
                .expect("new_session");
            assert_eq!(&*sid.0, "fake-session");

            let resp = client.prompt(sid, "ping").await.expect("prompt");
            assert!(matches!(resp.stop_reason, StopReason::EndTurn));

            // The fake agent emitted one AgentMessageChunk during prompt.
            let note = updates.recv().await.expect("a session update");
            match note.update {
                SessionUpdate::AgentMessageChunk { content } => match content {
                    ContentBlock::Text(t) => assert_eq!(t.text, "pong"),
                    other => panic!("expected text content, got {other:?}"),
                },
                other => panic!("expected AgentMessageChunk, got {other:?}"),
            }
        });
    }
}
