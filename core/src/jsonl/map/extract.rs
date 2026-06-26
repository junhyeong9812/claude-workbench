//! Pure extraction helpers for the JSONL mapper: tool-name → kind, input →
//! locations/diffs/title, usage parsing, and text concatenation. Each is a
//! side-effect-free function over `serde_json::Value` shapes.

use std::path::PathBuf;

use serde_json::Value;

use crate::timeline::{FileDiff, ItemKind, TokenUsage};

/// Map a Claude Code tool name to a timeline [`ItemKind`]. Unknown / future
/// tools (MCP tools, `Task`, `TodoWrite`, `AskUserQuestion`, …) collapse to
/// `Other`; subagent (`Task`) and question (`AskUserQuestion`) handling is a
/// later phase (B1/B2).
pub(super) fn map_tool_kind(name: &str) -> ItemKind {
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
pub(super) fn is_interrupt_text(s: &str) -> bool {
    let t = s.trim();
    t == "[Request interrupted by user]" || t == "[Request interrupted by user for tool use]"
}

/// The file path(s) a tool touches, for labelling and the detail view.
pub(super) fn locations_from_input(input: &Value) -> Vec<PathBuf> {
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
pub(super) fn diffs_from_input(name: &str, input: &Value) -> Vec<FileDiff> {
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
pub(super) fn derive_title(name: &str, input: &Value) -> String {
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
pub(super) fn parse_usage(u: &Value) -> TokenUsage {
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
pub(super) fn concat_text_blocks(blocks: &[Value]) -> Option<String> {
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
pub(super) fn extract_result_text(content: &Value) -> Option<String> {
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
