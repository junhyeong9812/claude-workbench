//! Defensive deserialization of Claude Code session-JSONL records.
//!
//! Every field is optional and unknown fields/types are ignored, so a CLI
//! version bump that adds record types, block types, or fields never breaks the
//! mapper — it just produces no timeline item for what it doesn't understand
//! (spec §1 invariant ⑤; the format is the CLI's **unofficial** internal one,
//! decision-and-plan §6.3). A line that isn't valid JSON parses to `None` and is
//! skipped rather than aborting the stream.

use serde::Deserialize;

/// One line of the session transcript. Records we don't map (`mode`, `ai-title`,
/// `file-history-snapshot`, …) simply carry no `message` content we act on.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RawRecord {
    /// Top-level record kind: `assistant` / `user` / `system` / … (kept for
    /// debugging; the mapper keys off the content blocks, not this).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub uuid: Option<String>,
    /// Parent link for subagent-tree reconstruction (B1, parsed not yet used).
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    /// Whether this record belongs to a sidechain (subagent) turn (B1).
    #[serde(rename = "isSidechain")]
    pub is_sidechain: Option<bool>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    #[serde(rename = "gitBranch")]
    pub git_branch: Option<String>,
    pub version: Option<String>,
    pub timestamp: Option<String>,
    pub message: Option<Message>,
    /// The richer structured result the CLI attaches to a `tool_result` record
    /// (file object, exit code, …). Parsed but optional in Phase A — completion
    /// is driven by the `tool_result` content block.
    #[serde(rename = "toolUseResult")]
    pub tool_use_result: Option<serde_json::Value>,
}

impl RawRecord {
    /// Parse a single transcript line. Blank lines and malformed JSON yield
    /// `None` (skipped, never fatal).
    pub fn parse_line(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        serde_json::from_str(line).ok()
    }
}

/// The `message` envelope on `assistant` / `user` records.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Message {
    pub role: Option<String>,
    pub content: Option<Content>,
    /// Token accounting (input/output/cache) — parsed, surfaced in Phase E.
    pub usage: Option<serde_json::Value>,
}

/// A message's content is either a bare string (a user's typed prompt), an array
/// of blocks (assistant output / tool results), or some other shape.
///
/// Blocks are kept as **raw `Value`s** rather than `Vec<ContentBlock>` so that a
/// single malformed/odd element doesn't fail the whole array and lose its valid
/// siblings — the mapper parses each element individually and skips the ones it
/// can't read (spec §1 invariant ⑤). The trailing [`Content::Other`] absorbs any
/// non-string/non-array shape (e.g. an object) so deserialization never fails.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Content {
    /// A plain user prompt string.
    Text(String),
    /// Assistant/tool blocks, still as raw values (parsed per-element later).
    Blocks(Vec<serde_json::Value>),
    /// Any other content shape — carries no timeline blocks.
    Other(serde_json::Value),
}

/// A single content block. Unknown `type`s fall through to [`ContentBlock::Other`]
/// so new block kinds never abort a record.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Assistant prose (a turn's answer text) — not a timeline item (Phase C/E).
    Text {
        #[serde(default)]
        text: String,
    },
    /// Extended-thinking reasoning — not a timeline item (Phase E).
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    /// A tool invocation — **opens** a timeline item keyed by `id`.
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    /// A tool's result — **completes** the item with matching `tool_use_id`.
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: serde_json::Value,
        #[serde(default)]
        is_error: Option<bool>,
    },
    /// Any other (or future) block type — ignored by the mapper.
    #[serde(other)]
    Other,
}
