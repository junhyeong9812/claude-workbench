//! Map Claude Code **session JSONL** records to internal timeline items
//! (P2b-4 Phase A).
//!
//! Architecture A drives the change timeline not from an ACP adapter but from
//! the JSONL transcript the real `claude` CLI writes to
//! `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` — one JSON object per
//! line, appended live as the session runs. This module is the **offline,
//! deterministic** half: it parses those records (defensively — unknown record
//! types, block types, tool names, and malformed lines are skipped, never fatal)
//! and feeds the same shared [`Timeline`](crate::timeline::Timeline) accumulator
//! the ACP mapper used, so the existing detail view / persistence / UI all work
//! unchanged. The live `tail` that streams lines into this mapper is Phase B.
//!
//! Scope (Phase A): `tool_use` blocks open timeline items; `tool_result` records
//! complete them. `text` / `thinking` blocks are parsed but are **not** timeline
//! items (they are the turn's answer / reasoning — Phase C/E). Token usage,
//! `parentUuid`, and `isSidechain` are parsed onto the record but not yet
//! surfaced as a tree (Phase E).

mod locate;
mod map;
mod record;
mod tail;

pub use locate::{claude_projects_root, find_session_jsonl};
pub use map::{apply_record, JsonlMapper};
pub use record::{Content, ContentBlock, Message, RawRecord};
pub use tail::{JsonlTail, SessionTail};
