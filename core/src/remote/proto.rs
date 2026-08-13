//! The client daemon's wire contract, **as a consumer reads it**.
//!
//! This is a mirror of `cwc-core::contract` (protocol v2) rather than a shared
//! type: the daemon lives in its own repository and depends on *this* crate for
//! [`TimelineItem`]/[`TokenUsage`], so a dependency back the other way would be
//! a cycle. Mirroring is what a consumer of a wire format does anyway — the two
//! sides are pinned by [`PROTOCOL`] and by the golden-line tests at the bottom,
//! which are copied verbatim from a real daemon stream.
//!
//! Three decoding rules, all of them about **not going quiet**:
//!
//! 1. **An unknown frame or event kind is a value, not a parse error.** A daemon
//!    newer than this workbench will send frames this file has never heard of.
//!    Refusing the whole line would drop the envelope's `seq` with it — and the
//!    cursor would then either stall (replaying the same unknown line forever)
//!    or skip silently. So the tag is read first and an unrecognised one decodes
//!    to [`Frame::Unknown`] / [`Event::Unknown`], which still carries its
//!    position and can be reported to the user.
//! 2. **Unknown *fields* are ignored** (serde's default), which is what makes an
//!    additive daemon change compatible. [`PROTOCOL`] is the guard for the
//!    non-additive kind. A field the **producer always writes**, on the other
//!    hand, is required here too: `#[serde(default)]` on such a field turns "the
//!    daemon sent something this consumer could not read" into "the daemon said
//!    zero / nothing", which is the silent-staleness failure this module exists
//!    to prevent. Only fields the producer genuinely omits
//!    (`skip_serializing_if`) carry a default — and where `None` means *no
//!    change* (`model`, `last_usage`), that is the meaning the bridge preserves.
//! 3. **A [`SessionKey`] is a name, never a number.** It is kept as the string
//!    the daemon sent (`"k7"`), validated on the way in, and never ordered or
//!    incremented. The same goes for [`Cursor`], which is passed back verbatim.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::timeline::{TimelineItem, TokenUsage};

/// The one protocol version this workbench understands. A [`Hello`] carrying
/// anything else is refused rather than guessed at — the daemon's own contract
/// says a consumer is expected to do exactly that.
pub const PROTOCOL: u32 = 2;

// ---------------------------------------------------------------------------
// Names (never arithmetic)
// ---------------------------------------------------------------------------

/// A session's name inside one daemon incarnation — the wire string `"k<n>"`.
///
/// Stored as the string, not the number, on purpose: the daemon's contract
/// says a key is opaque and must not be compared for order or incremented, and
/// a `u64` in this position is an invitation to do both. `k0` is refused so a
/// defaulted value can never name a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct SessionKey(String);

impl SessionKey {
    pub fn parse(s: &str) -> Option<Self> {
        let n = s.strip_prefix('k')?;
        let v: u64 = n.parse().ok()?;
        if v == 0 {
            return None;
        }
        Some(SessionKey(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for SessionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SessionKey {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        SessionKey::parse(&s)
            .ok_or_else(|| serde::de::Error::custom("not a session key (expected \"k<n>\", n >= 1)"))
    }
}

/// A consumer's position in the stream — `"<epoch>:<seq>"`.
///
/// Kept as the daemon's own string and handed back unchanged on resume. The
/// `seq` half is parsed only so the bridge can tell "moved forward" from "went
/// backwards" in a log line; nothing is ever synthesised from the parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor(String);

impl Cursor {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The daemon incarnation this cursor belongs to.
    pub fn epoch(&self) -> &str {
        self.0.rsplit_once(':').map(|(e, _)| e).unwrap_or(&self.0)
    }

    pub fn seq(&self) -> u64 {
        self.0
            .rsplit_once(':')
            .and_then(|(_, s)| s.parse().ok())
            .unwrap_or(0)
    }
}

impl std::fmt::Display for Cursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Cursor {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let (epoch, seq) = s
            .rsplit_once(':')
            .ok_or_else(|| serde::de::Error::custom("malformed cursor"))?;
        if epoch.is_empty() || seq.parse::<u64>().is_err() {
            return Err(serde::de::Error::custom("malformed cursor"));
        }
        Ok(Cursor(s))
    }
}

impl Serialize for Cursor {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

/// Where a command is aimed: `"<epoch>:k<n>"`.
///
/// The workbench never receives one of these — the daemon puts a bare
/// [`SessionKey`] in every event and in `SessionView`, and the epoch lives on
/// the stream's [`Hello`]. Composing it is therefore the consumer's job, and
/// [`session_addr`] is the single place that does it (see the module docs of
/// `crate::remote::link` for why that is the right side of the wire for it).
pub fn session_addr(epoch: &str, key: &SessionKey) -> String {
    format!("{epoch}:{key}")
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/// One NDJSON line of the daemon's event stream.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello(Hello),
    Snapshot(Snapshot),
    Gap(Gap),
    Event(Envelope),
    Heartbeat(Heartbeat),
    /// A frame kind this workbench does not know. Reported, never dropped in
    /// silence — but it carries no position, so the cursor does not move.
    Unknown { frame: String },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub daemon_version: String,
    pub host: HostInfo,
    pub epoch: String,
    pub resume: Resume,
    pub oldest_seq: u64,
    pub next_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resume {
    /// No cursor was supplied — a first-time subscription. A snapshot follows.
    Fresh,
    /// The cursor was honoured exactly and **nothing was lost**; no snapshot
    /// follows, and the consumer's state stays valid.
    Continued { from_seq: u64 },
    /// The cursor could not be honoured. A [`Gap`] and a [`Snapshot`] follow.
    Gap,
    /// Forward compatibility: a resume outcome this workbench does not know is
    /// treated as the conservative one (resync) by `crate::remote::link`.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HostInfo {
    pub host_id: String,
    pub hostname: String,
    pub user: String,
    pub os: String,
    #[serde(default)]
    pub claude_home: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Snapshot {
    pub cursor: Cursor,
    pub sessions: Vec<SessionSnapshot>,
    #[serde(default)]
    pub taken_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionSnapshot {
    #[serde(flatten)]
    pub session: SessionView,
    /// Required: the producer always writes it (`items_omitted` is how an empty
    /// body is *stated*). Defaulting it here would make a snapshot this
    /// workbench cannot read look like a host with nothing on it.
    pub items: Vec<TimelineItem>,
    /// The body (`items` *and* `turns`) was left out on purpose — a finished
    /// session. Not the same as "this session did nothing", which is why the
    /// flag exists; the body is fetchable with `cwcd timeline <addr>` for as
    /// long as the daemon still holds the record.
    #[serde(default)]
    pub items_omitted: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub last_usage: Option<TokenUsage>,
    /// Required, for the same reason as [`Self::items`] — the body's other half.
    #[serde(with = "turn_map")]
    pub turns: BTreeMap<u64, String>,
    /// The assistant's side of each turn, and what each turn cost.
    ///
    /// Optional here, unlike `turns`, because the daemon omits an empty map
    /// (`skip_serializing_if`) — so "absent" and "empty" are the same statement
    /// on this wire and defaulting cannot hide a producer that stopped writing.
    /// A daemon older than R2b simply never sends them, which is exactly the
    /// state this replaces.
    #[serde(default, with = "turn_map")]
    pub answers: BTreeMap<u64, String>,
    #[serde(default, with = "turn_map")]
    pub dates: BTreeMap<u64, String>,
    #[serde(default, with = "turn_map")]
    pub tokens: BTreeMap<u64, TokenUsage>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Gap {
    pub reason: GapReason,
    #[serde(default)]
    pub requested_cursor: Option<String>,
    #[serde(default)]
    pub oldest_available_seq: u64,
    #[serde(default)]
    pub lost_events: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    Evicted,
    EpochMismatch,
    CursorAhead,
    Malformed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Heartbeat {
    pub cursor: Cursor,
    #[serde(default)]
    pub ts_ms: u64,
    #[serde(default)]
    pub running: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub seq: u64,
    pub cursor: Cursor,
    pub ts_ms: u64,
    pub event: Event,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    SessionSpawned {
        session: SessionView,
    },
    SessionAdopted {
        session: SessionView,
    },
    TranscriptLocated {
        key: SessionKey,
        session_id: String,
        path: PathBuf,
    },
    TimelineDelta {
        key: SessionKey,
        session_id: String,
        items: Vec<TimelineItem>,
        model: Option<String>,
        last_usage: Option<TokenUsage>,
        turns: BTreeMap<u64, String>,
        /// New answers/dates/tokens with this delta — same "only what changed"
        /// rule as `turns`, and the same merge (later value wins, because an
        /// answer grows while it is being written).
        answers: BTreeMap<u64, String>,
        dates: BTreeMap<u64, String>,
        tokens: BTreeMap<u64, TokenUsage>,
    },
    Hook {
        key: SessionKey,
        session_id: Option<String>,
        hook_event: String,
    },
    SessionExited {
        key: SessionKey,
        session_id: String,
        exit_code: Option<i32>,
        signal: Option<String>,
    },
    Notice {
        level: NoticeLevel,
        key: Option<SessionKey>,
        message: String,
    },
    /// An event kind this workbench does not know. Its envelope still carries a
    /// `seq`, so the cursor advances past it and the user is told once.
    Unknown {
        event: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Running,
    Exited,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionView {
    pub key: SessionKey,
    pub session_id: String,
    pub agent: AgentKind,
    pub cwd: PathBuf,
    #[serde(default)]
    pub pid: Option<u32>,
    pub state: SessionState,
    /// Required — the producer always writes it. A defaulted `0` here would
    /// render as 1970 rather than as "this row could not be read".
    pub started_at_ms: u64,
    #[serde(default)]
    pub exited_at_ms: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub signal: Option<String>,
    #[serde(default)]
    pub transcript: Option<PathBuf>,
    #[serde(default)]
    pub label: Option<String>,
    /// The exact argv the daemon ran. **Not shown by the workbench**: a spawn
    /// request may carry a one-shot prompt, so this string is session content,
    /// not metadata (the daemon's own contract says as much about secrets).
    pub argv: Vec<String>,
    /// How many timeline items the daemon holds for this session. Required, and
    /// **used**: it is what makes a finished session whose body was omitted read
    /// as "본문 생략됨 · N개" instead of "항목 0".
    pub timeline_len: usize,
    /// Present when the daemon recovered this session from a previous
    /// incarnation instead of starting it.
    #[serde(default)]
    pub adopted: Option<Adoption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Adoption {
    #[serde(default)]
    pub previous_epoch: String,
    pub outcome: AdoptionOutcome,
    #[serde(default)]
    pub owned: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdoptionOutcome {
    Reattached,
    ProcessGone,
    TranscriptMissing,
    Lost,
    IdInUse,
    #[serde(other)]
    Unknown,
}

// ---------------------------------------------------------------------------
// Short-command replies (the ones the bridge actually reads)
// ---------------------------------------------------------------------------

/// `cwcd list` — the reply this workbench parses. Every other `Response`
/// variant is left to `serde_json::Value` at the call site; decoding a shape we
/// do not use would only create a second place to keep in sync.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionsReply {
    pub sessions: Vec<SessionView>,
}

/// `cwcd health`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HealthReply {
    pub protocol: u32,
    pub daemon_version: String,
    pub host: HostInfo,
    pub epoch: String,
    #[serde(default)]
    pub running: usize,
    #[serde(default)]
    pub sessions: usize,
}

/// `cwcd spawn` — the session the host actually started, as the host describes
/// it. Read rather than assumed: the daemon decides the key, and may have
/// refused parts of the request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SpawnedReply {
    pub session: SessionView,
}

/// `cwcd kill <addr>` — `signal` is **what was delivered**, not what was asked
/// for: with the process group already gone the daemon falls back to the pty
/// layer's killer, which sends `SIGHUP` and only to the agent itself.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct KilledReply {
    pub key: SessionKey,
    pub session_id: String,
    pub signal: i32,
}

/// `cwcd timeline <addr>` — the recovery address a finished session's
/// `items_omitted` points at.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TimelineSliceReply {
    pub key: SessionKey,
    pub session_id: String,
    #[serde(default)]
    pub from_index: usize,
    /// Required — this reply *is* the recovery path, so a body that could not be
    /// read must not arrive as an empty one.
    pub items: Vec<TimelineItem>,
    pub total: usize,
    #[serde(with = "turn_map")]
    pub turns: BTreeMap<u64, String>,
    /// Defaulted, unlike `turns`: the daemon omits an empty map, and one older
    /// than R2b omits them always — which decodes as "this session has none",
    /// the honest reading of a producer that never had them.
    #[serde(default, with = "turn_map")]
    pub answers: BTreeMap<u64, String>,
    #[serde(default, with = "turn_map")]
    pub dates: BTreeMap<u64, String>,
    #[serde(default, with = "turn_map")]
    pub tokens: BTreeMap<u64, TokenUsage>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub last_usage: Option<TokenUsage>,
}

/// A daemon reply that is an error rather than an answer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ErrorReply {
    pub code: String,
    pub message: String,
}

/// Decode one `Response` JSON object by its `response` tag.
///
/// Returns `Err` with the daemon's own message for `{"response":"error",…}` —
/// the caller must not have to notice an error tag on a success path.
pub fn decode_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("daemon reply is not JSON: {e}"))?;
    let tag = v
        .get("response")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "daemon reply has no `response` tag".to_string())?;
    if tag == "error" {
        let e: ErrorReply = serde_json::from_value(v)
            .map_err(|e| format!("daemon error reply could not be read: {e}"))?;
        return Err(format!("{} ({})", e.message, e.code));
    }
    serde_json::from_value(v).map_err(|e| format!("daemon reply could not be read: {e}"))
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/// `turn -> text` maps arrive with **string** keys: the daemon's `Frame` /
/// `Event` enums are internally tagged, which makes serde buffer the payload,
/// and a buffered map key stays the string it was. Decoding straight into
/// `BTreeMap<u64, _>` fails with `invalid type: string "1"` on every session
/// that has ever been prompted — which is every real one.
mod turn_map {
    use super::BTreeMap;
    use serde::{Deserialize, Deserializer};

    /// Generic over the value since R2b, mirroring the producer: per-turn token
    /// counts ride the same encoding as per-turn text.
    pub fn deserialize<'de, V: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<BTreeMap<u64, V>, D::Error> {
        BTreeMap::<String, V>::deserialize(d)?
            .into_iter()
            .map(|(k, v)| {
                k.parse::<u64>()
                    .map(|k| (k, v))
                    .map_err(|_| serde::de::Error::custom(format!("turn key {k:?} is not a number")))
            })
            .collect()
    }
}

/// Decode one NDJSON line.
///
/// `Err` is reserved for a line that is not usable at all (not JSON, or a known
/// tag whose body does not fit its shape). An **unknown** tag is not an error —
/// see the module docs.
pub fn decode_frame(line: &str) -> Result<Frame, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("not JSON: {e}"))?;
    let tag = v
        .get("frame")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "line has no `frame` tag".to_string())?
        .to_string();
    let of = |e: serde_json::Error| format!("frame {tag:?} could not be read: {e}");
    Ok(match tag.as_str() {
        "hello" => Frame::Hello(serde_json::from_value(v).map_err(of)?),
        "snapshot" => Frame::Snapshot(serde_json::from_value(v).map_err(of)?),
        "gap" => Frame::Gap(serde_json::from_value(v).map_err(of)?),
        "heartbeat" => Frame::Heartbeat(serde_json::from_value(v).map_err(of)?),
        "event" => Frame::Event(decode_envelope(v)?),
        _ => Frame::Unknown { frame: tag },
    })
}

fn decode_envelope(v: serde_json::Value) -> Result<Envelope, String> {
    #[derive(Deserialize)]
    struct Raw {
        seq: u64,
        cursor: Cursor,
        #[serde(default)]
        ts_ms: u64,
        event: serde_json::Value,
    }
    let raw: Raw =
        serde_json::from_value(v).map_err(|e| format!("event envelope could not be read: {e}"))?;
    Ok(Envelope {
        seq: raw.seq,
        cursor: raw.cursor,
        ts_ms: raw.ts_ms,
        event: decode_event(raw.event)?,
    })
}

fn decode_event(v: serde_json::Value) -> Result<Event, String> {
    let tag = v
        .get("event")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "event has no `event` tag".to_string())?
        .to_string();
    let of = |e: serde_json::Error| format!("event {tag:?} could not be read: {e}");

    // One shape per tag, spelled out rather than derived, so that an event this
    // file *does* know but whose body changed is an error the user is told
    // about — while an event it has never heard of is `Unknown` (module docs).
    Ok(match tag.as_str() {
        "session_spawned" => {
            #[derive(Deserialize)]
            struct S {
                session: SessionView,
            }
            Event::SessionSpawned {
                session: serde_json::from_value::<S>(v).map_err(of)?.session,
            }
        }
        "session_adopted" => {
            #[derive(Deserialize)]
            struct S {
                session: SessionView,
            }
            Event::SessionAdopted {
                session: serde_json::from_value::<S>(v).map_err(of)?.session,
            }
        }
        "transcript_located" => {
            #[derive(Deserialize)]
            struct S {
                key: SessionKey,
                session_id: String,
                path: PathBuf,
            }
            let s: S = serde_json::from_value(v).map_err(of)?;
            Event::TranscriptLocated {
                key: s.key,
                session_id: s.session_id,
                path: s.path,
            }
        }
        "timeline_delta" => {
            #[derive(Deserialize)]
            struct S {
                key: SessionKey,
                session_id: String,
                /// Required (the producer always writes it). Defaulted, a delta
                /// whose body this workbench cannot read would apply as a
                /// perfectly normal empty delta **and advance the cursor past
                /// it** — the loss would be silent and unrecoverable.
                items: Vec<TimelineItem>,
                /// `None` = *not changed by this delta* (the producer skips it),
                /// which is the meaning `host` preserves.
                #[serde(default)]
                model: Option<String>,
                #[serde(default)]
                last_usage: Option<TokenUsage>,
                #[serde(default, with = "turn_map")]
                turns: BTreeMap<u64, String>,
                /// Defaulted like `turns`: the producer omits an empty map, so
                /// absent means "nothing new here", never "this consumer could
                /// not read it".
                #[serde(default, with = "turn_map")]
                answers: BTreeMap<u64, String>,
                #[serde(default, with = "turn_map")]
                dates: BTreeMap<u64, String>,
                #[serde(default, with = "turn_map")]
                tokens: BTreeMap<u64, TokenUsage>,
            }
            let s: S = serde_json::from_value(v).map_err(of)?;
            Event::TimelineDelta {
                key: s.key,
                session_id: s.session_id,
                items: s.items,
                model: s.model,
                last_usage: s.last_usage,
                turns: s.turns,
                answers: s.answers,
                dates: s.dates,
                tokens: s.tokens,
            }
        }
        "hook" => {
            // The raw hook body is deliberately **not** kept. The workbench's
            // own hook contract (`claude-hook-status`) carries a session and an
            // event name and nothing else, and a hook payload is session content
            // (prompt text, the last assistant message) that has no consumer
            // here — so it is dropped at the edge rather than carried through
            // the bridge.
            #[derive(Deserialize)]
            struct S {
                key: SessionKey,
                #[serde(default)]
                session_id: Option<String>,
                hook_event: String,
            }
            let s: S = serde_json::from_value(v).map_err(of)?;
            Event::Hook {
                key: s.key,
                session_id: s.session_id,
                hook_event: s.hook_event,
            }
        }
        "session_exited" => {
            #[derive(Deserialize)]
            struct S {
                key: SessionKey,
                session_id: String,
                #[serde(default)]
                exit_code: Option<i32>,
                #[serde(default)]
                signal: Option<String>,
            }
            let s: S = serde_json::from_value(v).map_err(of)?;
            Event::SessionExited {
                key: s.key,
                session_id: s.session_id,
                exit_code: s.exit_code,
                signal: s.signal,
            }
        }
        "notice" => {
            #[derive(Deserialize)]
            struct S {
                level: NoticeLevel,
                #[serde(default)]
                key: Option<SessionKey>,
                message: String,
            }
            let s: S = serde_json::from_value(v).map_err(of)?;
            Event::Notice {
                level: s.level,
                key: s.key,
                message: s.message,
            }
        }
        _ => Event::Unknown { event: tag },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Copied verbatim out of `frames.ndjson` captured from a real `cwcd
    /// 0.1.0 stream` while a real `claude` session ran (R2a smoke,
    /// 2026-08-13). These are the bytes, not a hand-written idea of them.
    const HELLO: &str = r#"{"frame":"hello","protocol":2,"daemon_version":"0.1.0","host":{"host_id":"h-1","hostname":"box","user":"jun","os":"linux","claude_home":"/home/jun/.claude"},"epoch":"0c44fa05437ccebd","resume":{"kind":"fresh"},"oldest_seq":1,"next_seq":1}"#;
    const SNAPSHOT: &str = r#"{"frame":"snapshot","cursor":"0c44fa05437ccebd:0","sessions":[],"taken_at_ms":1786587006150}"#;
    const SPAWNED: &str = r#"{"frame":"event","seq":1,"cursor":"0c44fa05437ccebd:1","ts_ms":1786587006654,"event":{"event":"session_spawned","session":{"key":"k1","session_id":"5b6f21e0-9514-4194-b06b-eb1398b17930","agent":"claude","cwd":"/tmp/r2a/work","pid":3302431,"state":"starting","started_at_ms":1786587006654,"label":"r2a-smoke","argv":["claude","--session-id","5b6f21e0"],"timeline_len":0}}}"#;
    const HOOK: &str = r#"{"frame":"event","seq":2,"cursor":"0c44fa05437ccebd:2","ts_ms":1,"event":{"event":"hook","key":"k1","session_id":"5b6f21e0","hook_event":"UserPromptSubmit","payload":{"prompt":"Reply with exactly: PONG","cwd":"/tmp/r2a/work"}}}"#;
    const DELTA: &str = r#"{"frame":"event","seq":4,"cursor":"0c44fa05437ccebd:4","ts_ms":1,"event":{"event":"timeline_delta","key":"k1","session_id":"5b6f21e0","items":[],"turns":{"1":"Reply with exactly: PONG"}}}"#;
    const DELTA2: &str = r#"{"frame":"event","seq":6,"cursor":"0c44fa05437ccebd:6","ts_ms":1,"event":{"event":"timeline_delta","key":"k1","session_id":"5b6f21e0","items":[],"model":"claude-opus-5","last_usage":{"input":2,"output":5,"cache_read":15976,"cache_creation":15351}}}"#;
    const EXITED: &str = r#"{"frame":"event","seq":7,"cursor":"0c44fa05437ccebd:7","ts_ms":1,"event":{"event":"session_exited","key":"k1","session_id":"5b6f21e0","exit_code":0}}"#;
    const HEARTBEAT: &str = r#"{"frame":"heartbeat","cursor":"0c44fa05437ccebd:7","ts_ms":1786587026281,"running":0}"#;
    /// `cwcd timeline <addr>` on a real finished session (same smoke).
    const TIMELINE_REPLY: &str = r#"{"response":"timeline","key":"k2","session_id":"7699b5b5","from_index":0,
                "items":[{"session_id":"7699b5b5","tool_call_id":"toolu_01Va","turn":1,"seq":0,
                          "kind":"edit","title":"Write /tmp/r2a/work/hello.txt","locations":[],
                          "project_label":null,"diffs":[],"content_text":null,"raw_input":null,
                          "agent_status":"completed","write_status":"none","revision":1}],
                "total":1,"turns":{"1":"Create a file named hello.txt"},
                "model":"claude-opus-5",
                "last_usage":{"input":2,"output":5,"cache_read":31000,"cache_creation":800}}"#;

    #[test]
    fn a_real_daemon_stream_decodes_end_to_end() {
        let Frame::Hello(h) = decode_frame(HELLO).unwrap() else { panic!("hello") };
        assert_eq!(h.protocol, PROTOCOL);
        assert_eq!(h.epoch, "0c44fa05437ccebd");
        assert_eq!(h.resume, Resume::Fresh);
        assert_eq!(h.host.hostname, "box");

        let Frame::Snapshot(s) = decode_frame(SNAPSHOT).unwrap() else { panic!("snapshot") };
        assert_eq!(s.cursor.as_str(), "0c44fa05437ccebd:0");
        assert_eq!(s.cursor.seq(), 0);
        assert!(s.sessions.is_empty());

        let Frame::Event(e) = decode_frame(SPAWNED).unwrap() else { panic!("spawned") };
        assert_eq!(e.seq, 1);
        let Event::SessionSpawned { session } = &e.event else { panic!("kind") };
        assert_eq!(session.key.as_str(), "k1");
        assert_eq!(session.agent, AgentKind::Claude);
        assert_eq!(session.state, SessionState::Starting);

        let Frame::Event(e) = decode_frame(HOOK).unwrap() else { panic!("hook") };
        let Event::Hook { key, hook_event, .. } = &e.event else { panic!("kind") };
        assert_eq!((key.as_str(), hook_event.as_str()), ("k1", "UserPromptSubmit"));

        // The turn map's **string** keys are the failure that broke every typed
        // consumer of v2 before `turn_map` existed. Pinned here on real bytes.
        let Frame::Event(e) = decode_frame(DELTA).unwrap() else { panic!("delta") };
        let Event::TimelineDelta { turns, .. } = &e.event else { panic!("kind") };
        assert_eq!(turns.get(&1).map(String::as_str), Some("Reply with exactly: PONG"));

        let Frame::Event(e) = decode_frame(DELTA2).unwrap() else { panic!("delta2") };
        let Event::TimelineDelta { model, last_usage, .. } = &e.event else { panic!("kind") };
        assert_eq!(model.as_deref(), Some("claude-opus-5"));
        assert_eq!(last_usage.unwrap().cache_read, 15976);

        let Frame::Event(e) = decode_frame(EXITED).unwrap() else { panic!("exited") };
        let Event::SessionExited { exit_code, .. } = &e.event else { panic!("kind") };
        assert_eq!(*exit_code, Some(0));

        let Frame::Heartbeat(h) = decode_frame(HEARTBEAT).unwrap() else { panic!("heartbeat") };
        assert_eq!(h.cursor.seq(), 7);
    }

    #[test]
    fn an_unknown_frame_is_a_value_and_an_unknown_event_keeps_its_position() {
        // A newer daemon's frame kind: reported, not a parse failure.
        let f = decode_frame(r#"{"frame":"usage_delta","x":1}"#).unwrap();
        assert_eq!(f, Frame::Unknown { frame: "usage_delta".into() });

        // A newer daemon's *event* kind: the envelope still carries seq/cursor,
        // so the cursor can move past it (the whole reason for this shape).
        let Frame::Event(e) =
            decode_frame(r#"{"frame":"event","seq":9,"cursor":"e:9","ts_ms":1,"event":{"event":"quota","left":3}}"#)
                .unwrap()
        else {
            panic!("event")
        };
        assert_eq!(e.seq, 9);
        assert_eq!(e.cursor.as_str(), "e:9");
        assert_eq!(e.event, Event::Unknown { event: "quota".into() });
    }

    #[test]
    fn a_known_event_with_a_broken_body_is_an_error_not_a_shrug() {
        // `timeline_delta` without its key: this workbench knows the shape, so
        // a body that does not fit it must be reported, not decoded to Unknown.
        let err = decode_frame(
            r#"{"frame":"event","seq":1,"cursor":"e:1","ts_ms":1,"event":{"event":"timeline_delta","session_id":"s"}}"#,
        )
        .unwrap_err();
        assert!(err.contains("timeline_delta"), "{err}");
        // Not JSON at all.
        assert!(decode_frame("}{").is_err());
        // JSON without a tag.
        assert!(decode_frame(r#"{"seq":1}"#).is_err());
    }

    /// The fields the producer **always** writes are required here too.
    ///
    /// Each of these was `#[serde(default)]` and therefore decoded happily into
    /// a zero: a delta with no `items` became a normal empty delta (and the
    /// cursor advanced past whatever it really carried), a session header with
    /// no `timeline_len` became "0 items", and a recovery reply with no `items`
    /// became "this finished session did nothing".
    #[test]
    fn a_field_the_producer_always_writes_is_required_not_defaulted() {
        // timeline_delta without `items`.
        let err = decode_frame(
            r#"{"frame":"event","seq":1,"cursor":"e:1","ts_ms":1,"event":{"event":"timeline_delta","key":"k1","session_id":"s"}}"#,
        )
        .unwrap_err();
        assert!(err.contains("items"), "{err}");

        // A session header without `timeline_len` / `argv` / `started_at_ms`.
        for missing in ["timeline_len", "argv", "started_at_ms"] {
            let mut v: serde_json::Value = serde_json::from_str(SPAWNED).unwrap();
            v["event"]["session"]
                .as_object_mut()
                .unwrap()
                .remove(missing);
            let err = decode_frame(&v.to_string())
                .err()
                .unwrap_or_else(|| panic!("`{missing}` must be required, not defaulted"));
            assert!(err.contains(missing), "{err}");
        }

        // A snapshot whose body could not be read is not a host with nothing on
        // it.
        let snap = r#"{"frame":"snapshot","cursor":"e:1","taken_at_ms":1,"sessions":[{"key":"k1","session_id":"u","agent":"claude","cwd":"/w","state":"exited","started_at_ms":1,"argv":[],"timeline_len":3,"items_omitted":true,"turns":{}}]}"#;
        assert!(decode_frame(snap).unwrap_err().contains("items"));

        // The recovery reply's own body.
        for missing in ["items", "total", "turns"] {
            let mut v: serde_json::Value = serde_json::from_str(TIMELINE_REPLY).unwrap();
            v.as_object_mut().unwrap().remove(missing);
            let err = decode_response::<TimelineSliceReply>(&v.to_string())
                .expect_err("a reply missing its body must be an error");
            assert!(err.contains(missing), "{err}");
        }
    }

    #[test]
    fn a_session_key_is_a_name_not_a_number() {
        assert_eq!(SessionKey::parse("k7").unwrap().as_str(), "k7");
        assert!(SessionKey::parse("k0").is_none(), "a defaulted key must not name a session");
        assert!(SessionKey::parse("7").is_none());
        assert!(SessionKey::parse("kx").is_none());
        // Ordering is by string, and nothing in this crate may rely on it:
        // k10 sorts before k2. Pinned so a future `max()` on keys is caught.
        let mut v = [SessionKey::parse("k2").unwrap(), SessionKey::parse("k10").unwrap()];
        v.sort();
        assert_eq!(v[0].as_str(), "k10", "keys do not order numerically — never sort them");
    }

    #[test]
    fn an_address_is_composed_from_the_streams_epoch() {
        let k = SessionKey::parse("k7").unwrap();
        assert_eq!(session_addr("0c44fa05437ccebd", &k), "0c44fa05437ccebd:k7");
    }

    #[test]
    fn a_cursor_is_carried_verbatim() {
        let c: Cursor = serde_json::from_str(r#""abc:def:42""#).unwrap();
        // Only the LAST colon separates — an epoch may contain one.
        assert_eq!(c.epoch(), "abc:def");
        assert_eq!(c.seq(), 42);
        assert_eq!(c.as_str(), "abc:def:42");
        assert!(serde_json::from_str::<Cursor>(r#""noseq""#).is_err());
        assert!(serde_json::from_str::<Cursor>(r#"":7""#).is_err());
    }

    /// `cwcd timeline <addr>` — the reply the bridge's on-demand fetch reads.
    /// The turn map's **string** keys are here too, and they are the half a
    /// typed consumer gets wrong: a slice whose session was ever prompted is
    /// every real one.
    #[test]
    fn a_timeline_slice_reply_decodes_with_its_string_keyed_turns() {
        let slice: TimelineSliceReply = decode_response(TIMELINE_REPLY).expect("a finished session's body must be readable — it is the address `items_omitted` points at");
        assert_eq!(slice.key.as_str(), "k2");
        assert_eq!(slice.total, 1);
        assert_eq!(slice.items[0].title, "Write /tmp/r2a/work/hello.txt");
        assert_eq!(slice.turns.get(&1).map(String::as_str), Some("Create a file named hello.txt"));
        assert_eq!(slice.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(slice.last_usage.unwrap().cache_read, 31000);
    }

    #[test]
    fn an_error_reply_is_an_error_not_a_missing_field() {
        let err = decode_response::<SessionsReply>(
            r#"{"response":"error","code":"bad_request","message":"minted by a different daemon incarnation"}"#,
        )
        .unwrap_err();
        assert!(err.contains("different daemon incarnation"), "{err}");
        let ok: SessionsReply =
            decode_response(r#"{"response":"sessions","sessions":[]}"#).unwrap();
        assert!(ok.sessions.is_empty());
    }
}
