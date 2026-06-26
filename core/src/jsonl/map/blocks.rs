//! Block-application helpers: turn one record's content blocks into timeline
//! item mutations (open a `tool_use`, complete a `tool_result`, record a
//! `thinking` item). These drive the shared [`Timeline`] accumulator.

use serde_json::Value;

use crate::jsonl::record::ContentBlock;
use crate::timeline::{AgentStatus, ItemKind, Timeline};

use super::extract::{
    derive_title, diffs_from_input, extract_result_text, locations_from_input, map_tool_kind,
};

/// Apply one record's content blocks at `turn`. Returns `(touched item indices,
/// concatenated assistant answer text from this record)`. Each block is parsed
/// individually so one malformed/odd element is skipped without losing its valid
/// siblings (spec ⑤).
pub(super) fn apply_blocks(
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
pub(super) fn open_thinking(timeline: &mut Timeline, session: &str, turn: u64, id: &str, thinking: &str) -> usize {
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
pub(super) fn open_tool_use(
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
pub(super) fn complete_tool_result(
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
