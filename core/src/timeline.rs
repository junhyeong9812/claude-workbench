//! The change-timeline data model and accumulator, shared by every input
//! source (P2b-4).
//!
//! Extracted from `acp_map` so that more than one mapper can feed the same
//! model: the original ACP `session/update` mapper ([`crate::acp_map`]) and the
//! session-JSONL mapper ([`crate::jsonl`]). This module owns only the **types**
//! and the **storage/merge mechanics** — it is input-format-agnostic and has no
//! ACP dependency. Each mapper supplies the format-specific field extraction and
//! drives the accumulator through its public primitives ([`Timeline::entry`] /
//! [`Timeline::item_mut`]).
//!
//! Merge model (spec §2):
//! - Items are keyed by `(session_id, tool_call_id)`; re-sightings of an id
//!   merge into the existing item (the mapper bumps `revision`).
//! - `seq` is assigned once, on first sighting, in **receive order**.
//! - `agent_status` (from the agent) and `write_status` (the result of *our*
//!   disk write) are tracked **separately**.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::label::nearest_project_marker;

/// Lifecycle of a tool call as reported by the **agent**.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    /// Closed by us on `session/cancel` or adapter death (not an agent state).
    Canceled,
}

/// Result of **our** disk write for an edit, tracked independently of the
/// agent's status. Stays `None` until a write actually happens (ACP S2b); the
/// JSONL source never sets this (the CLI owns its own writes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteStatus {
    None,
    Written,
    WriteFailed,
}

/// Token accounting for a turn (summed from the turn's assistant `usage`), shown
/// for the "lazy busy" token watch (P2b-4 B1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl TokenUsage {
    /// Accumulate another usage reading into this one (saturating, so corrupt or
    /// adversarial `usage` values can't overflow — codex B1 F4).
    pub fn add(&mut self, o: &TokenUsage) {
        self.input = self.input.saturating_add(o.input);
        self.output = self.output.saturating_add(o.output);
        self.cache_read = self.cache_read.saturating_add(o.cache_read);
        self.cache_creation = self.cache_creation.saturating_add(o.cache_creation);
    }
}

/// Category of a tool call (mirrors ACP `ToolKind`), for icons/grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    /// An interactive question to the user (`AskUserQuestion`) — its options and
    /// the chosen answer render in the detail pane.
    Question,
    /// A plan presented for approval (`ExitPlanMode`) — the plan body renders in
    /// the detail pane.
    Plan,
    Other,
}

/// A single-file modification carried by an edit tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: PathBuf,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// One entry in the change timeline — the merged view of a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineItem {
    pub session_id: String,
    pub tool_call_id: String,
    /// The conversation turn this tool call belongs to (the Nth user prompt).
    /// Assigned once, on first sighting, from the mapper's current turn. `0`
    /// means "before any prompt" / not turn-tracked (the ACP mapper leaves it 0
    /// and tracks turns out-of-band).
    pub turn: u64,
    /// Monotonic client receive order (assigned once, on first sighting).
    pub seq: u64,
    pub kind: ItemKind,
    pub title: String,
    pub locations: Vec<PathBuf>,
    /// Nearest project marker for the first location (spec §2). `None` if there
    /// are no locations yet.
    pub project_label: Option<String>,
    /// The directory this tool call ran in (the JSONL record's `cwd`). For a
    /// subagent working in an isolation worktree this differs from the session's
    /// own cwd, so the UI can label "this happened in another worktree". Sidecar-
    /// free (it rides in the item). `None` for transcripts/old snapshots without it.
    #[serde(default)]
    pub cwd: Option<String>,
    pub diffs: Vec<FileDiff>,
    /// Text the tool produced — a read's content, a search/exec output, an
    /// explanation — for the detail view (B4). Concatenated text content.
    pub content_text: Option<String>,
    /// Raw tool input (the command, the path, …), for the detail view (B4).
    pub raw_input: Option<serde_json::Value>,
    pub agent_status: AgentStatus,
    pub write_status: WriteStatus,
    /// Bumped on every merged update (audit of how many revisions we saw).
    pub revision: u32,
}

impl TimelineItem {
    /// A blank item for `(session_id, tool_call_id)` at `seq` — the shell a
    /// mapper fills in. `Pending` / `Other` / empty until the mapper sets
    /// fields from the source record.
    pub(crate) fn shell(session_id: &str, tool_call_id: &str, seq: u64) -> Self {
        Self {
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            turn: 0,
            seq,
            kind: ItemKind::Other,
            title: String::new(),
            locations: Vec::new(),
            project_label: None,
            cwd: None,
            diffs: Vec::new(),
            content_text: None,
            raw_input: None,
            agent_status: AgentStatus::Pending,
            write_status: WriteStatus::None,
            revision: 0,
        }
    }
}

/// Accumulates timeline items for **one session root**, merging re-sightings and
/// assigning receive-order `seq`. The persistence layer consumes
/// [`Timeline::items`]; this type owns only the in-memory model. Format-specific
/// field extraction lives in the mappers ([`crate::acp_map`], [`crate::jsonl`]),
/// which drive this accumulator through [`Timeline::entry`] / [`item_mut`].
///
/// [`item_mut`]: Timeline::item_mut
pub struct Timeline {
    root: PathBuf,
    items: Vec<TimelineItem>,
    index: HashMap<(String, String), usize>,
    next_seq: u64,
}

impl Timeline {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            items: Vec::new(),
            index: HashMap::new(),
            next_seq: 0,
        }
    }

    pub fn items(&self) -> &[TimelineItem] {
        &self.items
    }

    /// Get-or-create the item for `(session_id, tool_call_id)`. On first
    /// sighting, pushes a blank [`TimelineItem::shell`] with the next
    /// receive-order `seq`. Returns `(index, is_new)` so the mapper can decide
    /// whether this sighting is a fresh insert or a merge (and bump `revision`
    /// accordingly). This is the single entry point both mappers share.
    pub fn entry(&mut self, session_id: &str, tool_call_id: &str) -> (usize, bool) {
        let key = (session_id.to_string(), tool_call_id.to_string());
        if let Some(&idx) = self.index.get(&key) {
            return (idx, false);
        }
        let seq = self.take_seq();
        let idx = self.items.len();
        self.items.push(TimelineItem::shell(session_id, tool_call_id, seq));
        self.index.insert(key, idx);
        (idx, true)
    }

    /// Mutable access to an item the mapper just located via [`entry`].
    ///
    /// [`entry`]: Timeline::entry
    pub fn item_mut(&mut self, idx: usize) -> &mut TimelineItem {
        &mut self.items[idx]
    }

    /// The project label for a set of locations — the nearest project marker of
    /// the first location within this timeline's session `root`. Shared by both
    /// mappers; computed outside any `&mut` borrow of an item.
    pub(crate) fn label_for(&self, locations: &[PathBuf]) -> Option<String> {
        locations
            .first()
            .and_then(|p| nearest_project_marker(p, &self.root))
    }

    /// Close every still-running item as `Canceled` (`session/cancel` or adapter
    /// death). Completed/failed items are left untouched.
    pub fn cancel_open(&mut self) {
        for item in &mut self.items {
            if matches!(item.agent_status, AgentStatus::Pending | AgentStatus::InProgress) {
                item.agent_status = AgentStatus::Canceled;
                item.revision += 1;
            }
        }
    }

    /// Record the outcome of our own disk write for an item (ACP S2b).
    /// Independent of `agent_status`. Returns whether the item was found.
    pub fn set_write_status(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        status: WriteStatus,
    ) -> bool {
        let key = (session_id.to_string(), tool_call_id.to_string());
        if let Some(&idx) = self.index.get(&key) {
            let item = &mut self.items[idx];
            item.write_status = status;
            item.revision += 1;
            true
        } else {
            false
        }
    }

    /// Correlate a write to a timeline item by **path** and record our write
    /// outcome. The ACP write request carries no `tool_call_id`, so we attach it
    /// to the most recent (highest-seq) item whose locations or diffs reference
    /// `path`. Returns the matched index.
    pub fn set_write_status_by_path(
        &mut self,
        path: &Path,
        status: WriteStatus,
    ) -> Option<usize> {
        let idx = self
            .items
            .iter()
            .enumerate()
            .rev()
            .find(|(_, it)| {
                it.locations.iter().any(|p| p == path) || it.diffs.iter().any(|d| d.path == path)
            })
            .map(|(i, _)| i)?;
        let item = &mut self.items[idx];
        item.write_status = status;
        item.revision += 1;
        Some(idx)
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }
}
