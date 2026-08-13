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
use core_lib::remote::{HostConfig, LinkTimeouts, Registry};

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
        Conn { chan: None, stdin: None }
    }
}

struct Conn {
    chan: Option<Channel<Msg>>,
    /// Where this channel's incoming bytes go — the exec'd shell's stdin.
    ///
    /// R2a's server pinned stdin to `/dev/null`, which was honest then: nothing
    /// the bridge ran read it. A terminal attach does, so the server has to be
    /// a real one in both directions or the test would prove the client alone.
    stdin: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
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

    async fn data(
        &mut self,
        _id: ChannelId,
        data: &[u8],
        _s: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = &self.stdin {
            let _ = tx.send(data.to_vec());
        }
        Ok(())
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
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        self.stdin = Some(stdin_tx);
        tokio::spawn(async move {
            let mut child = match tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                // Its own process group, so a cut can take the shell and
                // everything it started.
                .process_group(0)
                .stdin(Stdio::piped())
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
            if let Some(mut sin) = child.stdin.take() {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt as _;
                    while let Some(b) = stdin_rx.recv().await {
                        if sin.write_all(&b).await.is_err() || sin.flush().await.is_err() {
                            break;
                        }
                    }
                });
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
        Daemon::start_with_agent(tag, buffer, "/bin/true")
    }

    /// As [`Self::start`], but with a chosen agent binary — a terminal test
    /// needs one that stays alive and answers.
    fn start_with_agent(tag: &str, buffer: Option<u32>, agent: &str) -> Daemon {
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
            .env("CWC_CLAUDE_BIN", agent)
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
        timeouts: LinkTimeouts::default(),
    }
}

/// Trust the server's key the way a user does — by connecting once with the
/// prompting client (an SSH terminal). The remote link itself never prompts.
fn learn_key(dir: &Path, port: u16) {
    use core_lib::ssh::{AuthMethod, ExecSpec, HostKeyDecision, SshConfig};
    let mgr = core_lib::SessionManager::new();
    let (id, mut ch) = mgr.create_ssh(
        SshConfig {
            host: "127.0.0.1".into(),
            port,
            username: "tester".into(),
            auth: AuthMethod::Password("x".into()),
            exec: Some(ExecSpec::output_only("true")),
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

/// A host whose "daemon" is a shell script — everything on the workbench side is
/// still production code, and the script decides what the stream does.
fn script_config(
    dir: &Path,
    port: u16,
    host_id: &str,
    script: &Path,
    timeouts: LinkTimeouts,
) -> HostConfig {
    HostConfig {
        host_id: host_id.into(),
        label: host_id.into(),
        host: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        auth: RemoteAuth::Password("x".into()),
        cwcd: script.to_string_lossy().to_string(),
        socket: None,
        known_hosts: dir.join("known_hosts"),
        timeouts,
    }
}

/// Write an executable `/bin/sh` script and return its path.
fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    }
    path
}

/// A scratch directory with the SSH server's key already trusted.
fn scratch(tag: &str) -> (PathBuf, u16) {
    restore_the_network();
    let dir = PathBuf::from(format!("/tmp/cwc-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let port = start_ssh_server();
    learn_key(&dir, port);
    (dir, port)
}

/// **The half-open link.** The connection is perfectly healthy and the remote
/// command is still running — it has simply stopped saying anything.
///
/// Nothing else can catch this: the observation window is output-only so no
/// error ever surfaces on it, `ssh.rs` disables russh's inactivity timeout, and
/// Linux would retransmit for ~15 minutes before a write failed. Without the
/// watchdog the panel says "연결됨" and shows data that stopped being true.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_stream_that_goes_silent_is_torn_down_even_though_the_connection_is_fine() {
    let (dir, port) = scratch("stale");
    // Speaks once, then holds the channel open forever without another byte —
    // exactly a wedged `cwcd stream`.
    let script = write_script(
        &dir,
        "mute.sh",
        r#"printf '{"frame":"hello","protocol":2,"daemon_version":"0.1.0","host":{"host_id":"h","hostname":"box","user":"u","os":"linux"},"epoch":"e1","resume":{"kind":"fresh"},"oldest_seq":1,"next_seq":1}\n'
sleep 600"#,
    );
    let link = core_lib::remote::Link::start(
        script_config(
            &dir,
            port,
            "stale",
            &script,
            LinkTimeouts {
                stale_after: Duration::from_secs(3),
                ..LinkTimeouts::default()
            },
        ),
        Arc::new(RecordingSink::default()),
    );

    wait_for(Duration::from_secs(20), || link.snapshot().phase == Phase::Live)
        .expect("the hello should attach");
    let at_hello = link.snapshot().last_frame_at_ms.expect("a frame arrived");
    assert!(at_hello > 0, "the screen must be able to say how old it is");

    // The connection stays up and the command stays alive; only the frames stop.
    wait_for(Duration::from_secs(30), || {
        let s = link.snapshot();
        s.phase != Phase::Live && s.attempts >= 2
    })
    .expect("silence on a live connection must end the window, not be waited out");
    let s = link.snapshot();
    assert!(
        s.notices.iter().any(|n| n.message.contains("프레임이 오지 않았습니다")),
        "the staleness must be stated: {:?}",
        s.notices.iter().map(|n| &n.message).collect::<Vec<_>>()
    );

    link.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// **The dribbling link** — the half-open case that arriving bytes hide.
///
/// This is not the silent stream above: this peer keeps *writing*. It just never
/// finishes a line, so no frame is ever decoded, `last_frame_at_ms` stays where
/// it was, and the panel shows data that stopped being true. A watchdog reset by
/// bytes is pushed back by every one of those characters and never fires — the
/// screen goes stale for as long as the peer keeps dribbling, which is exactly
/// the failure the watchdog was added for.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_stream_that_dribbles_bytes_without_ever_finishing_a_frame_is_stale_too() {
    let (dir, port) = scratch("dribble");
    // One hello, then a character every 100ms forever: the connection is up, the
    // command is alive, bytes keep arriving, and not one of them is a frame.
    let script = write_script(
        &dir,
        "dribble.sh",
        r#"printf '{"frame":"hello","protocol":2,"daemon_version":"0.1.0","host":{"host_id":"h","hostname":"box","user":"u","os":"linux"},"epoch":"e1","resume":{"kind":"fresh"},"oldest_seq":1,"next_seq":1}\n'
while :; do
  printf x
  sleep 0.1
done"#,
    );
    let link = core_lib::remote::Link::start(
        script_config(
            &dir,
            port,
            "dribble",
            &script,
            LinkTimeouts {
                stale_after: Duration::from_secs(5),
                ..LinkTimeouts::default()
            },
        ),
        Arc::new(RecordingSink::default()),
    );

    wait_for(Duration::from_secs(20), || link.snapshot().phase == Phase::Live)
        .expect("the hello should attach");
    let at_hello = link.snapshot().last_frame_at_ms.expect("a frame arrived");

    // Well inside the deadline, with bytes arriving the whole time: the age the
    // panel shows must not have moved either. The screen's clock and the
    // watchdog's are the same clock — if bytes reset one they reset both, and
    // then the panel says "1초 전" about a picture minutes old.
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        link.snapshot().last_frame_at_ms,
        Some(at_hello),
        "bytes without a frame must not make the screen look fresh"
    );

    wait_for(Duration::from_secs(40), || {
        let s = link.snapshot();
        s.phase != Phase::Live && s.attempts >= 2
    })
    .expect("a peer that dribbles bytes must not hold the watchdog off forever");
    let s = link.snapshot();
    assert!(
        s.notices.iter().any(|n| n.message.contains("프레임이 오지 않았습니다")),
        "the staleness must be stated: {:?}",
        s.notices.iter().map(|n| &n.message).collect::<Vec<_>>()
    );

    link.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A `cwcd stream` that connects and never says anything at all must fail with a
/// reason rather than sit on "연결 중" forever.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn an_attach_that_never_gets_a_hello_gives_up_and_says_so() {
    let (dir, port) = scratch("nohello");
    let script = write_script(&dir, "mute2.sh", "sleep 600");
    let link = core_lib::remote::Link::start(
        script_config(
            &dir,
            port,
            "nohello",
            &script,
            LinkTimeouts {
                hello_deadline: Duration::from_secs(3),
                ..LinkTimeouts::default()
            },
        ),
        Arc::new(RecordingSink::default()),
    );
    wait_for(Duration::from_secs(25), || {
        link.snapshot()
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("응답하지 않았습니다")
    })
    .expect("a silent daemon must be a stated failure, not an indefinite 'connecting'");
    link.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A failure only the user can fix must **stop**, not be retried every few
/// seconds forever.
///
/// The retry loop runs at ≤15s, so a permanent failure classified as transient
/// is a request repeated indefinitely — which for a rejected credential is how
/// the remote `sshd` comes to block the user's own address.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_missing_daemon_is_a_terminal_failure_not_an_endless_retry() {
    let (dir, port) = scratch("notfound");
    // What a host without `cwcd` installed actually does: the login shell says
    // "not found" and exits 127.
    let script = write_script(&dir, "gone.sh", "echo 'sh: cwcd: not found' >&2\nexit 127");
    let link = core_lib::remote::Link::start(
        script_config(&dir, port, "notfound", &script, LinkTimeouts::default()),
        Arc::new(RecordingSink::default()),
    );
    wait_for(Duration::from_secs(25), || link.snapshot().phase == Phase::Failed)
        .expect("a host without the daemon must fail, not retry forever");
    let s = link.snapshot();
    assert!(
        s.last_error.as_deref().unwrap_or_default().contains("cwcd"),
        "the user must be told what to fix: {:?}",
        s.last_error
    );
    let attempts = s.attempts;
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(
        link.snapshot().attempts,
        attempts,
        "a terminal failure must stop the loop, not slow it down"
    );
    link.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A reply larger than a terminal's scrollback ring must arrive **whole**.
///
/// It used to be read out of that 1 MB ring, which drops from the front — so a
/// big `cwcd timeline` came back headless and was reported as "daemon reply is
/// not JSON", pointing the reader at the daemon instead of at the buffer.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_reply_bigger_than_the_scrollback_ring_arrives_whole() {
    let (dir, port) = scratch("bigreply");
    // ~3 MB of JSON: a head, a lot of padding, and a tail that only survives if
    // nothing was dropped from the front.
    let script = write_script(
        &dir,
        "big.sh",
        r#"printf '{"response":"sessions","pad":"'
i=0
while [ $i -lt 3072 ]; do
  printf '%01024d' 0 | tr '0' 'x'
  i=$((i + 1))
done
printf '","sessions":[]}\n'"#,
    );
    let link = core_lib::remote::Link::start(
        script_config(&dir, port, "big", &script, LinkTimeouts::default()),
        Arc::new(RecordingSink::default()),
    );
    let out = link.call(&["list"]).expect("a big reply must not fail");
    assert!(
        out.len() > core_lib::session::DEFAULT_SCROLLBACK_CAP,
        "the reply must actually exceed the default ring, or this proves nothing: {} bytes",
        out.len()
    );
    let reply: SessionsReply =
        decode_response(&out).expect("a whole reply parses; a headless one does not");
    assert!(reply.sessions.is_empty());
    link.stop();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A line this workbench cannot read must not stop the stream in silence: the
/// bad line is named, the attach ends, and the loop comes back for a **fresh**
/// stream rather than resuming past the hole (R9 — a lost line may have been a
/// snapshot, and a resumed cursor tells the daemon it was delivered).
///
/// A frame *kind* from a newer daemon is a different thing and keeps its old
/// behaviour: it decodes, so nothing was lost, and the stream reads on. Hence
/// the order the script prints them in.
#[test]
#[ignore = "needs an SSH server: run with the other tests in this file"]
fn a_stream_of_nonsense_is_reported_and_retried() {
    restore_the_network();
    let dir = PathBuf::from(format!("/tmp/cwc-e2e-junk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let port = start_ssh_server();
    learn_key(&dir, port);

    // The two ways a stream goes wrong: a frame kind from a newer daemon (read,
    // reported, read on) and a line that is not a frame at all (loss — the
    // attach ends there, so it is printed last).
    let script = dir.join("junk.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf '{\"frame\":\"usage_delta\"}\\nnot json\\n'\n",
    )
    .expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    }

    let link = core_lib::remote::Link::start(
        script_config(&dir, port, "junk", &script, LinkTimeouts::default()),
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
    assert!(
        messages.iter().any(|m| m.contains("전체 상태를 다시 받습니다")),
        "an unreadable line must ask to be rebuilt, not be shrugged off: {messages:?}"
    );
    assert_eq!(
        s.cursor, None,
        "no position may be handed back while a resync is owed: {:?}",
        s.cursor
    );
    drop(link);
    let _ = std::fs::remove_dir_all(&dir);
}

/// **R2b's reason to exist**: type into a remote agent's terminal over a real
/// SSH connection to a real daemon, and see the agent answer.
///
/// Everything below the assertion is production code — `Registry::attach_config`
/// composes the address and the command, `ssh::ExecStdin::Stream` carries the
/// keystrokes, `cwcd attach` writes them into the pty the daemon owns, and the
/// agent's output comes back on the same byte pipeline every local terminal
/// uses. The only thing the test supplies is the agent (a shell that echoes
/// what it reads) and the SSH server.
#[test]
#[ignore = "needs a cwcd binary: CWCD=… cargo test -p core --test remote_ssh -- --ignored"]
fn a_remote_terminal_carries_what_is_typed_and_answers() {
    restore_the_network();
    let agent_dir = PathBuf::from(format!("/tmp/cwc-agent-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&agent_dir);
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let agent = write_script(
        &agent_dir,
        "echo-agent",
        "while read line; do case \"$line\" in size) stty size;; *) echo \"GOT:$line\";; esac; done",
    );
    let daemon = Daemon::start_with_agent("attach", None, agent.to_str().expect("utf8"));
    let port = start_ssh_server();
    learn_key(&daemon.dir, port);

    let registry = Registry::new();
    registry.attach(config(&daemon, port, "e2e"), Arc::new(RecordingSink::default()));
    wait_for(Duration::from_secs(20), || {
        registry.snapshots()[0].phase == Phase::Live
    })
    .expect("the stream should attach");

    daemon.spawn_session("terminal");
    wait_for(Duration::from_secs(20), || {
        !registry.snapshots()[0].sessions.is_empty()
    })
    .expect("the spawned session should appear on the stream");
    let id = registry.snapshots()[0].sessions[0].id;

    // --- the terminal ------------------------------------------------------
    let (cfg, known_hosts) = registry
        .attach_config("e2e", id, 100, 30)
        .expect("a live host must be able to open one of its terminals");
    let mgr = core_lib::SessionManager::new();
    let (local, mut chans) = mgr.create_ssh(cfg, known_hosts, 100, 30, None);
    // The attach refuses an unknown key rather than prompting; the key is
    // already trusted here, so nothing should arrive on this channel.
    std::thread::spawn(move || while chans.prompt_rx.blocking_recv().is_some() {});

    let screen = |what: &str| -> String {
        mgr.snapshot(local)
            .map(|(b, _)| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_else(|e| format!("<no session: {e}> ({what})"))
    };
    let type_and_wait = |line: &[u8], want: &str| {
        mgr.write(local, line).expect("a remote terminal takes input");
        wait_for(Duration::from_secs(20), || screen("wait").contains(want)).unwrap_or_else(|_| {
            panic!(
                "typed {:?} and never saw {want:?}; the terminal held:\n{}",
                String::from_utf8_lossy(line),
                screen("fail")
            )
        });
    };

    // What was typed reaches the agent, and its answer comes back.
    type_and_wait(b"hello-from-the-workbench\n", "GOT:hello-from-the-workbench");
    // …and the pty is the size the attach asked for, not the one it opened at
    // (`spawn` hardcodes 120x40, so 100x30 can only come from the attach).
    type_and_wait(b"size\n", "30 100");

    // --- and a resize is a command that answers, and that the agent sees ----
    let addr = registry.addr_of("e2e", id).expect("address");
    let reply = registry
        .call("e2e", &["resize", &addr, "--cols", "77", "--rows", "21"])
        .expect("resize");
    assert!(
        reply.contains("\"cols\": 77") && reply.contains("\"rows\": 21"),
        "the daemon must answer with the size it actually set: {reply}"
    );
    type_and_wait(b"size\n", "21 77");

    // --- the network goes away while someone is typing ---------------------
    //
    // The whole point of the daemon owning the process: an attach is a window,
    // not a leash. Cutting it must leave the agent exactly where it was, still
    // holding the state a person built up in it.
    cut_the_network();
    wait_for(Duration::from_secs(20), || mgr.is_alive(local) == Some(false))
        .expect("the terminal should notice the connection is gone");
    let _ = mgr.remove(local);
    restore_the_network();

    let (cfg, known_hosts) = registry
        .attach_config("e2e", id, 77, 21)
        .expect("the session is still there, so its terminal still opens");
    let (again, mut chans2) = mgr.create_ssh(cfg, known_hosts, 77, 21, None);
    std::thread::spawn(move || while chans2.prompt_rx.blocking_recv().is_some() {});
    let screen2 = |_: &str| -> String {
        mgr.snapshot(again)
            .map(|(b, _)| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    };
    // The replay proves it is the *same* run: this line was typed before the
    // cut, and the agent's answer to it is still in the ring.
    wait_for(Duration::from_secs(20), || {
        screen2("replay").contains("GOT:hello-from-the-workbench")
    })
    .unwrap_or_else(|_| {
        panic!(
            "a re-attach must replay what the session already produced; it held:\n{}",
            screen2("fail")
        )
    });
    mgr.write(again, b"after-the-cut\n").expect("input again");
    wait_for(Duration::from_secs(20), || {
        screen2("after").contains("GOT:after-the-cut")
    })
    .unwrap_or_else(|_| {
        panic!(
            "the agent must have survived the cut and still be reading; it held:\n{}",
            screen2("fail")
        )
    });

    let _ = mgr.remove(again);
    let _ = mgr.remove(local);
    registry.detach("e2e");
    let _ = std::fs::remove_dir_all(&agent_dir);
}
