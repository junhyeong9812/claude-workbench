//! PTY session management — owns the pseudo-terminals behind the terminal
//! panels (PLAN §7: SessionManager is the PTY pool).
//!
//! This module is intentionally **tauri-free** so `cargo test -p core` exercises
//! the PTY/scrollback/lifecycle logic headlessly (no webkit link). The Tauri
//! layer ([`src-tauri`]) bridges [`SessionManager::subscribe`] output chunks to
//! webview events; nothing here knows about Tauri.
//!
//! ## Output contract (spec P2b-1 §0 ③)
//! Every output chunk read from a PTY is assigned a strictly increasing `seq`.
//! [`SessionManager::snapshot`] returns `(bytes, last_seq)` atomically, so a
//! client can backfill the scrollback then apply only live chunks with
//! `seq > last_seq` — no loss, no duplication.
//!
//! ## Scrollback (spec §0.2)
//! The scrollback is a **byte** ring with a byte cap; when full, oldest bytes
//! are dropped from the front (escape sequences may be truncated — the terminal
//! emulator absorbs a broken leading fragment). "Preserved output" means a
//! replay of recent raw bytes, not a reconstructed terminal screen.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

/// Identifier for a PTY session (process-unique, monotonically assigned).
pub type SessionId = u64;

/// Default scrollback cap (bytes) — bounds per-session memory (spec §0.2 / #8).
pub const DEFAULT_SCROLLBACK_CAP: usize = 1_000_000;

const READ_CHUNK: usize = 8192;

/// A single chunk of PTY output, tagged with its monotonic sequence number.
#[derive(Debug, Clone)]
pub struct OutputChunk {
    pub seq: u64,
    pub bytes: Vec<u8>,
}

/// State shared between the manager and a session's output producer (the local
/// reader thread, or the SSH channel loop). `pub(crate)` so the `ssh` module can
/// drive the **same** scrollback/seq/fan-out contract as local PTYs — the
/// transport differs, the output pipeline does not.
pub(crate) struct Shared {
    scrollback: Mutex<Scrollback>,
    subscribers: Mutex<Vec<Sender<OutputChunk>>>,
    alive: AtomicBool,
}

impl Shared {
    pub(crate) fn new(cap: usize) -> Self {
        Shared {
            scrollback: Mutex::new(Scrollback::new(cap)),
            subscribers: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
        }
    }

    /// Append output bytes: assign the next monotonic `seq` in the scrollback and
    /// fan out to live subscribers (dropping any whose receiver is gone). This is
    /// the single output contract shared by local and SSH sessions.
    pub(crate) fn emit(&self, data: &[u8]) {
        let seq = self.scrollback.lock().unwrap().push(data);
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|tx| tx.send(OutputChunk { seq, bytes: data.to_vec() }).is_ok());
    }

    /// Mark the session dead (idempotent). Called on child/connection exit and on
    /// teardown so `is_alive` and write-rejection stay correct on all paths.
    pub(crate) fn set_dead(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    /// Seed the scrollback with restored bytes (opt-in persistence — P4). The
    /// seq counter stays at 0, so seeded bytes are pure backfill returned by
    /// `snapshot`; the first live chunk still gets `seq = 1` and the no-loss /
    /// no-dup backfill contract is preserved.
    pub(crate) fn seed(&self, bytes: &[u8]) {
        let mut sb = self.scrollback.lock().unwrap();
        sb.buf.clear();
        sb.buf.extend(bytes.iter().copied());
        while sb.buf.len() > sb.cap {
            sb.buf.pop_front();
        }
    }
}

/// Byte ring buffer + chunk sequence counter. Guarded by a `Mutex` in [`Shared`]
/// so `snapshot` and the reader thread's `push` are mutually atomic.
struct Scrollback {
    buf: VecDeque<u8>,
    cap: usize,
    last_seq: u64,
}

impl Scrollback {
    fn new(cap: usize) -> Self {
        Scrollback {
            buf: VecDeque::new(),
            cap,
            last_seq: 0,
        }
    }

    /// Append a chunk, drop from the front past the cap, return the chunk's seq.
    fn push(&mut self, data: &[u8]) -> u64 {
        self.last_seq += 1;
        self.buf.extend(data.iter().copied());
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
        self.last_seq
    }
}

/// Transport-specific resources behind a session. The output pipeline (`Shared`)
/// is identical across variants; only input/resize/teardown differ.
enum Transport {
    /// Local PTY (portable-pty). The reader thread owns its own cloned reader +
    /// `Arc<Shared>`; these handles are manager-owned (map-lock serialized).
    Local {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
        reader_handle: Option<JoinHandle<()>>,
    },
    /// Remote SSH session (russh). Its tokio runtime + channel loop live on a
    /// dedicated OS thread; [`crate::ssh::SshHandle`] carries the input/resize/
    /// cancel/join handles.
    Ssh(crate::ssh::SshHandle),
}

/// One session = a shared output pipeline + a transport.
struct Session {
    shared: Arc<Shared>,
    transport: Transport,
}

/// Owns every live PTY for the app run. `Send + Sync` so it can be a Tauri
/// managed state.
pub struct SessionManager {
    sessions: Mutex<HashMap<SessionId, Session>>,
    next_id: AtomicU64,
    scrollback_cap: usize,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::with_cap(DEFAULT_SCROLLBACK_CAP)
    }

    /// Construct with a custom scrollback byte cap (used by tests).
    pub fn with_cap(scrollback_cap: usize) -> Self {
        SessionManager {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            scrollback_cap,
        }
    }

    /// Spawn a PTY running `cmd` (or the user's default shell when `None`) in
    /// `cwd`, start its reader thread, and return the new session id.
    pub fn create(
        &self,
        cmd: Option<Vec<String>>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<SessionId, String> {
        self.create_seeded(cmd, cwd, cols, rows, None)
    }

    /// Like [`create`], but seed the scrollback with restored bytes (opt-in
    /// persistence — P4). `seed` is shown as backfill on the first snapshot.
    pub fn create_seeded(
        &self,
        cmd: Option<Vec<String>>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        seed: Option<Vec<u8>>,
    ) -> Result<SessionId, String> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

        let mut builder = match cmd {
            Some(parts) if !parts.is_empty() => {
                let mut b = CommandBuilder::new(&parts[0]);
                b.args(&parts[1..]);
                b
            }
            _ => CommandBuilder::new_default_prog(),
        };
        if let Some(dir) = cwd {
            builder.cwd(dir);
        }

        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let shared = Arc::new(Shared::new(self.scrollback_cap));
        if let Some(s) = &seed {
            shared.seed(s);
        }

        // Reader thread: read until EOF/error, append to scrollback with a seq,
        // fan out to subscribers, then mark dead and reap the child (no zombie,
        // no thread leak — spec #4).
        let shared_reader = Arc::clone(&shared);
        let handle = thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => shared_reader.emit(&buf[..n]),
                }
            }
            shared_reader.set_dead();
            let _ = child.wait();
        });

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                shared,
                transport: Transport::Local {
                    master: pair.master,
                    writer,
                    killer,
                    reader_handle: Some(handle),
                },
            },
        );
        Ok(id)
    }

    /// Spawn a remote SSH session (russh) and return its id immediately. The
    /// connect/auth/host-key handshake runs on the session's own thread; progress
    /// and failures surface via the returned [`SshChannels`] status stream (the
    /// Tauri layer relays them as events). Output flows through the same
    /// `Shared`/`subscribe`/`snapshot` pipeline as local PTYs.
    pub fn create_ssh(
        &self,
        config: crate::ssh::SshConfig,
        known_hosts_path: std::path::PathBuf,
        cols: u16,
        rows: u16,
        seed: Option<Vec<u8>>,
    ) -> (SessionId, crate::ssh::SshChannels) {
        let shared = Arc::new(Shared::new(self.scrollback_cap));
        if let Some(s) = &seed {
            shared.seed(s);
        }
        let (handle, channels) =
            crate::ssh::spawn_ssh(config, Arc::clone(&shared), known_hosts_path, cols, rows);
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                shared,
                transport: Transport::Ssh(handle),
            },
        );
        (id, channels)
    }

    /// Write bytes (keystrokes) to the PTY. Errors if the session is unknown or
    /// dead — never panics (spec invariant ④).
    /// True if a session with this id exists and is still alive (multiwindow
    /// mirror needs to know a 2nd window can attach to a running PTY).
    pub fn exists(&self, id: SessionId) -> bool {
        self.sessions
            .lock()
            .map(|m| m.get(&id).is_some_and(|s| s.shared.alive.load(Ordering::SeqCst)))
            .unwrap_or(false)
    }

    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(&id).ok_or("no such session")?;
        if !s.shared.alive.load(Ordering::SeqCst) {
            return Err("session is dead".into());
        }
        match &mut s.transport {
            Transport::Local { writer, .. } => {
                writer.write_all(data).map_err(|e| e.to_string())?;
                writer.flush().map_err(|e| e.to_string())
            }
            Transport::Ssh(h) => h.send_input(data),
        }
    }

    /// Resize the PTY. A 0-dimension (hidden panel) is a harmless no-op; an
    /// unknown session errors (spec #4).
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("no such session")?;
        match &s.transport {
            Transport::Local { master, .. } => master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            Transport::Ssh(h) => {
                h.set_size(cols, rows);
                Ok(())
            }
        }
    }

    /// Snapshot the scrollback atomically with its last seq (backfill contract,
    /// spec §0 ③).
    pub fn snapshot(&self, id: SessionId) -> Result<(Vec<u8>, u64), String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("no such session")?;
        let sb = s.shared.scrollback.lock().unwrap();
        Ok((sb.buf.iter().copied().collect(), sb.last_seq))
    }

    /// Subscribe to live output chunks. The caller receives chunks produced
    /// *after* subscription; combined with [`snapshot`] + the `seq > last_seq`
    /// rule this loses and duplicates nothing.
    pub fn subscribe(&self, id: SessionId) -> Result<Receiver<OutputChunk>, String> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(&id).ok_or("no such session")?;
        let (tx, rx) = mpsc::channel();
        s.shared.subscribers.lock().unwrap().push(tx);
        Ok(rx)
    }

    /// Whether the session's child is still running. `None` if unknown.
    pub fn is_alive(&self, id: SessionId) -> Option<bool> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.shared.alive.load(Ordering::SeqCst))
    }

    /// Signal the child to terminate, mark dead. Keeps the (dead) session
    /// queryable. Unknown session errors.
    pub fn kill(&self, id: SessionId) -> Result<(), String> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(&id).ok_or("no such session")?;
        match &mut s.transport {
            Transport::Local { killer, .. } => {
                let _ = killer.kill();
            }
            Transport::Ssh(h) => h.cancel(),
        }
        s.shared.set_dead();
        Ok(())
    }

    /// Fully tear a session down: kill, drop handles, and **join the reader
    /// thread** (proves no thread/PTY leak — spec §0.1 panel-close path).
    pub fn remove(&self, id: SessionId) -> Result<(), String> {
        // Take ownership out of the map before joining so the map lock is not
        // held across the join.
        let mut session = self
            .sessions
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or("no such session")?;
        session.shared.set_dead();
        // Tear down the transport. The map lock is already released (we removed
        // the session above), so the join below never holds it — a slow SSH
        // shutdown or reader drain can't block other sessions (codex F3).
        match &mut session.transport {
            Transport::Local {
                killer,
                reader_handle,
                ..
            } => {
                let _ = killer.kill();
                // Drop master/writer (in `session`) closes the PTY -> reader EOFs.
                if let Some(handle) = reader_handle.take() {
                    let _ = handle.join();
                }
            }
            Transport::Ssh(h) => {
                // Cancel cancels every await point (connect/auth/host-key/write),
                // then join waits for the runtime thread to unwind its RAII guard.
                h.cancel();
                h.join();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Spin until `f()` is true or the timeout elapses.
    fn wait_until(timeout_ms: u64, mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while Instant::now() < deadline {
            if f() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        f()
    }

    fn sh(script: &str) -> Option<Vec<String>> {
        Some(vec!["/bin/sh".into(), "-c".into(), script.into()])
    }

    #[test]
    fn output_is_buffered_with_monotonic_seq() {
        let mgr = SessionManager::new();
        let id = mgr.create(sh("printf hello"), None, 80, 24).unwrap();
        assert!(
            wait_until(2000, || mgr.snapshot(id).unwrap().0.windows(5).any(|w| w == b"hello")),
            "scrollback should contain the child's output"
        );
        let (_, last_seq) = mgr.snapshot(id).unwrap();
        assert!(last_seq >= 1, "at least one chunk seq assigned");
    }

    #[test]
    fn backfill_boundary_live_chunks_exceed_snapshot_seq() {
        let mgr = SessionManager::new();
        // Two outputs separated by a sleep -> at least two chunks.
        let id = mgr
            .create(sh("printf A; sleep 0.15; printf B"), None, 80, 24)
            .unwrap();
        let rx = mgr.subscribe(id).unwrap();
        // First chunk (seq 1) carries "A".
        let first = rx.recv_timeout(Duration::from_millis(2000)).unwrap();
        assert_eq!(first.seq, 1);
        // Snapshot now: last_seq reflects only what has arrived.
        let (_, snap_seq) = mgr.snapshot(id).unwrap();
        // Subsequent live chunk(s) must have seq strictly greater than snap_seq.
        let next = rx.recv_timeout(Duration::from_millis(2000)).unwrap();
        assert!(
            next.seq > snap_seq,
            "live chunk seq {} must exceed snapshot last_seq {}",
            next.seq,
            snap_seq
        );
    }

    #[test]
    fn scrollback_is_byte_capped_keeping_the_tail() {
        let mgr = SessionManager::with_cap(10);
        let id = mgr.create(sh("printf 0123456789ABCDEF"), None, 80, 24).unwrap();
        assert!(wait_until(2000, || {
            let (buf, _) = mgr.snapshot(id).unwrap();
            buf.ends_with(b"ABCDEF")
        }));
        let (buf, _) = mgr.snapshot(id).unwrap();
        assert!(buf.len() <= 10, "buffer {} exceeds cap", buf.len());
        assert!(buf.ends_with(b"ABCDEF"), "newest bytes must be retained");
    }

    #[test]
    fn two_sessions_are_isolated() {
        let mgr = SessionManager::new();
        let a = mgr.create(sh("printf AAA"), None, 80, 24).unwrap();
        let b = mgr.create(sh("printf BBB"), None, 80, 24).unwrap();
        assert!(wait_until(2000, || mgr.snapshot(a).unwrap().0.windows(3).any(|w| w == b"AAA")));
        assert!(wait_until(2000, || mgr.snapshot(b).unwrap().0.windows(3).any(|w| w == b"BBB")));
        let (buf_a, _) = mgr.snapshot(a).unwrap();
        assert!(!buf_a.windows(3).any(|w| w == b"BBB"), "A must not see B's output");
    }

    #[test]
    fn unknown_session_ops_error_not_panic() {
        let mgr = SessionManager::new();
        assert!(mgr.write(999, b"x").is_err());
        assert!(mgr.resize(999, 80, 24).is_err());
        assert!(mgr.kill(999).is_err());
        assert!(mgr.snapshot(999).is_err());
        assert!(mgr.is_alive(999).is_none());
    }

    #[test]
    fn child_exit_marks_dead_and_rejects_writes() {
        let mgr = SessionManager::new();
        let id = mgr.create(sh("exit 0"), None, 80, 24).unwrap();
        assert!(
            wait_until(2000, || mgr.is_alive(id) == Some(false)),
            "session should be dead after child exits"
        );
        assert!(mgr.write(id, b"x").is_err(), "write to dead session errors");
    }

    #[test]
    fn resize_zero_dimension_is_noop_dead_is_handled() {
        let mgr = SessionManager::new();
        let id = mgr.create(sh("sleep 0.2"), None, 80, 24).unwrap();
        assert!(mgr.resize(id, 0, 0).is_ok(), "0x0 resize is a harmless no-op");
        assert!(mgr.resize(id, 100, 40).is_ok(), "live resize succeeds");
        // After the child exits, resize may error but must not panic.
        wait_until(2000, || mgr.is_alive(id) == Some(false));
        let _ = mgr.resize(id, 120, 50);
    }

    #[test]
    fn seeded_scrollback_is_returned_as_backfill() {
        let mgr = SessionManager::new();
        // Seed restored bytes; they must appear as backfill immediately (before
        // any live output), preceding the child's own output.
        let id = mgr
            .create_seeded(sh("printf NEW"), None, 80, 24, Some(b"PRIOR".to_vec()))
            .unwrap();
        let (buf, _) = mgr.snapshot(id).unwrap();
        assert!(buf.starts_with(b"PRIOR"), "seed must be present as backfill");
        assert!(wait_until(2000, || {
            let (b, _) = mgr.snapshot(id).unwrap();
            b.windows(3).any(|w| w == b"NEW")
        }));
        // Seed precedes live output.
        let (buf, _) = mgr.snapshot(id).unwrap();
        assert!(buf.starts_with(b"PRIOR"));
    }

    #[test]
    fn remove_joins_reader_thread() {
        let mgr = SessionManager::new();
        let id = mgr.create(sh("sleep 5"), None, 80, 24).unwrap();
        // remove kills the child and joins the reader; it must return promptly,
        // proving the thread (and PTY) were cleaned up.
        let start = Instant::now();
        mgr.remove(id).unwrap();
        assert!(start.elapsed() < Duration::from_millis(2000), "remove should join quickly");
        assert!(mgr.is_alive(id).is_none(), "session gone after remove");
    }
}
