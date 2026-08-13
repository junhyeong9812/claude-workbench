//! R2a end-to-end: a **real** SSH connection to a **real** `cwcd` daemon.
//!
//! Nothing here is simulated except the SSH server's identity: an in-process
//! `russh` server on `127.0.0.1` runs the exec request through `/bin/sh`, which
//! is what an OpenSSH server does with it. Everything on the workbench side is
//! production code — `core::ssh`'s R0 exec channel, `remote::link`'s observation
//! window, `remote::host`'s translation table — and everything on the other side
//! is the shipped `cwcd` binary.
//!
//! The server can also be told to **drop every connection and refuse new ones**,
//! which is how the load-bearing property is tested: the network goes away, the
//! host keeps working, and when the network comes back the workbench resumes
//! from its cursor with no gap.
//!
//! These are `#[ignore]`d because they need that binary. Run them with:
//!
//! ```text
//! CWCD=/path/to/cwcd cargo test -p core --test remote_ssh -- --ignored --test-threads=1
//! ```
//!
//! Ignored rather than "skip when the env var is missing" on purpose: a test
//! that passes when it did not run is the fail-open green this project has been
//! bitten by before.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use core_lib::remote::host::{Emit, Phase, ResumeOutcome};
use core_lib::remote::link::{RecordingSink, RemoteAuth};
use core_lib::remote::proto::{decode_response, HealthReply, SessionsReply};
use core_lib::remote::{HostConfig, Registry};

use russh::server::{Auth, Handler, Msg, Server as _, Session};
use russh::{Channel, ChannelId};

// ---------------------------------------------------------------------------
// A real SSH server (exec only) that can be cut off
// ---------------------------------------------------------------------------

/// Refuse new exec requests — "the network is down".
static REJECT: AtomicBool = AtomicBool::new(false);

/// Pids of the commands the server is currently running, so a cut can kill the
/// live `cwcd stream` the way a dropped connection does.
fn running() -> &'static Mutex<Vec<u32>> {
    static R: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

/// Cut every live connection and refuse new ones until [`restore`].
fn cut_the_network() {
    REJECT.store(true, Ordering::SeqCst);
    for pid in running().lock().expect("pids").drain(..) {
        // The whole group: `sh -c 'VAR=… cwcd stream'` may keep the shell as a
        // parent, and a surviving grandchild would hold the pipe open — which
        // would look exactly like a connection that never broke.
        // SAFETY: `pid` is a child this process started, in its own group.
        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
    }
}

fn restore_the_network() {
    REJECT.store(false, Ordering::SeqCst);
}

struct Srv;

impl russh::server::Server for Srv {
    type Handler = Conn;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Conn {
        Conn { chan: None }
    }
}

struct Conn {
    chan: Option<Channel<Msg>>,
}

impl Handler for Conn {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _pw: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        _s: &mut Session,
    ) -> Result<bool, Self::Error> {
        self.chan = Some(channel);
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        let Some(chan) = self.chan.take() else {
            session.channel_failure(id)?;
            return Ok(());
        };
        if REJECT.load(Ordering::SeqCst) {
            session.channel_failure(id)?;
            return Ok(());
        }
        session.channel_success(id)?;
        tokio::spawn(async move {
            let mut child = match tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                // Its own process group, so a cut can take the shell and
                // everything it started.
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    let _ = chan
                        .extended_data(1, format!("spawn failed: {e}").as_bytes())
                        .await;
                    let _ = chan.exit_status(127).await;
                    let _ = chan.close().await;
                    return;
                }
            };
            if let Some(pid) = child.id() {
                running().lock().expect("pids").push(pid);
            }
            let mut out = child.stdout.take().expect("piped");
            let mut err = child.stderr.take().expect("piped");
            let mut w = chan.make_writer();
            let mut we = chan.make_writer_ext(Some(1));
            let _ = tokio::join!(
                tokio::io::copy(&mut out, &mut w),
                tokio::io::copy(&mut err, &mut we)
            );
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(0);
            if let Some(pid) = child.id() {
                running().lock().expect("pids").retain(|p| *p != pid);
            }
            let _ = chan.eof().await;
            let _ = chan.exit_status(code as u32).await;
            let _ = chan.close().await;
        });
        Ok(())
    }
}

fn start_ssh_server() -> u16 {
    let key = russh::keys::PrivateKey::random(
        &mut russh::keys::ssh_key::rand_core::OsRng,
        russh::keys::Algorithm::Ed25519,
    )
    .expect("host key");
    let (tx, rx) = std::sync::mpsc::channel::<u16>();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async move {
            let mut cfg = russh::server::Config {
                auth_rejection_time: Duration::from_millis(1),
                ..Default::default()
            };
            cfg.keys.push(key);
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind");
            tx.send(listener.local_addr().expect("addr").port()).expect("port");
            Srv.run_on_socket(Arc::new(cfg), &listener).await.expect("serve");
        });
    });
    rx.recv().expect("server port")
}

// ---------------------------------------------------------------------------
// A real daemon
// ---------------------------------------------------------------------------

struct Daemon {
    child: Child,
    dir: PathBuf,
    socket: PathBuf,
    bin: PathBuf,
}

impl Daemon {
    /// `buffer` is the daemon's event ring size — a tiny one makes eviction
    /// (and therefore a real `Gap`) happen on demand.
    fn start(tag: &str, buffer: Option<u32>) -> Daemon {
        let bin = PathBuf::from(
            std::env::var("CWCD").expect("set CWCD to the cwcd binary to run this test"),
        );
        // Unix socket paths are capped near 108 bytes, so the runtime directory
        // has to be short — the session scratch dir is not.
        let dir = PathBuf::from(format!("/tmp/cwc-e2e-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).expect("temp dir");
        std::fs::create_dir_all(dir.join("work")).expect("temp dir");
        let socket = dir.join("d.sock");
        let mut cmd = Command::new(&bin);
        cmd.arg("serve");
        if let Some(n) = buffer {
            cmd.arg("--buffer").arg(n.to_string());
        }
        let child = cmd
            .env("CWC_SOCKET", &socket)
            .env("XDG_STATE_HOME", dir.join("state"))
            // A throwaway agent home, so nothing here touches the developer's own.
            .env("CLAUDE_CONFIG_DIR", dir.join("home"))
            // `/bin/true` as the agent: this test is about the *bridge*, and a
            // session that starts and exits produces exactly the frames it needs
            // (spawned → exited) without an API call.
            .env("CWC_CLAUDE_BIN", "/bin/true")
            .env("CWC_PROJECT_ROOTS", dir.join("work"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cwcd serve");
        let d = Daemon { child, dir, socket, bin };
        wait_for(Duration::from_secs(10), || d.socket.exists()).expect("daemon socket");
        d
    }

    /// Run a `cwcd` subcommand **locally**. The bridge is read-only by design,
    /// so the test drives the host the way an operator would: from the host.
    fn cli(&self, args: &[&str]) -> String {
        let out = Command::new(&self.bin)
            .args(args)
            .env("CWC_SOCKET", &self.socket)
            .output()
            .expect("cwcd");
        assert!(
            out.status.success(),
            "cwcd {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn spawn_session(&self, label: &str) {
        self.cli(&[
            "spawn",
            "--agent",
            "claude",
            "--cwd",
            self.dir.join("work").to_str().expect("utf8"),
            "--label",
            label,
        ]);
    }

    fn session_count(&self) -> usize {
        self.cli(&["list"]).matches("\"session_id\"").count()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn wait_for(timeout: Duration, mut f: impl FnMut() -> bool) -> Result<(), ()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if f() {
        Ok(())
    } else {
        Err(())
    }
}

fn config(daemon: &Daemon, port: u16, host_id: &str) -> HostConfig {
    HostConfig {
        host_id: host_id.into(),
        label: "테스트 호스트".into(),
        host: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        auth: RemoteAuth::Password("x".into()),
        cwcd: daemon.bin.to_string_lossy().to_string(),
        socket: Some(daemon.socket.to_string_lossy().to_string()),
        known_hosts: daemon.dir.join("known_hosts"),
    }
}

/// Trust the server's key the way a user does — by connecting once with the
/// prompting client (an SSH terminal). The remote link itself never prompts.
fn learn_key(dir: &Path, port: u16) {
    use core_lib::ssh::{AuthMethod, HostKeyDecision, SshConfig};
    let mgr = core_lib::SessionManager::new();
    let (id, mut ch) = mgr.create_ssh(
        SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("x".into()),
            exec: Some("true".into()),
        },
        dir.join("known_hosts"),
        80,
        24,
        None,
    );
    std::thread::spawn(move || {
        while let Some(c) = ch.prompt_rx.blocking_recv() {
            let _ = c.reply.send(HostKeyDecision::Accept);
        }
        while ch.exec_rx.blocking_recv().is_some() {}
    });
    wait_for(Duration::from_secs(10), || mgr.is_alive(id) == Some(false))
        .expect("first connection should finish");
    let _ = mgr.remove(id);
    assert!(dir.join("known_hosts").exists(), "the key should have been learned");
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs a cwcd binary: CWCD=… cargo test -p core --test remote_ssh -- --ignored"]
fn a_dropped_connection_resumes_with_no_gap_while_the_host_keeps_working() {
    restore_the_network();
    let daemon = Daemon::start("resume", None);
    let port = start_ssh_server();

    // --- an untrusted host key is refused, and the user is told why ---------
    {
        let registry = Registry::new();
        registry.attach(config(&daemon, port, "e2e"), Arc::new(RecordingSink::default()));
        wait_for(Duration::from_secs(20), || {
            registry.snapshots()[0].phase == Phase::Failed
        })
        .expect("an unknown host key must fail, not hang");
        assert!(
            registry.snapshots()[0]
                .last_error
                .as_deref()
                .unwrap_or_default()
                .contains("SSH 키"),
            "the reason must be on screen: {:?}",
            registry.snapshots()[0].last_error
        );
        registry.detach("e2e");
    }
    learn_key(&daemon.dir, port);

    // --- attach and observe --------------------------------------------------
    let registry = Registry::new();
    let sink = Arc::new(RecordingSink::default());
    registry.attach(config(&daemon, port, "e2e"), Arc::clone(&sink) as Arc<_>);
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].phase == Phase::Live
    })
    .expect("the stream should attach");

    let epoch = registry.snapshots()[0]
        .daemon
        .as_ref()
        .expect("hello")
        .epoch
        .clone();
    assert_eq!(
        registry.snapshots()[0].resume,
        Some(ResumeOutcome::Fresh),
        "a first attach reads the world"
    );

    // A short command runs on its own exec over the same connection settings.
    let health: HealthReply =
        decode_response(&registry.call("e2e", &["health"]).expect("health")).expect("decode");
    assert_eq!(health.epoch, epoch, "the stream and the short call see one daemon");

    // --- a session appears ---------------------------------------------------
    daemon.spawn_session("first");
    wait_for(Duration::from_secs(15), || {
        registry.snapshots()[0].sessions.len() == 1
    })
    .expect("the spawned session should reach the workbench");

    let first = registry.snapshots()[0].sessions[0].clone();
    assert_eq!(first.label.as_deref(), Some("first"));
    assert!(
        first.id >= core_lib::remote::REMOTE_ID_BASE,
        "a remote id must not be able to collide with a local one"
    );
    assert_eq!(first.uuid, format!("e2e/{}", first.session_id), "uuid is host-namespaced");
    assert_eq!(
        registry.addr_of("e2e", first.id),
        Some(format!("{epoch}:{}", first.key)),
        "the address pairs the daemon's key with the stream's epoch"
    );
    // `/bin/true` exits at once, so the end marker must arrive too.
    wait_for(Duration::from_secs(10), || {
        sink.0
            .lock()
            .expect("sink")
            .iter()
            .any(|e| matches!(e, Emit::Closed { id } if *id == first.id))
    })
    .expect("an exited session must reach the workbench as `closed`");

    let sessions: SessionsReply =
        decode_response(&registry.call("e2e", &["list"]).expect("list")).expect("decode");
    assert_eq!(sessions.sessions.len(), 1);

    let cursor_before = registry.snapshots()[0].cursor.clone().expect("a cursor");

    // --- the network goes away, the host keeps working -----------------------
    cut_the_network();
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].phase != Phase::Live
    })
    .expect("a dropped connection must be visible, not silent");
    assert!(
        registry.snapshots()[0].last_error.is_some(),
        "a break must say why"
    );

    daemon.spawn_session("while-away-1");
    daemon.spawn_session("while-away-2");
    wait_for(Duration::from_secs(15), || daemon.session_count() >= 3)
        .expect("the daemon keeps working while nobody is watching");
    assert_eq!(
        registry.snapshots()[0].sessions.len(),
        1,
        "nothing can have arrived while the connection was down"
    );

    // --- the network comes back ---------------------------------------------
    restore_the_network();
    wait_for(Duration::from_secs(40), || {
        registry.snapshots()[0].phase == Phase::Live
    })
    .expect("the link must reconnect on its own");

    // The load-bearing assertion: the daemon replayed **exactly** from where we
    // stopped — no gap, and no re-read of the world.
    let expected_from = cursor_before
        .rsplit_once(':')
        .and_then(|(_, n)| n.parse::<u64>().ok())
        .expect("cursor seq")
        + 1;
    assert_eq!(
        registry.snapshots()[0].resume,
        Some(ResumeOutcome::Continued { from_seq: expected_from }),
        "cursor before the break was {cursor_before}"
    );

    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].sessions.len() == 3
    })
    .expect("every session from the away window must arrive after the resume");
    let labels: Vec<String> = registry.snapshots()[0]
        .sessions
        .iter()
        .filter_map(|s| s.label.clone())
        .collect();
    assert!(
        labels.contains(&"while-away-1".into()) && labels.contains(&"while-away-2".into()),
        "labels were {labels:?}"
    );
    // A continuation does not replay a snapshot, so the row that was already on
    // screen keeps its identity rather than being swapped underneath a viewer.
    assert_eq!(
        registry.snapshots()[0]
            .sessions
            .iter()
            .find(|s| s.label.as_deref() == Some("first"))
            .map(|s| s.id),
        Some(first.id)
    );

    registry.detach_all();
}

/// When the daemon's ring moves past our cursor, the loss is **stated** and the
/// screen is rebuilt from a snapshot — never left quietly stale.
#[test]
#[ignore = "needs a cwcd binary: CWCD=… cargo test -p core --test remote_ssh -- --ignored"]
fn an_evicted_cursor_is_reported_and_the_screen_is_rebuilt() {
    restore_the_network();
    // A ring of one event: anything at all that happens while we are away
    // evicts what we had not read.
    let daemon = Daemon::start("gap", Some(1));
    let port = start_ssh_server();
    learn_key(&daemon.dir, port);

    let registry = Registry::new();
    registry.attach(config(&daemon, port, "gap"), Arc::new(RecordingSink::default()));
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].phase == Phase::Live
    })
    .expect("attach");
    daemon.spawn_session("before");
    wait_for(Duration::from_secs(15), || {
        registry.snapshots()[0].sessions.len() == 1
    })
    .expect("the first session should arrive");

    cut_the_network();
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].phase != Phase::Live
    })
    .expect("the break must be visible");
    for i in 0..6 {
        daemon.spawn_session(&format!("away-{i}"));
    }
    wait_for(Duration::from_secs(20), || daemon.session_count() >= 7).expect("the host works on");

    restore_the_network();
    wait_for(Duration::from_secs(40), || {
        matches!(registry.snapshots()[0].resume, Some(ResumeOutcome::Gap { .. }))
    })
    .expect("the daemon must say it could not honour the cursor");

    let s = registry.snapshots()[0].clone();
    assert!(
        s.notices.iter().any(|n| n.message.contains("받지 못했습니다")),
        "loss must be on screen, not implied: {:?}",
        s.notices.iter().map(|n| &n.message).collect::<Vec<_>>()
    );
    // …and the resync that follows brings the whole world back.
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].sessions.len() >= 7
    })
    .expect("the snapshot after a gap must rebuild the list");

    registry.detach_all();
}

/// A line this workbench cannot read must not stop the stream in silence: the
/// bad line is named and the loop keeps going.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_stream_of_nonsense_is_reported_and_retried() {
    restore_the_network();
    let dir = PathBuf::from(format!("/tmp/cwc-e2e-junk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let port = start_ssh_server();
    learn_key(&dir, port);

    // The two ways a stream goes wrong: a line that is not a frame at all, and
    // a frame kind from a newer daemon.
    let script = dir.join("junk.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf 'not json\\n{\"frame\":\"usage_delta\"}\\n'\n",
    )
    .expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    }

    let link = core_lib::remote::Link::start(
        HostConfig {
            host_id: "junk".into(),
            label: "junk".into(),
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: RemoteAuth::Password("x".into()),
            cwcd: script.to_string_lossy().to_string(),
            socket: None,
            known_hosts: dir.join("known_hosts"),
        },
        Arc::new(RecordingSink::default()),
    );
    wait_for(Duration::from_secs(30), || {
        let s = link.snapshot();
        s.attempts >= 2 && s.notices.len() >= 2
    })
    .expect("unreadable output must be reported and retried, not swallowed");

    let s = link.snapshot();
    let messages: Vec<&str> = s.notices.iter().map(|n| n.message.as_str()).collect();
    assert!(
        messages.iter().any(|m| m.contains("읽지 못했습니다")),
        "a line that is not a frame must be named: {messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.contains("usage_delta")),
        "a frame kind from the future must be named: {messages:?}"
    );
    drop(link);
    let _ = std::fs::remove_dir_all(&dir);
}
