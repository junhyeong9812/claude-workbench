//! What a workbench knows about one remote host, and how a frame changes it.
//!
//! Everything here is **pure**: frames in, state changes and a list of
//! [`Emit`]s out. No SSH, no tauri, no threads — so the whole translation table
//! (remote frame → workbench event) is unit-testable, and the transport in
//! `super::link` has nothing left to get wrong except moving bytes.
//!
//! ## The three namespaces this file keeps apart
//!
//! - **`SessionKey`** (`"k7"`) names a session *inside one daemon incarnation*.
//!   It is the daemon's word and never leaves this module.
//! - **remote id** (`u64`, from [`REMOTE_ID_BASE`]) is what the workbench's
//!   existing `claude-timeline` / `claude-session-closed` events carry, because
//!   those events have always carried a numeric PTY id. Local ids come from
//!   `SessionManager`'s counter starting at 1; starting the remote allocator at
//!   2^40 puts a trillion sessions between the two spaces, and the allocator is
//!   process-global so two hosts cannot collide either.
//! - **namespaced uuid** (`"<host_id>/<session_id>"`) is what
//!   `claude-hook-status` carries. The daemon's `session_id` is a plain uuid,
//!   unique per host and *not* over time; prefixing the host makes a collision
//!   with a local session structurally impossible rather than merely unlikely.
//!
//! ## What is deliberately not translated
//!
//! `answers`, `dates` and per-turn `tokens` are workbench-local derivations of
//! a transcript (`jsonl::SessionTail`) and **the daemon does not put them on the
//! wire** — `TimelineDelta` carries `items`, `turns`, `model` and `last_usage`,
//! and `SessionSnapshot`/`TimelineSlice` carry the same set. They are therefore
//! emitted empty, and the emptiness is a fact about the contract rather than a
//! bug here. The same goes for `subagents`: the daemon tails one transcript per
//! session and never opens `<uuid>/subagents/`. Both are recorded as known
//! windows in this step's log; closing either is a change to the *daemon's*
//! contract, which is another repository.
//!
//! There is likewise no source for `terminal-output-{id}`: the daemon's stream
//! has no frame carrying an agent's terminal bytes at all. Remote terminal
//! fidelity is R2b's, not a gap this file can paper over.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::timeline::{TimelineItem, TokenUsage};

use super::proto::{
    self, AdoptionOutcome, AgentKind, Envelope, Event, Frame, Gap, Hello, Resume, SessionKey,
    SessionSnapshot, SessionState, SessionView, Snapshot,
};

/// Where remote session ids start. See the module docs; the only property that
/// matters is that no local `SessionManager` id can ever reach it.
pub const REMOTE_ID_BASE: u64 = 1 << 40;

/// Display cap for one item's text, mirroring the local payload's own
/// `CONTENT_CAP` (`src-tauri/.../claude/timeline.rs`). The local viewer can
/// fetch the untruncated original with `claude_item_detail`; a remote item has
/// no such address yet, so the flag is all the user gets — which is still the
/// difference between "shortened" and "silently different".
pub const CONTENT_CAP: usize = 4 * 1024;

static NEXT_REMOTE_ID: AtomicU64 = AtomicU64::new(REMOTE_ID_BASE);

fn alloc_remote_id() -> u64 {
    NEXT_REMOTE_ID.fetch_add(1, Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/// The `claude-timeline` payload, for a remote session.
///
/// Field-for-field the shape `ClaudeTimelinePayload` emits for a local session
/// (`src-tauri/src/commands/claude/timeline.rs`), so the frontend's
/// `ClaudeTimelineEvent` reads both without a branch. `remote_payload_shape`
/// below pins the key set against a copy of the local one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RemoteTimelinePayload {
    pub id: u64,
    pub items: Vec<TimelineItem>,
    pub turns: Vec<(u64, String)>,
    /// Always empty — see the module docs.
    pub answers: Vec<(u64, String)>,
    /// Always empty — see the module docs.
    pub dates: Vec<(u64, String)>,
    /// Always empty — see the module docs.
    pub tokens: Vec<(u64, TokenUsage)>,
    pub model: Option<String>,
    pub last_usage: Option<TokenUsage>,
    /// Always empty — the daemon does not tail subagent transcripts.
    pub subagents: Vec<serde_json::Value>,
}

/// One thing the bridge must do as a result of a frame. The transport turns
/// these into the workbench's existing events; nothing else is emitted.
#[derive(Debug, Clone, PartialEq)]
pub enum Emit {
    /// → `claude-timeline`
    Timeline(RemoteTimelinePayload),
    /// → `claude-hook-status` with a **host-namespaced** uuid.
    Hook { uuid: String, event: String },
    /// → `claude-session-closed`
    Closed { id: u64 },
}

/// How severe a [`Notice`] is. Mirrors the daemon's own levels so a daemon
/// notice can be passed through without being reinterpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

/// Something the user must be able to see. Loss (`Gap`), a daemon restart, a
/// daemon-side `Notice`, and a frame this workbench could not read all land
/// here — the rule being that the screen never goes quietly stale.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Notice {
    /// Monotonic within a host, so a UI can tell new from already-shown.
    pub seq: u64,
    pub level: NoticeLevel,
    pub message: String,
    /// The remote session this is about, when it is about one.
    pub session: Option<u64>,
    pub at_ms: u64,
}

/// The connection's state, as the UI says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Never connected / disconnected by the user.
    Idle,
    Connecting,
    /// Attached and receiving.
    Live,
    /// The observation window broke; the daemon is still running and we are
    /// retrying with the stored cursor.
    Reconnecting,
    /// Terminal — the user must act (bad protocol, rejected host key, auth).
    Failed,
}

/// How the last attach resumed. Shown so "이어받음" and "처음부터" are never
/// the same picture.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResumeOutcome {
    Fresh,
    Continued { from_seq: u64 },
    Gap { message: String },
}

/// One remote session as the UI lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionMeta {
    /// The id carried by `claude-timeline` / `claude-session-closed`.
    pub id: u64,
    pub key: String,
    /// `"<host_id>/<session_id>"` — the namespaced uuid.
    pub uuid: String,
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub label: Option<String>,
    pub state: String,
    pub started_at_ms: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    /// Set when the daemon recovered this session rather than starting it.
    pub adopted: Option<String>,
    /// `true` when the daemon sent a header without a body (a finished session);
    /// its timeline is fetchable with `cwcd timeline <addr>`, not lost.
    pub body_omitted: bool,
    pub turns: usize,
    pub items: usize,
    pub model: Option<String>,
    /// Context occupancy — the same number the local gauge shows.
    pub ctx_tokens: u64,
    pub last_title: Option<String>,
    pub last_hook: Option<String>,
    pub closed: bool,
}

/// Everything the minimal UI polls for. Deliberately a snapshot rather than a
/// new event kind: the timeline itself streams over `claude-timeline`, and a
/// connection's own state is small, so one command answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HostSnapshot {
    pub host_id: String,
    pub label: String,
    pub phase: Phase,
    /// Non-null once a `Hello` has been read.
    pub daemon: Option<DaemonInfo>,
    pub resume: Option<ResumeOutcome>,
    pub cursor: Option<String>,
    /// Why the last attempt ended, when it ended badly.
    pub last_error: Option<String>,
    pub attempts: u32,
    pub sessions: Vec<SessionMeta>,
    pub notices: Vec<Notice>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DaemonInfo {
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub os: String,
    pub epoch: String,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Session {
    id: u64,
    view: SessionView,
    /// Merged by `tool_call_id`, in first-seen order. Re-receiving an item is
    /// an idempotent replace, which is what makes snapshot/stream overlap
    /// harmless (the daemon's contract says so explicitly).
    items: Vec<TimelineItem>,
    turns: BTreeMap<u64, String>,
    model: Option<String>,
    last_usage: Option<TokenUsage>,
    body_omitted: bool,
    last_hook: Option<String>,
    closed: bool,
}

impl Session {
    fn new(id: u64, view: SessionView) -> Self {
        let closed = view.state == SessionState::Exited;
        Session {
            id,
            view,
            items: Vec::new(),
            turns: BTreeMap::new(),
            model: None,
            last_usage: None,
            body_omitted: false,
            last_hook: None,
            closed,
        }
    }

    fn merge_items(&mut self, incoming: Vec<TimelineItem>) {
        for item in incoming {
            match self
                .items
                .iter_mut()
                .find(|e| e.tool_call_id == item.tool_call_id)
            {
                Some(slot) => *slot = item,
                None => self.items.push(item),
            }
        }
    }

    fn payload(&self) -> RemoteTimelinePayload {
        let mut items = self.items.clone();
        cap_content(&mut items);
        RemoteTimelinePayload {
            id: self.id,
            items,
            turns: self.turns.iter().map(|(k, v)| (*k, v.clone())).collect(),
            answers: Vec::new(),
            dates: Vec::new(),
            tokens: Vec::new(),
            model: self.model.clone(),
            last_usage: self.last_usage,
            subagents: Vec::new(),
        }
    }

    fn meta(&self, host_id: &str) -> SessionMeta {
        SessionMeta {
            id: self.id,
            key: self.view.key.to_string(),
            uuid: namespaced_uuid(host_id, &self.view.session_id),
            session_id: self.view.session_id.clone(),
            agent: match self.view.agent {
                AgentKind::Claude => "claude",
                AgentKind::Codex => "codex",
                AgentKind::Unknown => "unknown",
            }
            .into(),
            cwd: self.view.cwd.display().to_string(),
            label: self.view.label.clone(),
            state: match self.view.state {
                SessionState::Starting => "starting",
                SessionState::Running => "running",
                SessionState::Exited => "exited",
                SessionState::Unknown => "unknown",
            }
            .into(),
            started_at_ms: self.view.started_at_ms,
            exit_code: self.view.exit_code,
            signal: self.view.signal.clone(),
            adopted: self.view.adopted.as_ref().map(|a| {
                match a.outcome {
                    AdoptionOutcome::Reattached => "reattached",
                    AdoptionOutcome::ProcessGone => "process_gone",
                    AdoptionOutcome::TranscriptMissing => "transcript_missing",
                    AdoptionOutcome::Lost => "lost",
                    AdoptionOutcome::IdInUse => "id_in_use",
                    AdoptionOutcome::Unknown => "unknown",
                }
                .to_string()
            }),
            body_omitted: self.body_omitted,
            turns: self.turns.len(),
            items: self.items.len(),
            model: self.model.clone(),
            ctx_tokens: self
                .last_usage
                .map(|u| u.input + u.cache_read + u.cache_creation)
                .unwrap_or(0),
            last_title: self.items.last().map(|i| i.title.clone()),
            last_hook: self.last_hook.clone(),
            closed: self.closed,
        }
    }
}

/// UTF-8-boundary-preserving truncation, flagged. Same rule as the local
/// payload's `cap_content`.
fn cap_content(items: &mut [TimelineItem]) {
    for it in items.iter_mut() {
        if let Some(ct) = &it.content_text {
            if ct.len() > CONTENT_CAP {
                let mut n = CONTENT_CAP;
                while n > 0 && !ct.is_char_boundary(n) {
                    n -= 1;
                }
                it.content_text = Some(ct[..n].to_string());
                it.content_truncated = true;
            }
        }
    }
}

/// `"<host_id>/<session_id>"`. See the module docs on namespaces.
pub fn namespaced_uuid(host_id: &str, session_id: &str) -> String {
    format!("{host_id}/{session_id}")
}

/// Bound on retained notices — the newest are kept. A host that is flapping
/// must not grow this list without limit, and the count of what was dropped is
/// not interesting: the newest notice already says the connection is unhappy.
const MAX_NOTICES: usize = 200;

/// The refusal that must stop the retry loop rather than feed it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fatal(pub String);

/// One host's view state. Fed frames by [`Self::apply`]; never blocks, never
/// does I/O.
#[derive(Debug)]
pub struct Host {
    pub host_id: String,
    pub label: String,
    phase: Phase,
    daemon: Option<DaemonInfo>,
    epoch: Option<String>,
    cursor: Option<String>,
    resume: Option<ResumeOutcome>,
    last_error: Option<String>,
    attempts: u32,
    /// Insertion order is the daemon's order (spawn order), which is what the
    /// list should show.
    sessions: Vec<Session>,
    notices: Vec<Notice>,
    notice_seq: u64,
    /// Event kinds already reported as unknown, so a newer daemon streaming a
    /// kind we do not know says so **once** instead of once per event.
    reported_unknown: Vec<String>,
    now_ms: fn() -> u64,
}

impl Host {
    pub fn new(host_id: impl Into<String>, label: impl Into<String>) -> Self {
        Self::with_clock(host_id, label, now_ms)
    }

    pub fn with_clock(host_id: impl Into<String>, label: impl Into<String>, now: fn() -> u64) -> Self {
        Host {
            host_id: host_id.into(),
            label: label.into(),
            phase: Phase::Idle,
            daemon: None,
            epoch: None,
            cursor: None,
            resume: None,
            last_error: None,
            attempts: 0,
            sessions: Vec::new(),
            notices: Vec::new(),
            notice_seq: 0,
            reported_unknown: Vec::new(),
            now_ms: now,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// The cursor to resume from, if any. Handed to `cwcd stream --cursor`
    /// verbatim; it is the daemon's own string.
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// The stream's epoch — the half of a [`proto::session_addr`] the daemon
    /// never puts on a `SessionView`.
    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }

    /// Compose the address of a session for a short command
    /// (`cwcd timeline <addr>`). `None` when no `Hello` has been read yet, or
    /// the key is not one this host is showing — a guess would aim at whatever
    /// holds that key now.
    pub fn addr_of(&self, id: u64) -> Option<String> {
        let epoch = self.epoch.as_deref()?;
        let s = self.sessions.iter().find(|s| s.id == id)?;
        Some(proto::session_addr(epoch, &s.view.key))
    }

    pub fn set_phase(&mut self, phase: Phase) {
        self.phase = phase;
    }

    pub fn note_attempt(&mut self) {
        self.attempts = self.attempts.saturating_add(1);
    }

    /// Record a transport-level failure and show it. Never silent: a connection
    /// that stops without a reason on screen is the failure mode this whole
    /// step exists to avoid.
    pub fn fail(&mut self, phase: Phase, reason: impl Into<String>) {
        let reason = reason.into();
        self.phase = phase;
        self.last_error = Some(reason.clone());
        self.push_notice(NoticeLevel::Error, reason, None);
    }

    pub fn push_notice(&mut self, level: NoticeLevel, message: impl Into<String>, session: Option<u64>) {
        self.notice_seq += 1;
        self.notices.push(Notice {
            seq: self.notice_seq,
            level,
            message: message.into(),
            session,
            at_ms: (self.now_ms)(),
        });
        if self.notices.len() > MAX_NOTICES {
            let excess = self.notices.len() - MAX_NOTICES;
            self.notices.drain(..excess);
        }
    }

    pub fn snapshot(&self) -> HostSnapshot {
        HostSnapshot {
            host_id: self.host_id.clone(),
            label: self.label.clone(),
            phase: self.phase,
            daemon: self.daemon.clone(),
            resume: self.resume.clone(),
            cursor: self.cursor.clone(),
            last_error: self.last_error.clone(),
            attempts: self.attempts,
            sessions: self.sessions.iter().map(|s| s.meta(&self.host_id)).collect(),
            notices: self.notices.clone(),
        }
    }

    /// Apply one decoded frame.
    ///
    /// `Err(Fatal)` means *do not retry*: the daemon is one this workbench
    /// cannot read, and reconnecting would only produce the same refusal in a
    /// loop.
    pub fn apply(&mut self, frame: Frame) -> Result<Vec<Emit>, Fatal> {
        match frame {
            Frame::Hello(h) => self.on_hello(h),
            Frame::Snapshot(s) => Ok(self.on_snapshot(s)),
            Frame::Gap(g) => {
                self.on_gap(g);
                Ok(Vec::new())
            }
            Frame::Event(e) => Ok(self.on_event(e)),
            Frame::Heartbeat(h) => {
                self.cursor = Some(h.cursor.to_string());
                Ok(Vec::new())
            }
            Frame::Unknown { frame } => {
                // No position to advance past — the cursor stays put and the
                // frame will be replayed on resume. Saying so once is better
                // than either looping on it or dropping it.
                self.report_unknown(format!("frame:{frame}"), format!(
                    "이 워크벤치가 모르는 프레임 종류 '{frame}' 를 데몬이 보냈습니다 — 무시했습니다(원격 데몬이 더 새 버전일 수 있습니다)."
                ));
                Ok(Vec::new())
            }
        }
    }

    /// A line the decoder could not read at all. Reported, and the cursor is
    /// deliberately left where it was.
    pub fn on_undecodable(&mut self, reason: String) {
        self.push_notice(
            NoticeLevel::Warn,
            format!("데몬이 보낸 줄을 읽지 못했습니다 — {reason}"),
            None,
        );
    }

    fn report_unknown(&mut self, tag: String, message: String) {
        if self.reported_unknown.contains(&tag) {
            return;
        }
        self.reported_unknown.push(tag);
        self.push_notice(NoticeLevel::Warn, message, None);
    }

    fn on_hello(&mut self, h: Hello) -> Result<Vec<Emit>, Fatal> {
        if h.protocol != proto::PROTOCOL {
            let msg = format!(
                "원격 데몬의 프로토콜 v{}는 이 워크벤치(v{})가 읽을 수 없습니다 — 연결하지 않았습니다.",
                h.protocol,
                proto::PROTOCOL
            );
            self.fail(Phase::Failed, msg.clone());
            return Err(Fatal(msg));
        }

        let mut out = Vec::new();
        // A new incarnation invalidates every key and the cursor with them —
        // the daemon's contract requires a consumer to throw its keys away on a
        // changed epoch, and this is the one place that can do it.
        if let Some(prev) = &self.epoch {
            if *prev != h.epoch {
                let n = self.sessions.len();
                for s in self.sessions.drain(..) {
                    out.push(Emit::Closed { id: s.id });
                }
                self.cursor = None;
                self.push_notice(
                    NoticeLevel::Warn,
                    format!(
                        "원격 데몬이 다시 시작되었습니다 — 이전 세션 {n}개의 주소를 버리고 새로 받습니다."
                    ),
                    None,
                );
            }
        }
        self.epoch = Some(h.epoch.clone());
        self.daemon = Some(DaemonInfo {
            version: h.daemon_version.clone(),
            hostname: h.host.hostname.clone(),
            user: h.host.user.clone(),
            os: h.host.os.clone(),
            epoch: h.epoch.clone(),
        });
        self.phase = Phase::Live;
        self.last_error = None;
        self.resume = Some(match h.resume {
            Resume::Continued { from_seq } => ResumeOutcome::Continued { from_seq },
            Resume::Fresh => ResumeOutcome::Fresh,
            // A resume kind this workbench does not know is treated as the
            // conservative one: a snapshot is coming and will replace state.
            Resume::Gap | Resume::Unknown => ResumeOutcome::Gap {
                message: "데몬이 커서를 이어받지 못해 전체 상태를 다시 받습니다.".into(),
            },
        });
        Ok(out)
    }

    fn on_gap(&mut self, g: Gap) {
        let lost = match g.lost_events {
            Some(n) => format!("{n}건"),
            None => "일부".into(),
        };
        self.resume = Some(ResumeOutcome::Gap { message: g.message.clone() });
        self.push_notice(
            NoticeLevel::Warn,
            format!(
                "원격 이벤트 {lost}을(를) 받지 못했습니다({:?}) — 전체 상태를 다시 받습니다. {}",
                g.reason, g.message
            ),
            None,
        );
    }

    fn on_snapshot(&mut self, s: Snapshot) -> Vec<Emit> {
        let mut out = Vec::new();
        let mut kept: Vec<Session> = Vec::new();

        for snap in s.sessions {
            let SessionSnapshot {
                session: view,
                items,
                items_omitted,
                model,
                last_usage,
                turns,
            } = snap;
            // Reuse the existing id when we already knew this key, so a resync
            // does not make a viewer think its session was replaced.
            let mut sess = match self.take_by_key(&view.key) {
                Some(mut prev) => {
                    prev.view = view;
                    prev
                }
                None => Session::new(alloc_remote_id(), view),
            };
            // A snapshot is the authority: replace rather than merge, so a
            // session whose items were pruned on the daemon does not keep a
            // ghost copy here.
            sess.items = items;
            sess.turns = turns;
            sess.model = model;
            sess.last_usage = last_usage;
            sess.body_omitted = items_omitted;
            sess.closed = sess.view.state == SessionState::Exited;
            if items_omitted {
                self.notice_seq += 1;
                self.notices.push(Notice {
                    seq: self.notice_seq,
                    level: NoticeLevel::Info,
                    message: format!(
                        "종료된 세션 {}의 본문은 스냅샷에 실리지 않았습니다 — 필요하면 원격에서 따로 가져옵니다.",
                        sess.view.key
                    ),
                    session: Some(sess.id),
                    at_ms: (self.now_ms)(),
                });
            }
            out.push(Emit::Timeline(sess.payload()));
            kept.push(sess);
        }

        // Anything the daemon no longer lists is gone (pruned finished
        // sessions, or a session from a previous incarnation). Say so instead
        // of leaving a stale row on screen.
        for gone in self.sessions.drain(..) {
            out.push(Emit::Closed { id: gone.id });
        }
        self.sessions = kept;
        self.cursor = Some(s.cursor.to_string());
        out
    }

    fn take_by_key(&mut self, key: &SessionKey) -> Option<Session> {
        let i = self.sessions.iter().position(|s| s.view.key == *key)?;
        Some(self.sessions.remove(i))
    }

    fn index_of(&self, key: &SessionKey) -> Option<usize> {
        self.sessions.iter().position(|s| s.view.key == *key)
    }

    fn on_event(&mut self, env: Envelope) -> Vec<Emit> {
        let mut out = Vec::new();
        match env.event {
            Event::SessionSpawned { session } | Event::SessionAdopted { session } => {
                let key = session.key.clone();
                match self.index_of(&key) {
                    Some(i) => self.sessions[i].view = session,
                    None => {
                        let s = Session::new(alloc_remote_id(), session);
                        self.sessions.push(s);
                    }
                }
                let i = self.index_of(&key).expect("just inserted");
                out.push(Emit::Timeline(self.sessions[i].payload()));
            }
            Event::TranscriptLocated { key, path, .. } => {
                if let Some(i) = self.index_of(&key) {
                    self.sessions[i].view.transcript = Some(path);
                    if self.sessions[i].view.state == SessionState::Starting {
                        self.sessions[i].view.state = SessionState::Running;
                    }
                }
            }
            Event::TimelineDelta {
                key,
                items,
                model,
                last_usage,
                turns,
                ..
            } => {
                if let Some(i) = self.index_of(&key) {
                    let s = &mut self.sessions[i];
                    s.merge_items(items);
                    s.turns.extend(turns);
                    if model.is_some() {
                        s.model = model;
                    }
                    if last_usage.is_some() {
                        s.last_usage = last_usage;
                    }
                    // A delta arriving means the body is being read again, so
                    // the "header only" flag no longer describes this session.
                    s.body_omitted = false;
                    out.push(Emit::Timeline(s.payload()));
                } else {
                    // A delta for a session we never saw announced. The snapshot
                    // that follows any gap would have carried it, so this means
                    // the stream is inconsistent — say so rather than drop it.
                    self.push_notice(
                        NoticeLevel::Warn,
                        format!("모르는 세션 {key}의 타임라인 변경을 받았습니다 — 무시했습니다."),
                        None,
                    );
                }
            }
            Event::Hook { key, hook_event, .. } => {
                if let Some(i) = self.index_of(&key) {
                    self.sessions[i].last_hook = Some(hook_event.clone());
                    let uuid = namespaced_uuid(&self.host_id, &self.sessions[i].view.session_id);
                    out.push(Emit::Hook { uuid, event: hook_event });
                }
            }
            Event::SessionExited {
                key,
                exit_code,
                signal,
                ..
            } => {
                if let Some(i) = self.index_of(&key) {
                    let s = &mut self.sessions[i];
                    s.view.state = SessionState::Exited;
                    s.view.exit_code = exit_code;
                    s.view.signal = signal;
                    s.closed = true;
                    // Final content first, then the end marker: a consumer that
                    // stops listening on `closed` must already have the last of
                    // it.
                    out.push(Emit::Timeline(s.payload()));
                    out.push(Emit::Closed { id: s.id });
                }
            }
            Event::Notice { level, key, message } => {
                let session = key.and_then(|k| self.index_of(&k)).map(|i| self.sessions[i].id);
                let level = match level {
                    proto::NoticeLevel::Info => NoticeLevel::Info,
                    proto::NoticeLevel::Warn => NoticeLevel::Warn,
                    // An unknown level is shown at the loudest of the ones we
                    // have: a notice we cannot grade is not one to hide.
                    proto::NoticeLevel::Error | proto::NoticeLevel::Unknown => NoticeLevel::Error,
                };
                self.push_notice(level, message, session);
            }
            Event::Unknown { event } => {
                self.report_unknown(
                    format!("event:{event}"),
                    format!(
                        "이 워크벤치가 모르는 이벤트 '{event}' 를 데몬이 보냈습니다 — 흘려보냈습니다(원격 데몬이 더 새 버전일 수 있습니다)."
                    ),
                );
            }
        }
        // The envelope's own cursor, taken verbatim — the daemon carries it
        // explicitly so a consumer never has to synthesise one. Advanced only
        // after the event has been applied.
        self.cursor = Some(env.cursor.to_string());
        out
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::proto::decode_frame;

    fn host() -> Host {
        Host::with_clock("h1", "테스트 호스트", || 1_000)
    }

    fn hello(epoch: &str, resume: &str) -> Frame {
        decode_frame(&format!(
            r#"{{"frame":"hello","protocol":2,"daemon_version":"0.1.0","host":{{"host_id":"h","hostname":"box","user":"jun","os":"linux"}},"epoch":"{epoch}","resume":{resume},"oldest_seq":1,"next_seq":1}}"#
        ))
        .unwrap()
    }

    fn spawned(seq: u64, epoch: &str, key: &str, uuid: &str) -> Frame {
        decode_frame(&format!(
            r#"{{"frame":"event","seq":{seq},"cursor":"{epoch}:{seq}","ts_ms":1,"event":{{"event":"session_spawned","session":{{"key":"{key}","session_id":"{uuid}","agent":"claude","cwd":"/w","pid":1,"state":"starting","started_at_ms":5,"argv":[],"timeline_len":0}}}}}}"#
        ))
        .unwrap()
    }

    fn delta(seq: u64, epoch: &str, key: &str, uuid: &str, body: &str) -> Frame {
        decode_frame(&format!(
            r#"{{"frame":"event","seq":{seq},"cursor":"{epoch}:{seq}","ts_ms":1,"event":{{"event":"timeline_delta","key":"{key}","session_id":"{uuid}",{body}}}}}"#
        ))
        .unwrap()
    }

    fn item(tcid: &str, title: &str, text: Option<&str>) -> String {
        serde_json::json!({
            "session_id": "s", "tool_call_id": tcid, "turn": 1, "seq": 1,
            "kind": "execute", "title": title, "locations": [], "project_label": null,
            "diffs": [], "content_text": text, "raw_input": null,
            "agent_status": "completed", "write_status": "none", "revision": 1
        })
        .to_string()
    }

    #[test]
    fn a_remote_id_can_never_be_a_local_one() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        let id = h.snapshot().sessions[0].id;
        assert!(
            id >= REMOTE_ID_BASE,
            "remote ids must start above every reachable local SessionManager id"
        );
        // …and two hosts draw from the same allocator, so they cannot collide.
        let mut g = Host::with_clock("h2", "b", || 1);
        g.apply(hello("e2", r#"{"kind":"fresh"}"#)).unwrap();
        g.apply(spawned(1, "e2", "k1", "u1")).unwrap();
        assert_ne!(g.snapshot().sessions[0].id, id, "same key on two hosts, different id");
    }

    #[test]
    fn a_uuid_is_namespaced_by_host_so_a_local_session_cannot_be_hit() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "5b6f21e0")).unwrap();
        let out = h
            .apply(decode_frame(
                r#"{"frame":"event","seq":2,"cursor":"e1:2","ts_ms":1,"event":{"event":"hook","key":"k1","session_id":"5b6f21e0","hook_event":"Stop"}}"#,
            )
            .unwrap())
            .unwrap();
        assert_eq!(
            out,
            vec![Emit::Hook { uuid: "h1/5b6f21e0".into(), event: "Stop".into() }],
            "a bare uuid could name a local session; the host prefix makes that impossible"
        );
    }

    #[test]
    fn deltas_merge_by_tool_call_id_and_accumulate_turns() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();

        let out = h
            .apply(delta(
                2,
                "e1",
                "k1",
                "u1",
                &format!(r#""items":[{}],"turns":{{"1":"first"}}"#, item("t1", "run a", None)),
            ))
            .unwrap();
        let Emit::Timeline(p) = &out[0] else { panic!() };
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.turns, vec![(1, "first".to_string())]);

        // Same tool_call_id again = an update, not a second row.
        let out = h
            .apply(delta(
                3,
                "e1",
                "k1",
                "u1",
                &format!(
                    r#""items":[{},{}],"turns":{{"2":"second"}},"model":"claude-opus-5","last_usage":{{"input":1,"output":2,"cache_read":3,"cache_creation":4}}"#,
                    item("t1", "run a (done)", None),
                    item("t2", "run b", None)
                ),
            ))
            .unwrap();
        let Emit::Timeline(p) = &out[0] else { panic!() };
        assert_eq!(p.items.len(), 2, "re-sending an item must be idempotent");
        assert_eq!(p.items[0].title, "run a (done)");
        assert_eq!(p.turns, vec![(1, "first".into()), (2, "second".into())]);
        assert_eq!(p.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(p.last_usage.unwrap().cache_read, 3);
        // The gaps this bridge cannot fill are empty, not invented.
        assert!(p.answers.is_empty() && p.dates.is_empty() && p.tokens.is_empty());
        assert!(p.subagents.is_empty());

        let meta = &h.snapshot().sessions[0];
        assert_eq!((meta.items, meta.turns), (2, 2));
        assert_eq!(meta.ctx_tokens, 1 + 3 + 4);
        assert_eq!(meta.last_title.as_deref(), Some("run b"));
    }

    #[test]
    fn a_late_delta_for_an_unknown_session_is_reported_not_dropped() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        let out = h.apply(delta(2, "e1", "k9", "u9", r#""items":[]"#)).unwrap();
        assert!(out.is_empty());
        let n = h.snapshot().notices;
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].level, NoticeLevel::Warn);
        assert!(n[0].message.contains("k9"), "{}", n[0].message);
    }

    #[test]
    fn exit_emits_the_final_content_before_the_end_marker() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        let id = h.snapshot().sessions[0].id;
        let out = h
            .apply(
                decode_frame(
                    r#"{"frame":"event","seq":7,"cursor":"e1:7","ts_ms":1,"event":{"event":"session_exited","key":"k1","session_id":"u1","exit_code":0}}"#,
                )
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(out[0], Emit::Timeline(_)), "content must land before the marker");
        assert_eq!(out[1], Emit::Closed { id });
        assert!(h.snapshot().sessions[0].closed);
        assert_eq!(h.snapshot().sessions[0].state, "exited");
    }

    #[test]
    fn a_restarted_daemon_invalidates_every_key_and_the_cursor() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        let old_id = h.snapshot().sessions[0].id;
        assert_eq!(h.cursor(), Some("e1:1"));

        let out = h.apply(hello("e2", r#"{"kind":"fresh"}"#)).unwrap();
        assert_eq!(out, vec![Emit::Closed { id: old_id }], "old rows must not linger");
        assert_eq!(h.cursor(), None, "a cursor from a dead incarnation must never be resent");
        assert_eq!(h.epoch(), Some("e2"));
        assert!(h.snapshot().notices.iter().any(|n| n.message.contains("다시 시작")));

        // The same key in the new incarnation is a different session.
        h.apply(spawned(1, "e2", "k1", "u2")).unwrap();
        assert_ne!(h.snapshot().sessions[0].id, old_id);
    }

    #[test]
    fn an_address_pairs_the_key_with_the_streams_epoch() {
        let mut h = host();
        assert_eq!(h.addr_of(REMOTE_ID_BASE), None, "no epoch yet = no address, not a guess");
        h.apply(hello("0c44fa05", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "0c44fa05", "k3", "u1")).unwrap();
        let id = h.snapshot().sessions[0].id;
        assert_eq!(h.addr_of(id).as_deref(), Some("0c44fa05:k3"));
        assert_eq!(h.addr_of(id + 99), None, "an unknown id has no address");
    }

    #[test]
    fn a_snapshot_replaces_state_and_closes_what_the_daemon_dropped() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        h.apply(spawned(2, "e1", "k2", "u2")).unwrap();
        let (id1, id2) = {
            let s = h.snapshot();
            (s.sessions[0].id, s.sessions[1].id)
        };

        // A resync that lists only k1 — k2 was pruned on the daemon.
        let snap = r#"{"frame":"snapshot","cursor":"e1:9","taken_at_ms":1,"sessions":[{"key":"k1","session_id":"u1","agent":"claude","cwd":"/w","state":"exited","started_at_ms":1,"argv":[],"timeline_len":3,"items":[],"items_omitted":true,"turns":{}}]}"#;
        let out = h.apply(decode_frame(snap).unwrap()).unwrap();
        assert!(out.contains(&Emit::Closed { id: id2 }), "a pruned session must not linger");
        assert_eq!(h.cursor(), Some("e1:9"));
        let s = h.snapshot();
        assert_eq!(s.sessions.len(), 1);
        assert_eq!(s.sessions[0].id, id1, "the same key keeps its id across a resync");
        assert!(s.sessions[0].body_omitted, "\"header only\" is not \"nothing happened\"");
        assert!(s.notices.iter().any(|n| n.session == Some(id1)));
    }

    #[test]
    fn a_gap_is_shown_before_the_resync_replaces_the_screen() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"gap"}"#)).unwrap();
        h.apply(
            decode_frame(
                r#"{"frame":"gap","reason":"evicted","requested_cursor":"e1:2","oldest_available_seq":9,"lost_events":6,"message":"the ring moved past your cursor"}"#,
            )
            .unwrap(),
        )
        .unwrap();
        let s = h.snapshot();
        let n = s.notices.last().unwrap();
        assert_eq!(n.level, NoticeLevel::Warn);
        assert!(n.message.contains("6건"), "{}", n.message);
        assert!(matches!(s.resume, Some(ResumeOutcome::Gap { .. })));
    }

    #[test]
    fn a_continued_resume_says_so_and_keeps_the_screen() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        let out = h.apply(hello("e1", r#"{"kind":"continued","from_seq":2}"#)).unwrap();
        assert!(out.is_empty(), "an exact continuation must not close anything");
        assert_eq!(h.snapshot().resume, Some(ResumeOutcome::Continued { from_seq: 2 }));
        assert_eq!(h.snapshot().sessions.len(), 1);
        assert_eq!(h.phase(), Phase::Live);
    }

    #[test]
    fn an_unreadable_protocol_stops_the_retry_loop() {
        let mut h = host();
        let err = h
            .apply(
                decode_frame(
                    r#"{"frame":"hello","protocol":7,"daemon_version":"9","host":{"host_id":"h","hostname":"b","user":"u","os":"linux"},"epoch":"e","resume":{"kind":"fresh"},"oldest_seq":1,"next_seq":1}"#,
                )
                .unwrap(),
            )
            .unwrap_err();
        assert!(err.0.contains("v7"), "{}", err.0);
        assert_eq!(h.phase(), Phase::Failed);
        assert!(h.snapshot().last_error.is_some());
    }

    #[test]
    fn an_unknown_event_advances_the_cursor_and_is_reported_once() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        for seq in 2..6 {
            h.apply(
                decode_frame(&format!(
                    r#"{{"frame":"event","seq":{seq},"cursor":"e1:{seq}","ts_ms":1,"event":{{"event":"quota","left":3}}}}"#
                ))
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(h.cursor(), Some("e1:5"), "an unknown event must not stall the cursor");
        assert_eq!(
            h.snapshot().notices.len(),
            1,
            "one report per kind, not one per event"
        );
    }

    #[test]
    fn an_unknown_frame_does_not_move_the_cursor() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        h.apply(Frame::Unknown { frame: "usage".into() }).unwrap();
        assert_eq!(h.cursor(), Some("e1:1"), "no position to advance past");
        assert_eq!(h.snapshot().notices.len(), 1);
    }

    #[test]
    fn long_item_text_is_shortened_on_a_char_boundary_and_flagged() {
        let mut h = host();
        h.apply(hello("e1", r#"{"kind":"fresh"}"#)).unwrap();
        h.apply(spawned(1, "e1", "k1", "u1")).unwrap();
        let long = "가".repeat(CONTENT_CAP);
        let out = h
            .apply(delta(
                2,
                "e1",
                "k1",
                "u1",
                &format!(r#""items":[{}]"#, item("t1", "big", Some(&long))),
            ))
            .unwrap();
        let Emit::Timeline(p) = &out[0] else { panic!() };
        assert!(p.items[0].content_truncated);
        let ct = p.items[0].content_text.as_deref().unwrap();
        assert!(ct.len() <= CONTENT_CAP);
        assert!(ct.chars().all(|c| c == '가'), "truncation must not split a character");
    }

    /// The `claude-timeline` payload the frontend reads has one shape. This
    /// pins the remote producer's key set against a copy of the local
    /// producer's (`ClaudeTimelinePayload`, src-tauri/.../claude/timeline.rs) —
    /// if a field is ever added there, this fails rather than the remote panel
    /// quietly rendering with a missing field.
    #[test]
    fn remote_payload_shape() {
        let p = RemoteTimelinePayload {
            id: 1,
            items: vec![],
            turns: vec![],
            answers: vec![],
            dates: vec![],
            tokens: vec![],
            model: None,
            last_usage: None,
            subagents: vec![],
        };
        let v = serde_json::to_value(&p).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "answers", "dates", "id", "items", "last_usage", "model", "subagents", "tokens",
                "turns"
            ]
        );
    }

    #[test]
    fn a_failure_is_always_visible() {
        let mut h = host();
        h.fail(Phase::Reconnecting, "ssh 연결이 끊겼습니다");
        let s = h.snapshot();
        assert_eq!(s.phase, Phase::Reconnecting);
        assert_eq!(s.last_error.as_deref(), Some("ssh 연결이 끊겼습니다"));
        assert_eq!(s.notices.last().unwrap().level, NoticeLevel::Error);
    }

    #[test]
    fn notices_are_bounded_keeping_the_newest() {
        let mut h = host();
        for i in 0..(MAX_NOTICES + 25) {
            h.push_notice(NoticeLevel::Info, format!("n{i}"), None);
        }
        let n = h.snapshot().notices;
        assert_eq!(n.len(), MAX_NOTICES);
        assert_eq!(n.last().unwrap().message, format!("n{}", MAX_NOTICES + 24));
        assert!(n.first().unwrap().seq > 1, "the oldest were dropped, not the newest");
    }
}
