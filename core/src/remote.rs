//! **R2a — observing a remote host.**
//!
//! A workbench connects to another machine's `cwcd` daemon over SSH and shows
//! what is happening there. Three layers, deliberately separate:
//!
//! - [`proto`] — the daemon's wire contract as a consumer reads it (pure);
//! - [`host`] — what one host's state is and how a frame changes it, including
//!   the whole translation table into the workbench's *existing* events (pure);
//! - [`link`] — the SSH exec transport, the reconnect loop, and the cursor
//!   (threads, no tauri).
//!
//! What this module is **not**: a second way to run things. Nothing here writes
//! to the remote host — no spawn, no kill, no input. R0's exec channel is
//! output-only and that is exactly enough to watch, which is the load-bearing
//! assumption this step was built on and smoke-tested before anything was
//! stacked on it.
//!
//! ## Purely additive, by construction
//!
//! Remote sessions reuse the workbench's existing events (`claude-timeline`,
//! `claude-session-closed`, `claude-hook-status`) and no new kinds are added.
//! They are nonetheless invisible to every local consumer, because those
//! consumers are all keyed by a **registry the remote side never writes to**:
//! `claudeStatusGlobal` reverse-maps a timeline event's numeric id through
//! `lookupSessionUuid` and returns early when it finds nothing, and filters
//! hook events by `hasSessionMapping`. Remote ids come from a disjoint number
//! space and remote uuids are host-prefixed ([`host`]'s module docs), so a
//! remote event cannot be mistaken for a local session's — the local UI is
//! byte-identical whether or not a host is attached.

pub mod host;
pub mod link;
pub mod proto;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

pub use host::{
    namespaced_uuid, DaemonInfo, Emit, HostSnapshot, Notice, NoticeLevel, Phase,
    RemoteSubagentFrame, RemoteTimelinePayload, ResumeOutcome, SessionMeta, REMOTE_ID_BASE,
};
pub use link::{HostConfig, Link, LinkTimeouts, RemoteAuth, Sink};

/// Every attached host, keyed by `host_id`.
///
/// Holding the links here (rather than in the Tauri layer) keeps the lifetime
/// rule in one place: attaching twice with the same id **replaces** the first
/// link, and replacing it stops it — a second observation window on the same
/// host is not harmful to the daemon, but it would double every event the
/// workbench emits.
/// Every attached host's link is held behind an `Arc` for one reason: a short
/// command is a whole SSH round-trip (up to 30s), and it must not be run while
/// the map lock is held. Taking a handle and **then** releasing the lock is what
/// keeps one wedged host from freezing every other host's polling, detaching and
/// attaching — the map is an index, not a queue.
#[derive(Default)]
pub struct Registry {
    links: Mutex<BTreeMap<String, Arc<Link>>>,
    /// The terminals opened onto each host's sessions, by the id the app's own
    /// `SessionManager` filed them under.
    ///
    /// A remote terminal is an **SSH exec of its own** (`cwcd attach`), not part
    /// of the observation window, so stopping the link leaves it running: the
    /// host's card disappears while typing still reaches the remote agent. Held
    /// here because this is the one place that knows a terminal belongs to a
    /// host — the session manager only sees a session like any other.
    terminals: Mutex<BTreeMap<String, Vec<u64>>>,
    /// How a terminal is closed, installed by the layer that owns the session
    /// manager. `core` cannot reach it: the manager lives in the app's Tauri
    /// state, and giving this module a handle to it would invert the dependency.
    ///
    /// It is handed the **host** as well as the terminal, because the app layer
    /// tells the user *why* a terminal stopped and "the host it belonged to was
    /// detached" is not something an id alone can say.
    #[allow(clippy::type_complexity)]
    closer: Mutex<Option<Arc<dyn Fn(&str, u64) + Send + Sync>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A handle to one host's link, with the map lock released.
    fn link(&self, host_id: &str) -> Option<Arc<Link>> {
        self.links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host_id)
            .map(Arc::clone)
    }

    /// Attach (or re-attach) a host. Returns the id it was filed under.
    ///
    /// A re-attach reads the world again rather than resuming from the cursor
    /// the previous link had. That is not a missed optimisation: a cursor is
    /// only meaningful *together with the state it was taken at*, and detaching
    /// throws that state away. Resuming from a bare cursor would leave every
    /// session that existed before the detach permanently absent — the daemon
    /// would say "continued, you have missed nothing" and be right about the
    /// events while the workbench was missing the world they describe. The
    /// gap-free resume that matters is the one inside a live link, where the
    /// state and the cursor travel together (`link::run`).
    pub fn attach(&self, cfg: HostConfig, sink: Arc<dyn Sink>) -> String {
        let id = cfg.host_id.clone();
        let link = Arc::new(Link::start(cfg, sink));
        // The old link is stopped **after** the lock is released: `stop` joins a
        // thread, and joining under the map lock blocks every other host.
        let old = {
            let mut links = self.links.lock().unwrap_or_else(|p| p.into_inner());
            let old = links.remove(&id);
            links.insert(id.clone(), link);
            old
        };
        if let Some(old) = old {
            // Replacing a link is an implicit detach, and it invalidates exactly
            // what a detach does: the new attachment allocates its own session
            // ids, so a terminal opened through the old one still types into the
            // agent while every command that addresses it (resize, kill) can no
            // longer find it. Closed with the link it belonged to.
            self.close_terminals_of(&id);
            old.stop();
        }
        id
    }

    /// Detach one host **and everything it is driving**. `false` when it was not
    /// attached.
    ///
    /// The terminals go with it. "떼기" is a statement about control, not about
    /// a card: a remote terminal left open after the host is detached still
    /// carries every keystroke to the agent, while the commands that answer
    /// (`remote_resize`, `remote_kill`) fail with "주소를 알 수 없습니다" because
    /// the link they addressed through is gone. The user's intent and the
    /// machine's state have to end up in the same place.
    ///
    /// The daemon and its agents are, as ever, untouched — closing a terminal
    /// closes this workbench's window onto a session, not the session.
    pub fn detach(&self, host_id: &str) -> bool {
        let taken = self
            .links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(host_id);
        self.close_terminals_of(host_id);
        match taken {
            Some(link) => {
                link.stop();
                true
            }
            None => false,
        }
    }

    // There is deliberately no `detach_all`. One existed, labelled "(app
    // shutdown)", and nothing ever called it — the run loop reaps PTY children
    // (`SessionManager::kill_all`) and exits, which drops every socket this
    // registry holds and lets the remote `sshd` tear down the `cwcd attach` it
    // was serving. Wiring the missing call would have made shutdown *worse*:
    // `Link::stop` **joins** its thread, and that thread can be inside an SSH
    // connect for an unreachable host, so quitting would block on a machine that
    // is not answering. This app has already shipped two fixes for a close that
    // would not close; adding a join to the quit path to tidy up state the
    // process is about to drop is not a trade it should make again.

    // -----------------------------------------------------------------------
    // Terminals opened onto a host (R2b `remote_attach`)
    // -----------------------------------------------------------------------

    /// Install the one thing this module cannot do itself: end a terminal.
    ///
    /// Called once by the app layer with a closure that removes the session from
    /// the manager (and tells the frontend). Without it, terminals are still
    /// **tracked** — [`Self::terminals`] keeps answering after a detach — so an
    /// uninstalled closer degrades to "nobody closed them", never to "nobody
    /// knows they exist".
    pub fn on_close_terminal(&self, close: impl Fn(&str, u64) + Send + Sync + 'static) {
        *self.closer.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(close));
    }

    /// Record a terminal that was opened onto one of `host_id`'s sessions.
    pub fn note_terminal(&self, host_id: &str, terminal_id: u64) {
        let mut map = self.terminals.lock().unwrap_or_else(|p| p.into_inner());
        let ids = map.entry(host_id.to_string()).or_default();
        if !ids.contains(&terminal_id) {
            ids.push(terminal_id);
        }
    }

    /// Forget a terminal that ended on its own — the remote command exited, the
    /// connection dropped, the user closed the tab. Keeping it would mean a
    /// later detach closing an id the manager has already reused.
    pub fn forget_terminal(&self, terminal_id: u64) {
        let mut map = self.terminals.lock().unwrap_or_else(|p| p.into_inner());
        for ids in map.values_mut() {
            ids.retain(|id| *id != terminal_id);
        }
        map.retain(|_, ids| !ids.is_empty());
    }

    /// The terminals currently open onto one host's sessions.
    pub fn terminals(&self, host_id: &str) -> Vec<u64> {
        self.terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Close (and forget) every terminal of one host. Both locks are released
    /// before the closer runs — it reaches into the session manager, which is a
    /// different lock order.
    fn close_terminals_of(&self, host_id: &str) {
        let closer = self
            .closer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        // Nothing to close them with: keep them recorded rather than dropping
        // the only record that they exist.
        let Some(closer) = closer else { return };
        let ids = self
            .terminals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(host_id)
            .unwrap_or_default();
        for id in ids {
            closer(host_id, id);
        }
    }

    pub fn snapshots(&self) -> Vec<HostSnapshot> {
        let links: Vec<Arc<Link>> = self
            .links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(Arc::clone)
            .collect();
        links.iter().map(|l| l.snapshot()).collect()
    }

    /// Every attached host's current timelines — what a panel that was closed
    /// and reopened is seeded from, since the events it missed are gone.
    pub fn live_payloads(&self) -> Vec<RemoteTimelinePayload> {
        let links: Vec<Arc<Link>> = self
            .links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(Arc::clone)
            .collect();
        links.iter().flat_map(|l| l.live_payloads()).collect()
    }

    /// Run a short command on one host. The map lock is released first — this
    /// call is a full SSH round-trip.
    pub fn call(&self, host_id: &str, args: &[&str]) -> Result<String, String> {
        self.link(host_id)
            .ok_or_else(|| "그 호스트에 연결되어 있지 않습니다.".to_string())?
            .call(args)
    }

    /// An SSH config that drives a remote session's terminal — see
    /// [`Link::attach_config`].
    pub fn attach_config(
        &self,
        host_id: &str,
        id: u64,
        cols: u16,
        rows: u16,
    ) -> Option<(crate::ssh::SshConfig, std::path::PathBuf)> {
        self.link(host_id)?.attach_config(id, cols, rows)
    }

    /// The `"<epoch>:k<n>"` address of a remote session id.
    pub fn addr_of(&self, host_id: &str, id: u64) -> Option<String> {
        self.link(host_id)?.addr_of(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records `(host_id, terminal_id)` — the app layer needs both to say why a
    /// terminal stopped, so both are part of the contract being checked.
    fn recording() -> (Registry, Arc<Mutex<Vec<(String, u64)>>>) {
        let reg = Registry::new();
        let closed = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&closed);
        reg.on_close_terminal(move |host, id| sink.lock().unwrap().push((host.to_string(), id)));
        (reg, closed)
    }

    fn ids(closed: &Arc<Mutex<Vec<(String, u64)>>>) -> Vec<u64> {
        closed.lock().unwrap().iter().map(|(_, id)| *id).collect()
    }

    /// **"떼기" takes the terminals with it.**
    ///
    /// Detaching stopped only the observation window. The host's card vanished
    /// from the panel while its terminal kept carrying keystrokes to the remote
    /// agent — and `remote_resize`, which goes through the link, answered "이
    /// 세션의 원격 주소를 알 수 없습니다". The user had said "stop controlling
    /// this host" and was still controlling it.
    #[test]
    fn detaching_a_host_closes_the_terminals_opened_onto_it() {
        let (reg, closed) = recording();
        reg.note_terminal("h1", 7);
        reg.note_terminal("h1", 8);
        reg.note_terminal("h2", 9);
        assert_eq!(reg.terminals("h1"), vec![7, 8]);

        reg.detach("h1");

        assert_eq!(
            *closed.lock().unwrap(),
            vec![("h1".to_string(), 7), ("h1".to_string(), 8)],
            "both of this host's terminals end, and the closer is told whose they were"
        );
        assert!(reg.terminals("h1").is_empty(), "…and are forgotten with it");
        assert_eq!(reg.terminals("h2"), vec![9], "another host's terminal is untouched");
    }

    /// A terminal that ended on its own must be forgotten, or a later detach
    /// would close an id the session manager has since handed to somebody else.
    #[test]
    fn a_terminal_that_ended_on_its_own_is_not_closed_again() {
        let (reg, closed) = recording();
        reg.note_terminal("h1", 7);
        reg.note_terminal("h1", 8);
        reg.forget_terminal(7);
        assert_eq!(reg.terminals("h1"), vec![8]);
        reg.detach("h1");
        assert_eq!(ids(&closed), vec![8]);
    }

    /// Detaching one host is **one** host: the loop that closed every host's
    /// terminals lived in a `detach_all` nobody called, and the rule that has to
    /// hold in the app is this one.
    #[test]
    fn detaching_one_host_leaves_the_others_driving() {
        let (reg, closed) = recording();
        reg.note_terminal("h1", 7);
        reg.note_terminal("h2", 9);
        reg.detach("h1");
        assert_eq!(ids(&closed), vec![7]);
        assert_eq!(reg.terminals("h2"), vec![9]);
        reg.detach("h2");
        assert_eq!(ids(&closed), vec![7, 9]);
    }

    /// Recording twice is not two terminals, and an unknown host has none —
    /// the query is what the app layer reads, so it must not invent rows.
    #[test]
    fn a_terminal_is_recorded_once_and_an_unknown_host_has_none() {
        let (reg, _) = recording();
        reg.note_terminal("h1", 7);
        reg.note_terminal("h1", 7);
        assert_eq!(reg.terminals("h1"), vec![7]);
        assert!(reg.terminals("nope").is_empty());
    }

    /// With no closer installed nothing can be closed — but nothing is silently
    /// forgotten either: the record survives so the app can still act on it.
    #[test]
    fn without_a_closer_the_terminals_are_kept_not_dropped() {
        let reg = Registry::new();
        reg.note_terminal("h1", 7);
        reg.detach("h1");
        assert_eq!(
            reg.terminals("h1"),
            vec![7],
            "a missing closer must not turn into a lost record"
        );
    }
}
