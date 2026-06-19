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

use std::path::PathBuf;

use serde_json::Value;

use crate::jsonl::record::{Content, ContentBlock, RawRecord};
use crate::timeline::{AgentStatus, FileDiff, ItemKind, Timeline};

/// A [`Timeline`] fed line-by-line from one session's JSONL file. One file is
/// one session; `session_id` is the file's UUID, used as a fallback when a
/// record omits its own `sessionId`.
pub struct JsonlMapper {
    timeline: Timeline,
    session_id: String,
}

impl JsonlMapper {
    pub fn new(root: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self {
            timeline: Timeline::new(root),
            session_id: session_id.into(),
        }
    }

    /// Parse and apply one transcript line. Malformed / non-timeline lines are
    /// skipped (empty result). Returns the indices of items touched.
    pub fn apply_line(&mut self, line: &str) -> Vec<usize> {
        match RawRecord::parse_line(line) {
            Some(rec) => apply_record(&mut self.timeline, &rec, &self.session_id),
            None => Vec::new(),
        }
    }

    pub fn timeline(&self) -> &Timeline {
        &self.timeline
    }

    pub fn into_timeline(self) -> Timeline {
        self.timeline
    }
}

/// Apply one parsed record to `timeline`, returning the indices of touched
/// items (empty for records that carry no `tool_use` / `tool_result`).
/// `fallback_session` is used when the record omits `sessionId`.
pub fn apply_record(
    timeline: &mut Timeline,
    rec: &RawRecord,
    fallback_session: &str,
) -> Vec<usize> {
    let session = rec.session_id.as_deref().unwrap_or(fallback_session);

    let blocks = match rec.message.as_ref().and_then(|m| m.content.as_ref()) {
        Some(Content::Blocks(b)) => b,
        // A bare-string prompt or a record without message content carries no
        // timeline items.
        _ => return Vec::new(),
    };

    let mut touched = Vec::new();
    for value in blocks {
        // Parse each block individually so one malformed/odd element is skipped
        // without losing its valid siblings in the same record (spec ⑤).
        let Ok(block) = serde_json::from_value::<ContentBlock>(value.clone()) else {
            continue;
        };
        match block {
            ContentBlock::ToolUse { id, name, input } => {
                touched.push(open_tool_use(timeline, session, &id, &name, &input));
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                touched.push(complete_tool_result(
                    timeline,
                    session,
                    &tool_use_id,
                    &content,
                    is_error,
                ));
            }
            // Text (turn answer) and thinking (reasoning) are not timeline items
            // in Phase A; unknown blocks are ignored.
            _ => {}
        }
    }
    touched
}

/// Open (or, for a re-sent id, refresh) the timeline item for a `tool_use`.
fn open_tool_use(
    timeline: &mut Timeline,
    session: &str,
    id: &str,
    name: &str,
    input: &Value,
) -> usize {
    let locations = locations_from_input(input);
    let project_label = timeline.label_for(&locations);
    let diffs = diffs_from_input(name, input);
    let title = derive_title(name, input);

    let (idx, is_new) = timeline.entry(session, id);
    let item = timeline.item_mut(idx);
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
    tool_use_id: &str,
    content: &Value,
    is_error: Option<bool>,
) -> usize {
    let text = extract_result_text(content);

    let (idx, _is_new) = timeline.entry(session, tool_use_id);
    let item = timeline.item_mut(idx);
    item.agent_status = if is_error == Some(true) {
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
        _ => ItemKind::Other,
    }
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
    if let Some(p) = input.get("file_path").and_then(Value::as_str) {
        return format!("{name} {p}");
    }
    name.to_string()
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
        assert_eq!(tl.items().len(), 1, "only the real tool_use is an item");
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
