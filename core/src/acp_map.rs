//! Map ACP `session/update` tool-call events to internal **timeline items**
//! (P2b-2 S2a).
//!
//! This is the synchronous, deterministic ACP mapper: it turns the agent's
//! `tool_call` / `tool_call_update` notifications into merged [`TimelineItem`]s
//! on a shared [`Timeline`]. It performs **no disk writes and no async** — the
//! only filesystem touch is read-only marker probing for the project label (via
//! [`Timeline::label_for`]). Keeping it in the headless `core` lets
//! `cargo test -p core` cover the mapping with recorded fixtures, with no
//! `npx`/runtime in the loop (design D1 / spec §2).
//!
//! The timeline **types** and **accumulator mechanics** live in
//! [`crate::timeline`]; this module owns only the ACP-specific field extraction.
//! It drives the accumulator through [`Timeline::entry`] / [`Timeline::item_mut`]
//! — the same primitives the JSONL mapper ([`crate::jsonl`]) uses (P2b-4).
//!
//! Merge model (spec §2, codex #7/#8):
//! - Items are keyed by `(session_id, tool_call_id)`; a `tool_call_update`
//!   merges into the existing item, bumping `revision` (even after `completed`).
//! - `seq` is assigned once, on first sighting, in client **receive order**.
//! - `cancel_open` closes still-running items as `Canceled` (≠ `Failed`).

use std::path::PathBuf;

use agent_client_protocol_schema::{
    ContentBlock, SessionUpdate, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate,
    ToolKind,
};

use crate::timeline::{AgentStatus, FileDiff, ItemKind, Timeline};

impl Timeline {
    /// Apply one `session/update`. Returns the affected item's index for
    /// `tool_call` / `tool_call_update`; other update kinds (message, plan,
    /// thought, …) are not timeline items and return `None`.
    pub fn apply(&mut self, session_id: &str, update: &SessionUpdate) -> Option<usize> {
        match update {
            SessionUpdate::ToolCall(tc) => Some(self.upsert_call(session_id, tc)),
            SessionUpdate::ToolCallUpdate(tu) => Some(self.apply_update(session_id, tu)),
            _ => None,
        }
    }

    /// Insert (or, for a re-sent id, merge) a full `tool_call`.
    fn upsert_call(&mut self, session_id: &str, tc: &ToolCall) -> usize {
        let locations: Vec<PathBuf> = tc.locations.iter().map(|l| l.path.clone()).collect();
        let project_label = self.label_for(&locations);
        let diffs = extract_diffs(&tc.content);
        let content_text = extract_content_text(&tc.content);

        // A re-sent full tool_call (e.g. a retry reusing the id) is the new
        // authoritative state, so every collection is overwritten and revision
        // bumped; a first sighting fills the blank shell and stays revision 0.
        let (idx, is_new) = self.entry(session_id, tc.id.0.as_ref());
        let item = self.item_mut(idx);
        item.kind = map_kind(tc.kind);
        item.title = tc.title.clone();
        item.locations = locations;
        item.project_label = project_label;
        item.diffs = diffs;
        item.content_text = content_text;
        if tc.raw_input.is_some() {
            item.raw_input = tc.raw_input.clone();
        }
        item.agent_status = map_status(tc.status);
        if !is_new {
            item.revision += 1;
        }
        idx
    }

    /// Merge a `tool_call_update`. If the id is unknown (ACP allows a call to be
    /// described purely by updates), [`Timeline::entry`] constructs a fresh item
    /// first; `merge_fields` then bumps its revision.
    fn apply_update(&mut self, session_id: &str, tu: &ToolCallUpdate) -> usize {
        let (idx, _is_new) = self.entry(session_id, tu.id.0.as_ref());
        self.merge_fields(idx, tu)
    }

    /// Apply the optional fields of an update onto an existing item.
    fn merge_fields(&mut self, idx: usize, tu: &ToolCallUpdate) -> usize {
        let f = &tu.fields;
        // Compute label outside the borrow if locations change.
        let new_label = f.locations.as_ref().map(|locs| {
            let paths: Vec<PathBuf> = locs.iter().map(|l| l.path.clone()).collect();
            (paths.clone(), self.label_for(&paths))
        });
        let new_diffs = f.content.as_ref().map(|c| extract_diffs(c));
        let new_content_text = f.content.as_ref().map(|c| extract_content_text(c));

        let item = self.item_mut(idx);
        if let Some(k) = f.kind {
            item.kind = map_kind(k);
        }
        if let Some(s) = f.status {
            item.agent_status = map_status(s);
        }
        if let Some(t) = &f.title {
            item.title = t.clone();
        }
        if let Some((paths, label)) = new_label {
            item.locations = paths;
            item.project_label = label;
        }
        // ACP overwrites collections: a present `content` field replaces diffs
        // and content text (even with an empty set); an absent field leaves them.
        if let Some(diffs) = new_diffs {
            item.diffs = diffs;
        }
        if let Some(text) = new_content_text {
            item.content_text = text;
        }
        if let Some(input) = &f.raw_input {
            item.raw_input = Some(input.clone());
        }
        item.revision += 1;
        idx
    }
}

fn map_kind(kind: ToolKind) -> ItemKind {
    match kind {
        ToolKind::Read => ItemKind::Read,
        ToolKind::Edit => ItemKind::Edit,
        ToolKind::Delete => ItemKind::Delete,
        ToolKind::Move => ItemKind::Move,
        ToolKind::Search => ItemKind::Search,
        ToolKind::Execute => ItemKind::Execute,
        ToolKind::Think => ItemKind::Think,
        ToolKind::Fetch => ItemKind::Fetch,
        // `SwitchMode` and any other non-file/exec kinds collapse to `Other`.
        _ => ItemKind::Other,
    }
}

fn map_status(status: ToolCallStatus) -> AgentStatus {
    match status {
        ToolCallStatus::Pending => AgentStatus::Pending,
        ToolCallStatus::InProgress => AgentStatus::InProgress,
        ToolCallStatus::Completed => AgentStatus::Completed,
        ToolCallStatus::Failed => AgentStatus::Failed,
    }
}

/// Pull file diffs out of tool-call content (drops text/terminal content).
fn extract_diffs(content: &[ToolCallContent]) -> Vec<FileDiff> {
    content
        .iter()
        .filter_map(|c| match c {
            ToolCallContent::Diff { diff } => Some(FileDiff {
                path: diff.path.clone(),
                old_text: diff.old_text.clone(),
                new_text: diff.new_text.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// Concatenate the text content blocks of a tool call (a read's content, a
/// search/exec output, an explanation) for the detail view (B4). `None` if there
/// is no text content.
fn extract_content_text(content: &[ToolCallContent]) -> Option<String> {
    let mut out = String::new();
    for c in content {
        if let ToolCallContent::Content {
            content: ContentBlock::Text(t),
        } = c
        {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&t.text);
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::WriteStatus;
    use serde_json::json;

    // Build a SessionUpdate from a JSON value (a recorded `session/update`
    // payload), exercising the same deserialization the live client uses.
    fn update_from_json(v: serde_json::Value) -> SessionUpdate {
        serde_json::from_value(v).expect("valid session/update")
    }

    fn tool_call(id: &str, kind: &str, status: &str, path: &str) -> SessionUpdate {
        update_from_json(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": id,
            "title": format!("{kind} {path}"),
            "kind": kind,
            "status": status,
            "locations": [{ "path": path }],
        }))
    }

    fn tool_call_update(id: &str, status: &str) -> SessionUpdate {
        update_from_json(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": id,
            "status": status,
        }))
    }

    #[test]
    fn maps_tool_call_fields() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "read", "in_progress", "/work/src/main.rs"));

        let item = &tl.items()[0];
        assert_eq!(item.session_id, "s1");
        assert_eq!(item.tool_call_id, "t1");
        assert_eq!(item.seq, 0);
        assert_eq!(item.kind, ItemKind::Read);
        assert_eq!(item.agent_status, AgentStatus::InProgress);
        assert_eq!(item.write_status, WriteStatus::None);
        assert_eq!(item.locations, vec![PathBuf::from("/work/src/main.rs")]);
        assert_eq!(item.revision, 0);
    }

    #[test]
    fn merges_update_into_same_item_and_bumps_revision() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "edit", "pending", "/work/a.rs"));
        tl.apply("s1", &tool_call_update("t1", "in_progress"));
        tl.apply("s1", &tool_call_update("t1", "completed"));

        assert_eq!(tl.items().len(), 1, "same (session,id) stays one item");
        let item = &tl.items()[0];
        assert_eq!(item.agent_status, AgentStatus::Completed);
        assert_eq!(item.seq, 0, "seq assigned once");
        assert_eq!(item.revision, 2, "two updates merged");
    }

    #[test]
    fn late_update_after_completed_still_revisions() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "edit", "completed", "/work/a.rs"));
        tl.apply("s1", &tool_call_update("t1", "failed"));
        let item = &tl.items()[0];
        assert_eq!(item.agent_status, AgentStatus::Failed);
        assert_eq!(item.revision, 1);
    }

    #[test]
    fn agent_status_and_write_status_are_independent() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "edit", "completed", "/work/a.rs"));
        // Agent says completed, but our disk write failed — tracked separately.
        assert!(tl.set_write_status("s1", "t1", WriteStatus::WriteFailed));
        let item = &tl.items()[0];
        assert_eq!(item.agent_status, AgentStatus::Completed);
        assert_eq!(item.write_status, WriteStatus::WriteFailed);
    }

    #[test]
    fn constructs_item_from_update_for_unseen_id() {
        let mut tl = Timeline::new("/work");
        // No prior tool_call — only an update arrives.
        tl.apply("s1", &tool_call_update("t9", "completed"));
        assert_eq!(tl.items().len(), 1);
        let item = &tl.items()[0];
        assert_eq!(item.tool_call_id, "t9");
        assert_eq!(item.agent_status, AgentStatus::Completed);
    }

    #[test]
    fn seq_is_monotonic_in_receive_order() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "read", "completed", "/work/a"));
        tl.apply("s1", &tool_call("t2", "edit", "pending", "/work/b"));
        tl.apply("s1", &tool_call_update("t1", "completed")); // does not reorder
        assert_eq!(tl.items()[0].seq, 0);
        assert_eq!(tl.items()[1].seq, 1);
    }

    #[test]
    fn cancel_open_closes_only_running_items() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "edit", "completed", "/work/a"));
        tl.apply("s1", &tool_call("t2", "execute", "in_progress", "/work/b"));
        tl.apply("s1", &tool_call("t3", "read", "pending", "/work/c"));
        tl.cancel_open();

        assert_eq!(tl.items()[0].agent_status, AgentStatus::Completed); // untouched
        assert_eq!(tl.items()[1].agent_status, AgentStatus::Canceled);
        assert_eq!(tl.items()[2].agent_status, AgentStatus::Canceled);
    }

    #[test]
    fn extracts_diff_content() {
        let mut tl = Timeline::new("/work");
        let update = update_from_json(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "title": "edit",
            "kind": "edit",
            "status": "completed",
            "content": [{
                "type": "diff",
                "path": "/work/a.rs",
                "oldText": "old",
                "newText": "new",
            }],
            "locations": [{ "path": "/work/a.rs" }],
        }));
        tl.apply("s1", &update);
        let item = &tl.items()[0];
        assert_eq!(item.diffs.len(), 1);
        assert_eq!(item.diffs[0].path, PathBuf::from("/work/a.rs"));
        assert_eq!(item.diffs[0].old_text.as_deref(), Some("old"));
        assert_eq!(item.diffs[0].new_text, "new");
    }

    #[test]
    fn set_write_status_by_path_attaches_to_latest_match() {
        let mut tl = Timeline::new("/work");
        tl.apply("s1", &tool_call("t1", "edit", "completed", "/work/a.rs"));
        tl.apply("s1", &tool_call("t2", "edit", "completed", "/work/b.rs"));
        // A later edit re-touching a.rs — the write should attach to the latest.
        tl.apply("s1", &tool_call("t3", "edit", "in_progress", "/work/a.rs"));

        let idx = tl
            .set_write_status_by_path(std::path::Path::new("/work/a.rs"), WriteStatus::Written)
            .expect("a path match");
        assert_eq!(tl.items()[idx].tool_call_id, "t3");
        assert_eq!(tl.items()[idx].write_status, WriteStatus::Written);
        // The earlier a.rs item is untouched.
        assert_eq!(tl.items()[0].write_status, WriteStatus::None);
        // Unknown path -> no match.
        assert!(tl
            .set_write_status_by_path(std::path::Path::new("/work/zzz"), WriteStatus::Written)
            .is_none());
    }

    #[test]
    fn update_with_content_overwrites_diffs() {
        let mut tl = Timeline::new("/work");
        // Start with a diff...
        tl.apply(
            "s1",
            &update_from_json(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "edit",
                "kind": "edit",
                "status": "in_progress",
                "content": [{ "type": "diff", "path": "/work/a.rs", "oldText": "x", "newText": "y" }],
            })),
        );
        assert_eq!(tl.items()[0].diffs.len(), 1);

        // ...then an update whose content is present but diff-less overwrites it
        // (ACP collection-overwrite semantics — codex S2a finding).
        tl.apply(
            "s1",
            &update_from_json(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "content": [{ "type": "content", "content": { "type": "text", "text": "done" } }],
            })),
        );
        assert!(tl.items()[0].diffs.is_empty(), "present content overwrites diffs");

        // A status-only update (no content field) leaves diffs untouched.
        tl.apply("s1", &tool_call_update("t1", "completed"));
        assert!(tl.items()[0].diffs.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn label_resolves_symlinked_path() {
        use std::fs;
        let tmp = {
            let base = std::env::temp_dir();
            use std::sync::atomic::{AtomicU64, Ordering};
            static N: AtomicU64 = AtomicU64::new(0);
            let d = base.join(format!(
                "mt-acp-sym-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            d
        };
        let root = tmp.join("root");
        let real = root.join("realproj");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("Cargo.toml"), b"").unwrap();
        // A symlink inside root pointing at realproj.
        let link = root.join("linkproj");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut tl = Timeline::new(&root);
        // Edit reached via the symlink; canonicalization attributes it to the
        // real target folder.
        let upd = update_from_json(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "t1",
            "title": "edit",
            "kind": "edit",
            "status": "completed",
            "locations": [{ "path": link.join("src.rs").to_string_lossy() }],
        }));
        tl.apply("s1", &upd);
        assert_eq!(tl.items()[0].project_label.as_deref(), Some("realproj"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ignores_non_tool_call_updates() {
        let mut tl = Timeline::new("/work");
        let msg = update_from_json(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hi" },
        }));
        assert_eq!(tl.apply("s1", &msg), None);
        assert!(tl.items().is_empty());
    }
}
