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
    RemoteTimelinePayload, ResumeOutcome, SessionMeta, REMOTE_ID_BASE,
};
pub use link::{HostConfig, Link, RemoteAuth, Sink};

/// Every attached host, keyed by `host_id`.
///
/// Holding the links here (rather than in the Tauri layer) keeps the lifetime
/// rule in one place: attaching twice with the same id **replaces** the first
/// link, and replacing it stops it — a second observation window on the same
/// host is not harmful to the daemon, but it would double every event the
/// workbench emits.
#[derive(Default)]
pub struct Registry {
    links: Mutex<BTreeMap<String, Link>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach (or re-attach) a host. Returns the id it was filed under.
    pub fn attach(&self, cfg: HostConfig, sink: Arc<dyn Sink>) -> String {
        let id = cfg.host_id.clone();
        let link = Link::start(cfg, sink);
        let mut links = self.links.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut old) = links.remove(&id) {
            old.stop();
        }
        links.insert(id.clone(), link);
        id
    }

    /// Detach one host. `false` when it was not attached.
    pub fn detach(&self, host_id: &str) -> bool {
        let taken = self
            .links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(host_id);
        match taken {
            Some(mut link) => {
                link.stop();
                true
            }
            None => false,
        }
    }

    /// Detach everything (app shutdown).
    pub fn detach_all(&self) {
        let taken = std::mem::take(&mut *self.links.lock().unwrap_or_else(|p| p.into_inner()));
        for (_, mut link) in taken {
            link.stop();
        }
    }

    pub fn snapshots(&self) -> Vec<HostSnapshot> {
        self.links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(|l| l.snapshot())
            .collect()
    }

    /// Run a short command on one host.
    pub fn call(&self, host_id: &str, args: &[&str]) -> Result<String, String> {
        let links = self.links.lock().unwrap_or_else(|p| p.into_inner());
        let link = links
            .get(host_id)
            .ok_or_else(|| "그 호스트에 연결되어 있지 않습니다.".to_string())?;
        link.call(args)
    }

    /// The `"<epoch>:k<n>"` address of a remote session id.
    pub fn addr_of(&self, host_id: &str, id: u64) -> Option<String> {
        self.links
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host_id)?
            .addr_of(id)
    }
}
