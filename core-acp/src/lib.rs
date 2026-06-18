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
    InitializeRequest, InitializeResponse, NewSessionRequest, PromptRequest, PromptResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionId,
    SessionNotification, VERSION,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Handles agent -> client requests. S1 only consumes `session/update`
/// notifications (forwarded to a channel) and declines permission (no UI yet —
/// never auto-allows; S2b surfaces it to the user).
struct ClientHandler {
    updates: UnboundedSender<SessionNotification>,
}

#[async_trait::async_trait(?Send)]
impl Client for ClientHandler {
    async fn request_permission(
        &self,
        _args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, Error> {
        // S1: decline rather than auto-allow (spec invariant — no auto-approve).
        Ok(RequestPermissionResponse {
            outcome: RequestPermissionOutcome::Cancelled,
            meta: None,
        })
    }

    async fn session_notification(&self, args: SessionNotification) -> Result<(), Error> {
        // Drop is fine if the receiver is gone (panel closed).
        let _ = self.updates.send(args);
        Ok(())
    }
}

/// A connected ACP client. Construct with the agent subprocess's stdin
/// (`outgoing`) and stdout (`incoming`); also returns the I/O driver future
/// (spawn it on the LocalSet) and a receiver of session updates.
pub struct AcpClient {
    conn: ClientSideConnection,
}

impl AcpClient {
    pub fn new<W, R>(
        outgoing: W,
        incoming: R,
    ) -> (
        AcpClient,
        impl std::future::Future<Output = ()>,
        UnboundedReceiver<SessionNotification>,
    )
    where
        W: AsyncWrite + Unpin + 'static,
        R: AsyncRead + Unpin + 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let handler = ClientHandler { updates: tx };
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
        (AcpClient { conn }, driver, rx)
    }

    /// `initialize` handshake — negotiate version, advertise client capabilities.
    pub async fn initialize(&self) -> Result<InitializeResponse, Error> {
        self.conn
            .initialize(InitializeRequest {
                protocol_version: VERSION,
                client_capabilities: ClientCapabilities {
                    // S1: handlers not implemented yet -> advertise false (S2b flips on).
                    fs: FileSystemCapability {
                        read_text_file: false,
                        write_text_file: false,
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
            let (client, client_io, mut updates) = AcpClient::new(c_write, c_read);
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
