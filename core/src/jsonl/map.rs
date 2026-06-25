//! The session-JSONL → [`Timeline`] mapper (P2b-4 Phase A).
//!
//! Mirrors the merge model of [`crate::acp_map`] but over JSONL records instead
//! of ACP `session/update`s. The two sources differ in shape:
//! - ACP delivers a `tool_call` plus incremental `tool_call_update`s, each
//!   carrying a status.
//! - JSONL delivers a `tool_use` block (the request, in an `assistant` record)
//!   and, later, a `tool_result` block (the outcome, in a `user` record) keyed
//!   by `tool_use_id`.
//!
//! So here a `tool_use` **opens** the item (status `InProgress` — the request is
//! out but no result is in yet) and a `tool_result` **completes** it (`Failed`
//! if `is_error`, else `Completed`). Both reuse the shared accumulator
//! primitives [`Timeline::entry`] / [`Timeline::item_mut`].

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::jsonl::record::{Content, ContentBlock, RawRecord};
use crate::timeline::{AgentStatus, FileDiff, ItemKind, Timeline, TokenUsage};

/// A [`Timeline`] fed line-by-line from one session's JSONL file. One file is
/// one session; `session_id` is the file's UUID, used as a fallback when a
/// record omits its own `sessionId`.
///
/// Besides the tool-call timeline, the mapper derives **conversation turns** so
/// the UI can group changes by prompt: a bare-string user record opens a new
/// turn (`current_turn += 1`) and records its prompt; assistant `text` blocks
/// accumulate as that turn's answer; each tool item is stamped with the turn it
/// occurred in. (In architecture A the terminal already renders the chat, so
/// the prompt/answer text is supplementary — but deriving it keeps the existing
/// timeline UI contract, which carries `turns`/`answers`/`dates`.)
pub struct JsonlMapper {
    timeline: Timeline,
    session_id: String,
    current_turn: u64,
    turns: BTreeMap<u64, String>,
    answers: BTreeMap<u64, String>,
    dates: BTreeMap<u64, String>,
    tokens: BTreeMap<u64, TokenUsage>,
}

impl JsonlMapper {
    pub fn new(root: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self {
            timeline: Timeline::new(root),
            session_id: session_id.into(),
            current_turn: 0,
            turns: BTreeMap::new(),
            answers: BTreeMap::new(),
            dates: BTreeMap::new(),
            tokens: BTreeMap::new(),
        }
    }

    /// Parse and apply one transcript line. Malformed / non-timeline lines are
    /// skipped (empty result). Returns the indices of tool items touched (a
    /// prompt-only record touches none but still advances the turn).
    pub fn apply_line(&mut self, line: &str) -> Vec<usize> {
        let Some(rec) = RawRecord::parse_line(line) else {
            return Vec::new();
        };
        let session = rec
            .session_id
            .clone()
            .unwrap_or_else(|| self.session_id.clone());
        // The record's UTC day (YYYY-MM-DD) for date dividers in the UI.
        let date = rec.timestamp.as_deref().and_then(|t| t.get(..10)).map(str::to_string);
        // Dispatch on the author, not just the content shape: only a *user* bare
        // string is a prompt, and only *assistant* text is answer (codex B-2c).
        let role = rec
            .message
            .as_ref()
            .and_then(|m| m.role.as_deref())
            .or(rec.kind.as_deref());
        let is_user = role == Some("user");
        let is_assistant = role == Some("assistant");

        // Accumulate this turn's token usage from assistant `usage` (B1).
        if is_assistant {
            if let Some(u) = rec.message.as_ref().and_then(|m| m.usage.as_ref()) {
                self.tokens
                    .entry(self.current_turn)
                    .or_default()
                    .add(&parse_usage(u));
            }
        }

        let content = rec.message.as_ref().and_then(|m| m.content.as_ref());

        // A user prompt is the user's *text* — recorded either as a bare string
        // (headless `-p`) or as `text` blocks in an array (interactive). A user
        // array of `tool_result` blocks carries no text and is NOT a prompt.
        // (Interactive Claude writes prompts as `[{type:"text",...}]`, not bare
        // strings — measured; the bare-string-only check missed every
        // interactive prompt.)
        if is_user {
            let prompt = match content {
                Some(Content::Text(s)) => (!s.trim().is_empty()).then(|| s.clone()),
                Some(Content::Blocks(b)) => concat_text_blocks(b),
                _ => None,
            };
            if let Some(p) = prompt {
                // `[Request interrupted by user]` is not a real prompt — it marks
                // that the user cut the turn off. Don't open a new turn for it;
                // instead cancel any still-open (in-flight) items so the rejected
                // segment shows as Canceled (⊘) under the turn it interrupted.
                if is_interrupt_text(&p) {
                    self.timeline.cancel_open();
                    return Vec::new();
                }
                self.current_turn += 1;
                self.turns.insert(self.current_turn, p);
                if let Some(d) = date {
                    self.dates.entry(self.current_turn).or_insert(d);
                }
                return Vec::new();
            }
        }

        // Otherwise: assistant tool_use + text(answer), or user tool_result blocks.
        match content {
            Some(Content::Blocks(blocks)) => {
                let (touched, answer) = apply_blocks(
                    &mut self.timeline,
                    &session,
                    self.current_turn,
                    is_assistant,
                    rec.uuid.as_deref(),
                    rec.cwd.as_deref(),
                    blocks,
                );
                if let Some(a) = answer {
                    let entry = self.answers.entry(self.current_turn).or_default();
                    if !entry.is_empty() {
                        entry.push('\n');
                    }
                    entry.push_str(&a);
                }
                if !touched.is_empty() {
                    if let Some(d) = date {
                        self.dates.entry(self.current_turn).or_insert(d);
                    }
                }
                touched
            }
            _ => Vec::new(),
        }
    }

    pub fn timeline(&self) -> &Timeline {
        &self.timeline
    }

    pub fn into_timeline(self) -> Timeline {
        self.timeline
    }

    /// turn → user prompt text.
    pub fn turns(&self) -> &BTreeMap<u64, String> {
        &self.turns
    }

    /// turn → concatenated assistant answer text.
    pub fn answers(&self) -> &BTreeMap<u64, String> {
        &self.answers
    }

    /// turn → YYYY-MM-DD (the record's UTC day).
    pub fn dates(&self) -> &BTreeMap<u64, String> {
        &self.dates
    }

    /// turn → accumulated token usage (B1).
    pub fn tokens(&self) -> &BTreeMap<u64, TokenUsage> {
        &self.tokens
    }

    pub fn current_turn(&self) -> u64 {
        self.current_turn
    }
}

/// Apply one record's content blocks at `turn`. Returns `(touched item indices,
/// concatenated assistant answer text from this record)`. Each block is parsed
/// individually so one malformed/odd element is skipped without losing its valid
/// siblings (spec ⑤).
fn apply_blocks(
    timeline: &mut Timeline,
    session: &str,
    turn: u64,
    is_assistant: bool,
    record_uuid: Option<&str>,
    cwd: Option<&str>,
    blocks: &[Value],
) -> (Vec<usize>, Option<String>) {
    let mut touched = Vec::new();
    let mut answer = String::new();
    for (idx, value) in blocks.iter().enumerate() {
        let Ok(block) = serde_json::from_value::<ContentBlock>(value.clone()) else {
            continue;
        };
        match block {
            ContentBlock::ToolUse { id, name, input } => {
                touched.push(open_tool_use(timeline, session, turn, &id, &name, &input, cwd));
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                touched.push(complete_tool_result(
                    timeline,
                    session,
                    turn,
                    &tool_use_id,
                    &content,
                    is_error,
                    cwd,
                ));
            }
            // Assistant prose is the turn's answer (the terminal also shows it).
            // Only count text from an assistant record (codex B-2c).
            ContentBlock::Text { text } => {
                if is_assistant && !text.trim().is_empty() {
                    if !answer.is_empty() {
                        answer.push('\n');
                    }
                    answer.push_str(&text);
                }
            }
            // Extended-thinking reasoning becomes a Think item in seq order, so
            // the user can follow the reasoning → action flow (B1, user intent).
            // Keyed by the record uuid + block index so a re-tail merges, not
            // duplicates.
            ContentBlock::Thinking { thinking } => {
                // Need the record uuid for a stable, collision-free id (codex B1
                // F2) — without it, `think:?:<idx>` from different records would
                // merge and overwrite each other. Real records always carry one.
                if let Some(uuid) = record_uuid {
                    if is_assistant && !thinking.trim().is_empty() {
                        let id = format!("think:{uuid}:{idx}");
                        touched.push(open_thinking(timeline, session, turn, &id, &thinking));
                    }
                }
            }
            // unknown blocks are not timeline items.
            _ => {}
        }
    }
    (touched, (!answer.is_empty()).then_some(answer))
}

/// Record an extended-thinking block as a completed `Think` timeline item. Its
/// title is the first line; the full reasoning is in `content_text` (detail view).
fn open_thinking(timeline: &mut Timeline, session: &str, turn: u64, id: &str, thinking: &str) -> usize {
    let (idx, is_new) = timeline.entry(session, id);
    let item = timeline.item_mut(idx);
    if is_new {
        item.turn = turn;
    }
    item.kind = ItemKind::Think;
    item.title = thinking
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(thinking)
        .chars()
        .take(80)
        .collect();
    item.content_text = Some(thinking.to_string());
    item.agent_status = AgentStatus::Completed;
    if !is_new {
        item.revision += 1;
    }
    idx
}

/// Open (or, for a re-sent id, refresh) the timeline item for a `tool_use`.
fn open_tool_use(
    timeline: &mut Timeline,
    session: &str,
    turn: u64,
    id: &str,
    name: &str,
    input: &Value,
    cwd: Option<&str>,
) -> usize {
    let locations = locations_from_input(input);
    let project_label = timeline.label_for(&locations);
    let diffs = diffs_from_input(name, input);
    let title = derive_title(name, input);

    let (idx, is_new) = timeline.entry(session, id);
    let item = timeline.item_mut(idx);
    if is_new {
        item.turn = turn;
        // The directory the call ran in — set once on first sighting (a later
        // re-sighting/result must not change where it happened).
        item.cwd = cwd.map(str::to_string);
    }
    item.kind = map_tool_kind(name);
    item.title = title;
    item.locations = locations;
    item.project_label = project_label;
    item.diffs = diffs;
    item.raw_input = Some(input.clone());
    // The request has been issued but no result has come back yet — move to
    // InProgress only from a fresh/Pending shell. A `tool_result` that arrived
    // first (out-of-order / truncated) already set Completed/Failed; a duplicate
    // or late `tool_use` must not downgrade it back to InProgress (invariant ②).
    if matches!(item.agent_status, AgentStatus::Pending) {
        item.agent_status = AgentStatus::InProgress;
    }
    if !is_new {
        item.revision += 1;
    }
    idx
}

/// Complete the item matching `tool_use_id` with the tool's result. If the
/// `tool_use` was never seen (out-of-order / truncated transcript), a shell item
/// is created defensively so the result is not lost.
fn complete_tool_result(
    timeline: &mut Timeline,
    session: &str,
    turn: u64,
    tool_use_id: &str,
    content: &Value,
    is_error: Option<bool>,
    cwd: Option<&str>,
) -> usize {
    let text = extract_result_text(content);
    // A tool the user declined/interrupted comes back as an error whose text says
    // so — mark it Canceled (⊘) rather than a generic Failed (✗), so a rejected
    // segment reads as "user stopped this", not "the tool broke". The reason text
    // stays in content_text and the tool input (command/path) in raw_input.
    // Narrow on purpose: a real Bash/test failure could *contain* these words, so
    // match the rejection envelope Claude emits at the *start* of the result, not
    // an arbitrary substring.
    let rejected = is_error == Some(true)
        && text.as_deref().is_some_and(|t| {
            let tt = t.trim_start();
            tt.starts_with("The user doesn't want to")
                || tt.starts_with("[Request interrupted by user")
        });

    let (idx, is_new) = timeline.entry(session, tool_use_id);
    let item = timeline.item_mut(idx);
    if is_new {
        item.turn = turn;
        // Result-first (out-of-order/truncated): capture cwd here too so a subagent
        // worktree item isn't left unlabeled (codex). A later tool_use is `!is_new`,
        // so it won't overwrite — first sighting wins, as for `turn`.
        item.cwd = cwd.map(str::to_string);
    }
    item.agent_status = if rejected {
        AgentStatus::Canceled
    } else if is_error == Some(true) {
        AgentStatus::Failed
    } else {
        AgentStatus::Completed
    };
    if let Some(t) = text {
        item.content_text = Some(t);
    }
    item.revision += 1;
    idx
}

/// Map a Claude Code tool name to a timeline [`ItemKind`]. Unknown / future
/// tools (MCP tools, `Task`, `TodoWrite`, `AskUserQuestion`, …) collapse to
/// `Other`; subagent (`Task`) and question (`AskUserQuestion`) handling is a
/// later phase (B1/B2).
fn map_tool_kind(name: &str) -> ItemKind {
    match name {
        "Read" | "NotebookRead" => ItemKind::Read,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ItemKind::Edit,
        "Bash" | "BashOutput" | "KillShell" | "KillBash" => ItemKind::Execute,
        "Glob" | "Grep" => ItemKind::Search,
        "WebSearch" => ItemKind::Search,
        "WebFetch" => ItemKind::Fetch,
        "AskUserQuestion" => ItemKind::Question,
        "ExitPlanMode" => ItemKind::Plan,
        _ => ItemKind::Other,
    }
}

/// Whether a user text block is *exactly* the interrupt sentinel Claude writes
/// when the user stops a turn — not a real prompt. Exact match (after trim) so a
/// genuine prompt that merely starts with the phrase isn't swallowed.
fn is_interrupt_text(s: &str) -> bool {
    let t = s.trim();
    t == "[Request interrupted by user]" || t == "[Request interrupted by user for tool use]"
}

/// The file path(s) a tool touches, for labelling and the detail view.
fn locations_from_input(input: &Value) -> Vec<PathBuf> {
    for key in ["file_path", "notebook_path", "path"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return vec![PathBuf::from(s)];
        }
    }
    Vec::new()
}

/// Extract file diffs from a tool's input. Edit carries `old_string`/
/// `new_string`; Write carries full `content` (no prior text); MultiEdit carries
/// an `edits` array. Other tools produce no diff.
fn diffs_from_input(name: &str, input: &Value) -> Vec<FileDiff> {
    let path = || input.get("file_path").and_then(Value::as_str);
    match name {
        "Edit" => {
            match (
                path(),
                input.get("old_string").and_then(Value::as_str),
                input.get("new_string").and_then(Value::as_str),
            ) {
                (Some(p), Some(old), Some(new)) => vec![FileDiff {
                    path: PathBuf::from(p),
                    old_text: Some(old.to_string()),
                    new_text: new.to_string(),
                }],
                _ => Vec::new(),
            }
        }
        "Write" => match (path(), input.get("content").and_then(Value::as_str)) {
            (Some(p), Some(c)) => vec![FileDiff {
                path: PathBuf::from(p),
                old_text: None,
                new_text: c.to_string(),
            }],
            _ => Vec::new(),
        },
        "MultiEdit" => {
            let Some(p) = path() else {
                return Vec::new();
            };
            input
                .get("edits")
                .and_then(Value::as_array)
                .map(|edits| {
                    edits
                        .iter()
                        .filter_map(|e| {
                            let old = e.get("old_string").and_then(Value::as_str)?;
                            let new = e.get("new_string").and_then(Value::as_str)?;
                            Some(FileDiff {
                                path: PathBuf::from(p),
                                old_text: Some(old.to_string()),
                                new_text: new.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

/// A short human title: a Bash command's first line, a file tool's path, else
/// the tool name.
fn derive_title(name: &str, input: &Value) -> String {
    if name == "Bash" {
        if let Some(cmd) = input.get("command").and_then(Value::as_str) {
            let first = cmd.lines().next().unwrap_or(cmd);
            return first.chars().take(120).collect();
        }
    }
    // AskUserQuestion: the first question's header (or its question text).
    if name == "AskUserQuestion" {
        if let Some(q0) = input
            .get("questions")
            .and_then(Value::as_array)
            .and_then(|qs| qs.first())
        {
            if let Some(h) = q0
                .get("header")
                .and_then(Value::as_str)
                .or_else(|| q0.get("question").and_then(Value::as_str))
            {
                return h.chars().take(120).collect();
            }
        }
        return "질문".to_string();
    }
    // ExitPlanMode: the plan's first non-empty line.
    if name == "ExitPlanMode" {
        if let Some(plan) = input.get("plan").and_then(Value::as_str) {
            if let Some(line) = plan.lines().map(str::trim).find(|l| !l.is_empty()) {
                return line.chars().take(120).collect();
            }
        }
        return "계획".to_string();
    }
    if let Some(p) = input.get("file_path").and_then(Value::as_str) {
        return format!("{name} {p}");
    }
    name.to_string()
}

/// Parse a Claude `usage` object into a [`TokenUsage`] (missing fields = 0).
fn parse_usage(u: &Value) -> TokenUsage {
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    TokenUsage {
        input: n("input_tokens"),
        output: n("output_tokens"),
        cache_read: n("cache_read_input_tokens"),
        cache_creation: n("cache_creation_input_tokens"),
    }
}

/// Concatenate the `text` blocks of a content array (a user prompt or assistant
/// answer recorded as blocks). `None` if there are no text blocks (e.g. a
/// `tool_result`-only user array, which is not a prompt).
fn concat_text_blocks(blocks: &[Value]) -> Option<String> {
    let mut out = String::new();
    for v in blocks {
        if v.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(t) = v.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

/// Pull display text out of a `tool_result` content value, which is either a
/// bare string or an array of `{type:"text", text}` blocks.
fn extract_result_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Array(items) => {
            let mut out = String::new();
            for it in items {
                if it.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = it.get("text").and_then(Value::as_str) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
            (!out.is_empty()).then_some(out)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::WriteStatus;
    use serde_json::json;

    const ROOT: &str = "/work";
    const SID: &str = "sess-uuid";

    fn line(v: serde_json::Value) -> String {
        v.to_string()
    }

    /// An `assistant` record carrying content blocks (tool_use / text / …).
    fn asst(blocks: serde_json::Value) -> serde_json::Value {
        json!({
            "type": "assistant",
            "sessionId": SID,
            "message": { "role": "assistant", "content": blocks },
        })
    }

    /// A `user` record carrying content blocks (tool_result / a bare prompt).
    fn user(content: serde_json::Value) -> serde_json::Value {
        json!({
            "type": "user",
            "sessionId": SID,
            "message": { "role": "user", "content": content },
        })
    }

    fn map_lines(lines: &[String]) -> Timeline {
        let mut m = JsonlMapper::new(ROOT, SID);
        for l in lines {
            m.apply_line(l);
        }
        m.into_timeline()
    }

    // Spec ①②: a tool_use opens an item, a tool_result completes it (one item).
    #[test]
    fn tool_use_then_result_is_one_completed_item() {
        let lines = [
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Read",
                  "input": { "file_path": "/work/p/src/main.rs" } }
            ]))),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "hello" }
            ]))),
        ];
        let tl = map_lines(&lines);
        assert_eq!(tl.items().len(), 1);
        let it = &tl.items()[0];
        assert_eq!(it.tool_call_id, "t1");
        assert_eq!(it.session_id, SID);
        assert_eq!(it.kind, ItemKind::Read);
        assert_eq!(it.locations, vec![PathBuf::from("/work/p/src/main.rs")]);
        assert_eq!(it.agent_status, AgentStatus::Completed);
        assert_eq!(it.content_text.as_deref(), Some("hello"));
        assert_eq!(it.seq, 0);
        assert_eq!(it.revision, 1, "open(rev0) + complete(+1)");
        assert_eq!(it.write_status, WriteStatus::None, "spec ⑥ no disk write");
    }

    // Spec ①: a tool_use with no result yet sits at InProgress.
    #[test]
    fn lone_tool_use_is_in_progress() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/x" } }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].agent_status, AgentStatus::InProgress);
        assert_eq!(tl.items()[0].revision, 0);
    }

    // Spec ③: Edit carries old_string/new_string → one FileDiff.
    #[test]
    fn edit_extracts_old_new_diff() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "Edit", "input": {
                "file_path": "/work/a.rs", "old_string": "foo", "new_string": "bar",
                "replace_all": false } }
        ])))];
        let tl = map_lines(&lines);
        let it = &tl.items()[0];
        assert_eq!(it.kind, ItemKind::Edit);
        assert_eq!(it.diffs.len(), 1);
        assert_eq!(it.diffs[0].path, PathBuf::from("/work/a.rs"));
        assert_eq!(it.diffs[0].old_text.as_deref(), Some("foo"));
        assert_eq!(it.diffs[0].new_text, "bar");
    }

    // Spec ③: Write carries full content → diff with no prior text.
    #[test]
    fn write_diff_has_no_old_text() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "Write", "input": {
                "file_path": "/work/b.rs", "content": "line1\nline2" } }
        ])))];
        let tl = map_lines(&lines);
        let it = &tl.items()[0];
        assert_eq!(it.kind, ItemKind::Edit);
        assert_eq!(it.diffs.len(), 1);
        assert_eq!(it.diffs[0].old_text, None);
        assert_eq!(it.diffs[0].new_text, "line1\nline2");
    }

    // Spec ③: MultiEdit's edits array → one FileDiff per edit, in order.
    #[test]
    fn multiedit_yields_one_diff_per_edit() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "MultiEdit", "input": {
                "file_path": "/work/c.rs",
                "edits": [
                    { "old_string": "a", "new_string": "A" },
                    { "old_string": "b", "new_string": "B" }
                ] } }
        ])))];
        let tl = map_lines(&lines);
        let it = &tl.items()[0];
        assert_eq!(it.diffs.len(), 2);
        assert_eq!(it.diffs[0].old_text.as_deref(), Some("a"));
        assert_eq!(it.diffs[0].new_text, "A");
        assert_eq!(it.diffs[1].old_text.as_deref(), Some("b"));
        assert_eq!(it.diffs[1].new_text, "B");
        assert!(it.diffs.iter().all(|d| d.path == PathBuf::from("/work/c.rs")));
    }

    // Bash → Execute, title is the command's first line, no file location.
    #[test]
    fn bash_is_execute_with_first_line_title() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "Bash", "input": {
                "command": "cargo test\nsecond line" } }
        ])))];
        let tl = map_lines(&lines);
        let it = &tl.items()[0];
        assert_eq!(it.kind, ItemKind::Execute);
        assert_eq!(it.title, "cargo test");
        assert!(it.locations.is_empty());
    }

    // is_error:true on a result marks the item Failed; defensive shell created
    // even when the tool_use was never seen (out-of-order / truncated).
    #[test]
    fn error_result_for_unseen_id_is_failed_shell() {
        let lines = [line(user(json!([
            { "type": "tool_result", "tool_use_id": "t1", "content": "boom", "is_error": true }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items().len(), 1);
        let it = &tl.items()[0];
        assert_eq!(it.tool_call_id, "t1");
        assert_eq!(it.agent_status, AgentStatus::Failed);
        assert_eq!(it.content_text.as_deref(), Some("boom"));
        assert_eq!(it.kind, ItemKind::Other, "shell default for unseen id");
    }

    // tool_result content may be an array of text blocks → concatenated.
    #[test]
    fn array_result_content_is_concatenated() {
        let lines = [
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }
            ]))),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "is_error": false, "content": [
                    { "type": "text", "text": "out" },
                    { "type": "text", "text": "more" }
                ] }
            ]))),
        ];
        let tl = map_lines(&lines);
        let it = &tl.items()[0];
        assert_eq!(it.agent_status, AgentStatus::Completed);
        assert_eq!(it.content_text.as_deref(), Some("out\nmore"));
    }

    // AskUserQuestion → Question kind; title is the first question's header.
    #[test]
    fn ask_user_question_maps_to_question_with_header_title() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "AskUserQuestion", "input": {
                "questions": [
                    { "header": "작업 모드", "question": "어떤 모드로?",
                      "options": [ { "label": "auto" }, { "label": "lazy" } ] }
                ]
            } }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].kind, ItemKind::Question);
        assert_eq!(tl.items()[0].title, "작업 모드");
    }

    // ExitPlanMode → Plan kind; title is the plan's first non-empty line.
    #[test]
    fn exit_plan_mode_maps_to_plan_with_first_line_title() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "ExitPlanMode", "input": {
                "plan": "\n  단계 1: 폰트 수정\n단계 2: 키보드"
            } }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].kind, ItemKind::Plan);
        assert_eq!(tl.items()[0].title, "단계 1: 폰트 수정");
    }

    // `[Request interrupted by user]` opens no turn and cancels in-flight items.
    #[test]
    fn interrupt_marker_cancels_open_items_and_opens_no_turn() {
        let lines = [
            line(user(json!("첫 질문"))),
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a.rs" } }
            ]))),
            // user interrupts before the tool returns
            line(user(json!([{ "type": "text", "text": "[Request interrupted by user]" }]))),
        ];
        let tl = map_lines(&lines);
        // The marker is not a prompt — only the real question is a turn.
        assert_eq!(tl.items()[0].agent_status, AgentStatus::Canceled);
    }

    // A tool the user declined comes back as an error → Canceled, not Failed.
    #[test]
    fn user_declined_tool_result_is_canceled() {
        let lines = [
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "rm -rf x" } }
            ]))),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                  "content": "The user doesn't want to proceed with this tool use." }
            ]))),
        ];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].agent_status, AgentStatus::Canceled);
    }

    // A genuine prompt that merely *starts with* the phrase is NOT swallowed.
    #[test]
    fn prompt_starting_like_interrupt_still_opens_turn() {
        let mut m = JsonlMapper::new(ROOT, SID);
        m.apply_line(&line(user(json!([
            { "type": "text", "text": "[Request interrupted by user] 이 로그가 왜 생겨?" }
        ]))));
        assert_eq!(m.current_turn(), 1, "prefix-only match must not swallow a real prompt");
        assert!(m.turns().get(&1).is_some());
    }

    // A real tool failure whose output merely *contains* the words stays Failed.
    #[test]
    fn real_failure_mentioning_interrupt_words_stays_failed() {
        let lines = [
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "run" } }
            ]))),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                  "content": "error: the job was interrupted by user space watchdog" }
            ]))),
        ];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].agent_status, AgentStatus::Failed);
    }

    // An unknown / future tool name collapses to Other (never an error).
    #[test]
    fn unknown_tool_name_is_other() {
        let lines = [line(asst(json!([
            { "type": "tool_use", "id": "t1", "name": "MysteryTool", "input": {} }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].kind, ItemKind::Other);
        assert_eq!(tl.items()[0].title, "MysteryTool");
    }

    // Spec ④: seq is assigned once in receive order; a later result doesn't
    // reorder.
    #[test]
    fn seq_is_receive_order() {
        let lines = [
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a" } }
            ]))),
            line(asst(json!([
                { "type": "tool_use", "id": "t2", "name": "Edit", "input": {
                    "file_path": "/b", "old_string": "x", "new_string": "y" } }
            ]))),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "done" }
            ]))),
        ];
        let tl = map_lines(&lines);
        assert_eq!(tl.items()[0].tool_call_id, "t1");
        assert_eq!(tl.items()[0].seq, 0);
        assert_eq!(tl.items()[1].tool_call_id, "t2");
        assert_eq!(tl.items()[1].seq, 1);
    }

    // Spec ⑤⑦: malformed lines, unknown record types, unknown block types,
    // bare-string prompts, and text/thinking blocks all produce no items —
    // only the real tool_use survives.
    #[test]
    fn skips_malformed_unknown_and_non_tool_blocks() {
        let lines = [
            "this is not json {".to_string(),
            line(json!({ "type": "file-history-snapshot", "snapshot": {} })),
            line(asst(json!([
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "an answer" }
            ]))),
            line(user(json!("a bare typed prompt"))),
            line(asst(json!([
                { "type": "some_future_block", "foo": 1 },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/x" } }
            ]))),
        ];
        let tl = map_lines(&lines);
        // Malformed JSON, unknown record/block types, the text block, and the
        // bare prompt all skip. The thinking block here has no record uuid, so it
        // is also skipped (B1 F2 — a Think item needs a stable uuid). Only the
        // real tool_use is an item.
        assert_eq!(tl.items().len(), 1);
        assert_eq!(tl.items()[0].tool_call_id, "t1");
    }

    // Invariant ②, codex F1: a result seen before its tool_use marks the item
    // Completed; a later (out-of-order / duplicate) tool_use must NOT downgrade
    // it back to InProgress.
    #[test]
    fn out_of_order_tool_use_does_not_downgrade_completed() {
        let lines = [
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "done" }
            ]))),
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/x" } }
            ]))),
        ];
        let tl = map_lines(&lines);
        assert_eq!(tl.items().len(), 1);
        let it = &tl.items()[0];
        assert_eq!(it.agent_status, AgentStatus::Completed, "not downgraded");
        // The late tool_use still enriched the item (kind/location).
        assert_eq!(it.kind, ItemKind::Read);
        assert_eq!(it.locations, vec![PathBuf::from("/x")]);
    }

    // codex F2: one malformed block in a record must not lose its valid siblings.
    #[test]
    fn malformed_block_does_not_drop_valid_siblings() {
        let lines = [line(asst(json!([
            // missing required `id` -> this block alone fails to parse...
            { "type": "tool_use", "name": "Read" },
            // ...but the valid sibling survives.
            { "type": "tool_use", "id": "t1", "name": "Edit", "input": {
                "file_path": "/work/a.rs", "old_string": "x", "new_string": "y" } }
        ])))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items().len(), 1, "valid sibling block survives");
        assert_eq!(tl.items()[0].tool_call_id, "t1");
        assert_eq!(tl.items()[0].kind, ItemKind::Edit);
    }

    // codex F2: message.content as an object (not string/array) is absorbed by
    // Content::Other — no items, no failure.
    #[test]
    fn object_content_yields_no_items() {
        let rec = json!({
            "type": "assistant",
            "sessionId": SID,
            "message": { "role": "assistant", "content": { "unexpected": "shape" } },
        });
        let tl = map_lines(&[line(rec)]);
        assert!(tl.items().is_empty());
    }

    // B-2c: bare-string user prompts open turns; assistant text is the answer;
    // tool items are stamped with the turn they occurred in; dates from
    // timestamp.
    #[test]
    fn derives_turns_prompts_answers_dates() {
        let prompt1 = json!({
            "type": "user", "sessionId": SID, "timestamp": "2026-06-19T08:00:00.000Z",
            "message": { "role": "user", "content": "do the first thing" }
        });
        let asst1 = json!({
            "type": "assistant", "sessionId": SID, "timestamp": "2026-06-19T08:00:01.000Z",
            "message": { "role": "assistant", "content": [
                { "type": "text", "text": "working on it" },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a" } }
            ] }
        });
        let prompt2 = json!({
            "type": "user", "sessionId": SID, "timestamp": "2026-06-20T09:00:00.000Z",
            "message": { "role": "user", "content": "now the second thing" }
        });
        let asst2 = json!({
            "type": "assistant", "sessionId": SID, "timestamp": "2026-06-20T09:00:01.000Z",
            "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "t2", "name": "Bash", "input": { "command": "ls" } }
            ] }
        });
        let lines = [line(prompt1), line(asst1), line(prompt2), line(asst2)];
        let mut m = JsonlMapper::new(ROOT, SID);
        for l in &lines {
            m.apply_line(l);
        }
        // Items carry their turn.
        let tl = m.timeline();
        assert_eq!(tl.items()[0].tool_call_id, "t1");
        assert_eq!(tl.items()[0].turn, 1);
        assert_eq!(tl.items()[1].tool_call_id, "t2");
        assert_eq!(tl.items()[1].turn, 2);
        // Prompts, answers, dates by turn.
        assert_eq!(m.turns().get(&1).map(String::as_str), Some("do the first thing"));
        assert_eq!(m.turns().get(&2).map(String::as_str), Some("now the second thing"));
        assert_eq!(m.answers().get(&1).map(String::as_str), Some("working on it"));
        assert_eq!(m.answers().get(&2), None, "turn 2 had no assistant text");
        assert_eq!(m.dates().get(&1).map(String::as_str), Some("2026-06-19"));
        assert_eq!(m.dates().get(&2).map(String::as_str), Some("2026-06-20"));
        assert_eq!(m.current_turn(), 2);
    }

    // A tool item's turn is fixed at first sighting; a later result in a
    // different current turn doesn't move it.
    #[test]
    fn item_turn_is_fixed_at_first_sighting() {
        let lines = [
            line(json!({ "type": "user", "sessionId": SID,
                "message": { "role": "user", "content": "prompt A" } })),
            line(asst(json!([
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a" } }
            ]))),
            // A new prompt advances the turn BEFORE t1's result arrives.
            line(json!({ "type": "user", "sessionId": SID,
                "message": { "role": "user", "content": "prompt B" } })),
            line(user(json!([
                { "type": "tool_result", "tool_use_id": "t1", "content": "done" }
            ]))),
        ];
        let mut m = JsonlMapper::new(ROOT, SID);
        for l in &lines {
            m.apply_line(l);
        }
        // t1 opened in turn 1; its later result (current turn 2) keeps turn 1.
        assert_eq!(m.timeline().items()[0].turn, 1);
        assert_eq!(m.timeline().items()[0].agent_status, AgentStatus::Completed);
        assert_eq!(m.current_turn(), 2);
    }

    // codex B-2c: only a *user* bare-string opens a turn. A non-user record with
    // bare-string content (hypothetical assistant/system) must not bump the turn,
    // and non-assistant text blocks must not be counted as an answer.
    #[test]
    fn only_user_bare_string_opens_a_turn() {
        let assistant_string = json!({
            "type": "assistant", "sessionId": SID,
            "message": { "role": "assistant", "content": "I am not a prompt" }
        });
        let system_string = json!({
            "type": "system", "sessionId": SID,
            "message": { "role": "system", "content": "system note" }
        });
        let mut m = JsonlMapper::new(ROOT, SID);
        m.apply_line(&line(assistant_string));
        m.apply_line(&line(system_string));
        assert_eq!(m.current_turn(), 0, "no user prompt -> no turn");
        assert!(m.turns().is_empty());

        // A real user prompt then does open turn 1.
        m.apply_line(&line(json!({
            "type": "user", "sessionId": SID,
            "message": { "role": "user", "content": "the real prompt" }
        })));
        assert_eq!(m.current_turn(), 1);
        assert_eq!(m.turns().get(&1).map(String::as_str), Some("the real prompt"));
    }

    // Interactive Claude records a prompt as a text-block ARRAY (not a bare
    // string). It must still open a turn; a tool_result array must not.
    #[test]
    fn user_text_blocks_open_a_turn() {
        let prompt = json!({
            "type": "user", "sessionId": SID, "timestamp": "2026-06-19T08:00:00.000Z",
            "message": { "role": "user", "content": [{ "type": "text", "text": "fix the bug" }] }
        });
        let tool_result = json!({
            "type": "user", "sessionId": SID,
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "x", "content": "ok" }
            ] }
        });
        let mut m = JsonlMapper::new(ROOT, SID);
        m.apply_line(&line(prompt));
        assert_eq!(m.current_turn(), 1);
        assert_eq!(m.turns().get(&1).map(String::as_str), Some("fix the bug"));
        m.apply_line(&line(tool_result));
        assert_eq!(m.current_turn(), 1, "a tool_result array is not a new prompt");
        assert_eq!(m.turns().len(), 1);
    }

    // B1: assistant `usage` accumulates into the current turn's token total.
    #[test]
    fn accumulates_token_usage_per_turn() {
        let mut m = JsonlMapper::new(ROOT, SID);
        m.apply_line(&line(json!({
            "type": "user", "sessionId": SID,
            "message": { "role": "user", "content": [{ "type": "text", "text": "go" }] }
        })));
        m.apply_line(&line(json!({
            "type": "assistant", "sessionId": SID,
            "message": { "role": "assistant",
                "usage": { "input_tokens": 100, "output_tokens": 50,
                           "cache_read_input_tokens": 2000, "cache_creation_input_tokens": 300 },
                "content": [{ "type": "text", "text": "ok" }] }
        })));
        m.apply_line(&line(json!({
            "type": "assistant", "sessionId": SID,
            "message": { "role": "assistant",
                "usage": { "input_tokens": 10, "output_tokens": 20 }, "content": [] }
        })));
        let t = m.tokens().get(&1).expect("turn 1 tokens");
        assert_eq!(t.input, 110);
        assert_eq!(t.output, 70);
        assert_eq!(t.cache_read, 2000);
        assert_eq!(t.cache_creation, 300);
    }

    // B1: an extended-thinking block becomes a Think item (reasoning flow).
    #[test]
    fn thinking_becomes_a_think_item() {
        let lines = [line(json!({
            "type": "assistant", "sessionId": SID, "uuid": "msg-1",
            "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "Let me reason about this.\nStep two." },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/x" } }
            ] }
        }))];
        let tl = map_lines(&lines);
        assert_eq!(tl.items().len(), 2, "a think item + the tool item");
        let think = tl.items().iter().find(|i| i.kind == ItemKind::Think).unwrap();
        assert_eq!(think.tool_call_id, "think:msg-1:0", "deterministic id for re-tail merge");
        assert_eq!(think.title, "Let me reason about this.");
        assert_eq!(
            think.content_text.as_deref(),
            Some("Let me reason about this.\nStep two.")
        );
        assert_eq!(think.agent_status, AgentStatus::Completed);
        // The think item precedes the tool item (seq order = flow).
        assert!(think.seq < tl.items().iter().find(|i| i.kind == ItemKind::Read).unwrap().seq);
    }

    // A record that omits sessionId falls back to the file's session uuid.
    #[test]
    fn missing_session_id_uses_fallback() {
        let rec = json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/x" } }
            ] },
        });
        let tl = map_lines(&[line(rec)]);
        assert_eq!(tl.items()[0].session_id, SID);
    }
}
