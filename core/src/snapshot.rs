//! Per-session change-timeline **snapshots** (P2b-4 session UX, D-1 persistence).
//!
//! Architecture A keeps its own copy of each Claude session's timeline (the
//! user's D-1 choice) so sessions survive an app restart and can be listed and
//! reopened — independent of the CLI's own transcript. Unlike the ACP path
//! (append-one-line-per-event), we write a **whole-session snapshot** that is
//! *overwritten* on each change: re-tailing the CLI JSONL replays the full
//! state, and overwriting avoids the duplicate/cumulative records that
//! append-per-event produced on resume (codex B-2b F2/F3).
//!
//! Layout (one JSON file per session, keyed by project + session uuid):
//! ```text
//! <base>/projects/<project_key>/claude/<uuid>.json
//! ```

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::history::project_key;
use crate::timeline::{TimelineItem, TokenUsage};

/// Process-unique suffix counter for temp files, so concurrent writers (even for
/// the same uuid) never race on a shared temp path (codex session-UX F2).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Reject a uuid that isn't a plain identifier so a command-supplied value can't
/// traverse out of the project's `claude` dir (`..`, `/`, …) — our generated
/// session ids are `[0-9a-f-]` (codex session-UX F5).
fn is_safe_uuid(uuid: &str) -> bool {
    !uuid.is_empty()
        && uuid.len() <= 128
        && uuid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn unique_tmp(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!(
        "{stem}.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The full persisted state of one session's timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub uuid: String,
    /// Display name ("Claude N" or a rename).
    pub name: String,
    /// Day the session was last updated (YYYY-MM-DD).
    pub date: String,
    pub items: Vec<TimelineItem>,
    pub turns: Vec<(u64, String)>,
    pub answers: Vec<(u64, String)>,
    pub dates: Vec<(u64, String)>,
    #[serde(default)]
    pub tokens: Vec<(u64, TokenUsage)>,
    /// The session this task continues from (handoff chain). `None` = chain root.
    /// Sourced from the decoupled `<uuid>.task` sidecar on [`load`] (see
    /// [`read_task_meta`]) so the poll thread's body overwrite never clobbers it —
    /// the same decoupling the rename uses (`.name`, codex session-UX F1).
    #[serde(default)]
    pub prev_uuid: Option<String>,
    /// Filesystem path of the handoff summary this task was seeded with, if any.
    /// Also sidecar-sourced.
    #[serde(default)]
    pub summary_path: Option<String>,
}

/// A session summarized for the reopen picker.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotSummary {
    pub uuid: String,
    pub name: String,
    /// First prompt of the session (its lowest turn), shown as subtext.
    pub title: String,
    pub date: String,
    /// Number of tool-call items recorded.
    pub count: usize,
}

fn dir(base: &Path, project: &str) -> PathBuf {
    base.join("projects").join(project_key(project)).join("claude")
}

/// Write (overwrite) a session snapshot **body** atomically (unique temp +
/// rename). The display name is kept in a separate `.name` file (see
/// [`save_name`]) so a rename and the poll thread never clobber each other.
pub fn save(base: &Path, project: &str, snap: &SessionSnapshot) -> io::Result<()> {
    if !is_safe_uuid(&snap.uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string(snap)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp_path = unique_tmp(&dir, &format!("{}.json", snap.uuid));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, dir.join(format!("{}.json", snap.uuid)))
}

/// Override a session's display name without touching its timeline body
/// (rename). Decoupled into its own file so the poll thread (sole writer of the
/// `.json`) and a rename write **different** files and can't clobber each other
/// (codex session-UX F1).
pub fn save_name(base: &Path, project: &str, uuid: &str, name: &str) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.name"));
    fs::write(&tmp_path, name)?;
    fs::rename(&tmp_path, dir.join(format!("{uuid}.name")))
}

/// The renamed display name override, if any (else the snapshot's own name).
pub fn read_name(base: &Path, project: &str, uuid: &str) -> Option<String> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    fs::read_to_string(dir(base, project).join(format!("{uuid}.name")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Task-identity metadata kept in a decoupled `<uuid>.task` sidecar so the poll
/// thread's whole-body overwrite of the `.json` never clobbers it (the same
/// reason a rename lives in `.name` — codex session-UX F1). Holds the handoff
/// chain link (`prev_uuid`) and the seed summary this task started from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskMeta {
    #[serde(default)]
    pub prev_uuid: Option<String>,
    #[serde(default)]
    pub summary_path: Option<String>,
}

/// Persist a session's task metadata to its `<uuid>.task` sidecar (atomic
/// temp+rename). Decoupled from the body so the poll thread and a handoff write
/// **different** files and can't clobber each other.
pub fn save_task_meta(base: &Path, project: &str, uuid: &str, meta: &TaskMeta) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    // Reject an unsafe chain link at write time too, so a caller bug surfaces here
    // rather than silently truncating the chain later when `load` skips it.
    if let Some(prev) = &meta.prev_uuid {
        if !is_safe_uuid(prev) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "unsafe prev session id",
            ));
        }
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let json =
        serde_json::to_string(meta).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.task"));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, dir.join(format!("{uuid}.task")))
}

/// Read a session's task metadata sidecar, if present and valid (else `None`).
pub fn read_task_meta(base: &Path, project: &str, uuid: &str) -> Option<TaskMeta> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    let text = fs::read_to_string(dir(base, project).join(format!("{uuid}.task"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Path of a session's handoff-summary sidecar (`<uuid>.summary.md`). `None` for
/// an unsafe uuid. The file may not exist yet — the backend derives this rather
/// than trusting a caller-supplied path (codex P3 D8).
pub fn summary_path(base: &Path, project: &str, uuid: &str) -> Option<PathBuf> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    Some(dir(base, project).join(format!("{uuid}.summary.md")))
}

/// Write (overwrite) a session's handoff summary to its `<uuid>.summary.md`
/// sidecar atomically (temp+rename, so a crash never leaves a partial summary).
/// Returns the final path.
pub fn save_summary(base: &Path, project: &str, uuid: &str, text: &str) -> io::Result<PathBuf> {
    if !is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let tmp_path = unique_tmp(&dir, &format!("{uuid}.summary.md"));
    fs::write(&tmp_path, text)?;
    let final_path = dir.join(format!("{uuid}.summary.md"));
    fs::rename(&tmp_path, &final_path)?;
    Ok(final_path)
}

/// List the saved sessions for a project, newest first (by date, then name).
pub fn list(base: &Path, project: &str) -> Vec<SnapshotSummary> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir(base, project)) {
        Ok(e) => e,
        Err(_) => return out, // no sessions yet
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue; // skip *.json.tmp and strays
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(snap) = serde_json::from_str::<SessionSnapshot>(&text) else {
            continue;
        };
        let title = snap
            .turns
            .iter()
            .min_by_key(|(t, _)| *t)
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
        let name = read_name(base, project, &snap.uuid).unwrap_or(snap.name);
        out.push(SnapshotSummary {
            uuid: snap.uuid,
            name,
            title,
            date: snap.date,
            count: snap.items.len(),
        });
    }
    out.sort_by(|a, b| b.date.cmp(&a.date).then(a.name.cmp(&b.name)));
    out
}

/// Load one session's full snapshot (for reopen), applying the name override.
/// `None` if absent/corrupt/unsafe id.
pub fn load(base: &Path, project: &str, uuid: &str) -> Option<SessionSnapshot> {
    if !is_safe_uuid(uuid) {
        return None;
    }
    let path = dir(base, project).join(format!("{uuid}.json"));
    let text = fs::read_to_string(path).ok()?;
    let mut snap: SessionSnapshot = serde_json::from_str(&text).ok()?;
    // The requested (filename-derived, already validated) uuid is authoritative —
    // a corrupt body claiming a different uuid must not mislead chain rendering.
    snap.uuid = uuid.to_string();
    if let Some(name) = read_name(base, project, uuid) {
        snap.name = name;
    }
    // Task meta is sidecar-authoritative (the body is overwritten by the poll
    // thread with `None`), so override from the `.task` file when present.
    if let Some(meta) = read_task_meta(base, project, uuid) {
        snap.prev_uuid = meta.prev_uuid;
        snap.summary_path = meta.summary_path;
    }
    Some(snap)
}

/// Reconstruct a handoff chain: walk `prev_uuid` from `head` back to the root and
/// return the sessions **oldest-first**, so the UI can render one continuous
/// timeline across restarts (each task is a separate session). The link is
/// followed via the `.task` sidecar — which exists even before a just-restarted
/// head has saved a snapshot body — so the chain still reaches the previous tasks
/// that *do* have snapshots (a head with no snapshot is simply absent from the
/// result, not a dead end). A cycle (corrupt `prev_uuid`) is bounded by a visited
/// set so it can't loop forever.
pub fn load_chain(base: &Path, project: &str, head: &str) -> Vec<SessionSnapshot> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut cur = Some(head.to_string());
    while let Some(uuid) = cur {
        if !seen.insert(uuid.clone()) {
            break; // cycle guard
        }
        let next = read_task_meta(base, project, &uuid).and_then(|m| m.prev_uuid);
        if let Some(snap) = load(base, project, &uuid) {
            chain.push(snap);
        }
        cur = next;
    }
    chain.reverse(); // oldest-first
    chain
}

/// Char-boundary-safe truncation with an ellipsis, so a long prompt/answer can't
/// blow the handoff prompt (and never panics on a multi-byte boundary).
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// Render a session's timeline as compact text for a handoff-summary prompt
/// (`claude -p`): each turn's user prompt, the assistant's answer, and the files
/// that turn changed. Bounded by the caps below so a huge session can't blow the
/// prompt — only the most recent `MAX_TURNS` are kept (most relevant to a
/// hand-off), with a note about how many older turns were dropped (no silent
/// truncation). Subagent-only file changes are not enumerated here (the snapshot
/// body doesn't persist them — the spawning Agent/Task call and its result are).
pub fn render_for_summary(snap: &SessionSnapshot) -> String {
    use std::fmt::Write as _;
    const MAX_TURNS: usize = 200;
    const MAX_TEXT: usize = 800; // per prompt/answer char cap
    const MAX_FILES_PER_TURN: usize = 40;

    let mut out = String::new();
    let _ = writeln!(
        out,
        "# 이전 작업(task) 타임라인 — \"{}\" ({})",
        snap.name, snap.date
    );

    let answers: std::collections::HashMap<u64, &String> =
        snap.answers.iter().map(|(t, a)| (*t, a)).collect();
    let mut files_by_turn: std::collections::BTreeMap<u64, Vec<String>> = Default::default();
    for it in &snap.items {
        for d in &it.diffs {
            files_by_turn
                .entry(it.turn)
                .or_default()
                .push(d.path.display().to_string());
        }
    }

    let mut turns = snap.turns.clone();
    turns.sort_by_key(|(t, _)| *t);
    let total = turns.len();
    let start = total.saturating_sub(MAX_TURNS);
    if start > 0 {
        let _ = writeln!(out, "\n(앞 {start} turn 생략 — 최근 {MAX_TURNS} turn만)");
    }
    for (t, prompt) in turns.iter().skip(start) {
        let _ = writeln!(out, "\n## Turn {t}");
        let _ = writeln!(out, "- 사용자: {}", truncate_chars(prompt, MAX_TEXT));
        if let Some(ans) = answers.get(t) {
            let _ = writeln!(out, "- 어시스턴트: {}", truncate_chars(ans, MAX_TEXT));
        }
        if let Some(files) = files_by_turn.get(t) {
            let mut uniq: Vec<&String> = files.iter().collect();
            uniq.sort();
            uniq.dedup();
            if !uniq.is_empty() {
                let shown: Vec<&str> = uniq.iter().take(MAX_FILES_PER_TURN).map(|s| s.as_str()).collect();
                let _ = writeln!(out, "- 변경 파일: {}", shown.join(", "));
                if uniq.len() > MAX_FILES_PER_TURN {
                    let _ = writeln!(out, "  (외 {}개 생략)", uniq.len() - MAX_FILES_PER_TURN);
                }
            }
        }
    }
    out
}

/// Delete a session's snapshot body + name override (the `삭제` action). Missing
/// files / unsafe ids are not an error.
pub fn delete(base: &Path, project: &str, uuid: &str) -> io::Result<()> {
    if !is_safe_uuid(uuid) {
        return Ok(());
    }
    let dir = dir(base, project);
    for path in [
        dir.join(format!("{uuid}.json")),
        dir.join(format!("{uuid}.name")),
        dir.join(format!("{uuid}.task")),
        dir.join(format!("{uuid}.summary.md")),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{Timeline, TimelineItem};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_base(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-snap-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn snap(uuid: &str, name: &str, date: &str, item_count: usize) -> SessionSnapshot {
        // Build `item_count` shells via a Timeline so they're real TimelineItems.
        let mut tl = Timeline::new("/work");
        for i in 0..item_count {
            tl.entry("s", &format!("t{i}"));
        }
        let items: Vec<TimelineItem> = tl.items().to_vec();
        SessionSnapshot {
            uuid: uuid.to_string(),
            name: name.to_string(),
            date: date.to_string(),
            items,
            turns: vec![(1, "first prompt".into())],
            answers: vec![(1, "an answer".into())],
            dates: vec![(1, date.to_string())],
            tokens: vec![],
            prev_uuid: None,
            summary_path: None,
        }
    }

    #[test]
    fn save_then_load_roundtrips() {
        let base = temp_base("rt");
        let s = snap("u1", "Claude 1", "2026-06-19", 3);
        save(&base, "/home/jun/proj", &s).unwrap();
        let got = load(&base, "/home/jun/proj", "u1").unwrap();
        assert_eq!(got.uuid, "u1");
        assert_eq!(got.name, "Claude 1");
        assert_eq!(got.items.len(), 3);
        assert_eq!(got.turns, vec![(1, "first prompt".to_string())]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn save_overwrites_not_appends() {
        let base = temp_base("ov");
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 2)).unwrap();
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 5)).unwrap();
        // Second save replaced the first — count reflects the latest only.
        assert_eq!(load(&base, "/p", "u1").unwrap().items.len(), 5);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_summarizes_newest_first_and_excludes_tmp() {
        let base = temp_base("ls");
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-18", 1)).unwrap();
        save(&base, "/p", &snap("u2", "Claude 2", "2026-06-20", 4)).unwrap();
        // A stray temp file must not appear as a session.
        fs::write(dir(&base, "/p").join("u3.json.tmp"), b"{}").unwrap();
        let sessions = list(&base, "/p");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].uuid, "u2", "newest date first");
        assert_eq!(sessions[0].title, "first prompt");
        assert_eq!(sessions[0].count, 4);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let base = temp_base("del");
        save(&base, "/p", &snap("u1", "n", "2026-06-19", 1)).unwrap();
        delete(&base, "/p", "u1").unwrap();
        assert!(load(&base, "/p", "u1").is_none());
        delete(&base, "/p", "u1").unwrap(); // idempotent
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn list_missing_project_is_empty() {
        let base = temp_base("empty");
        assert!(list(&base, "/never").is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    // codex F1: a rename (save_name) is decoupled from the body and survives a
    // later body save (the poll thread re-writing the timeline).
    #[test]
    fn rename_via_name_file_survives_body_resave() {
        let base = temp_base("rename");
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-19", 1)).unwrap();
        save_name(&base, "/p", "u1", "내 세션").unwrap();
        assert_eq!(load(&base, "/p", "u1").unwrap().name, "내 세션");
        // The poll thread re-saves the body with its own name; the override wins.
        save(&base, "/p", &snap("u1", "Claude 1", "2026-06-20", 3)).unwrap();
        assert_eq!(load(&base, "/p", "u1").unwrap().name, "내 세션");
        assert_eq!(list(&base, "/p")[0].name, "내 세션");
        let _ = fs::remove_dir_all(&base);
    }

    // codex F5: a path-traversal uuid is rejected, not used as a path component.
    #[test]
    fn unsafe_uuid_is_rejected() {
        let base = temp_base("unsafe");
        assert!(save(&base, "/p", &snap("../evil", "n", "d", 1)).is_err());
        assert!(load(&base, "/p", "../evil").is_none());
        assert!(save_name(&base, "/p", "a/b", "x").is_err());
        assert!(save_task_meta(&base, "/p", "../evil", &TaskMeta::default()).is_err());
        assert!(read_task_meta(&base, "/p", "../evil").is_none());
        // An unsafe chain link is rejected at write time (not silently stored).
        assert!(save_task_meta(
            &base,
            "/p",
            "u1",
            &TaskMeta { prev_uuid: Some("../evil".into()), summary_path: None },
        )
        .is_err());
        delete(&base, "/p", "../evil").unwrap(); // no-op, not an error
        let _ = fs::remove_dir_all(&base);
    }

    // A body claiming a different uuid than its filename is normalized to the
    // requested (validated) uuid, so chain rendering can't be misled.
    #[test]
    fn load_normalizes_uuid_to_request() {
        let base = temp_base("norm");
        let d = dir(&base, "/p");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("u2.json"),
            r#"{"uuid":"u1","name":"n","date":"d","items":[],"turns":[],"answers":[],"dates":[]}"#,
        )
        .unwrap();
        assert_eq!(load(&base, "/p", "u2").unwrap().uuid, "u2");
        let _ = fs::remove_dir_all(&base);
    }

    // A snapshot JSON written before task-meta existed (no prev_uuid/summary_path)
    // still loads — the new fields default to None (serde default, backward compat).
    #[test]
    fn loads_legacy_snapshot_without_task_meta() {
        let base = temp_base("legacy");
        let d = dir(&base, "/p");
        fs::create_dir_all(&d).unwrap();
        let legacy = r#"{"uuid":"u1","name":"n","date":"2026-06-19","items":[],"turns":[],"answers":[],"dates":[]}"#;
        fs::write(d.join("u1.json"), legacy).unwrap();
        let got = load(&base, "/p", "u1").unwrap();
        assert_eq!(got.prev_uuid, None);
        assert_eq!(got.summary_path, None);
        let _ = fs::remove_dir_all(&base);
    }

    // The `.task` sidecar survives a later body re-save (the poll thread rewriting
    // the timeline with prev_uuid: None on the body) — same decoupling as `.name`.
    #[test]
    fn task_meta_sidecar_survives_body_resave() {
        let base = temp_base("taskmeta");
        save(&base, "/p", &snap("u2", "n", "2026-06-19", 1)).unwrap();
        save_task_meta(
            &base,
            "/p",
            "u2",
            &TaskMeta {
                prev_uuid: Some("u1".into()),
                summary_path: Some("/x/summary.md".into()),
            },
        )
        .unwrap();
        // Poll re-saves the body (struct carries prev_uuid: None) — sidecar wins.
        save(&base, "/p", &snap("u2", "n", "2026-06-20", 3)).unwrap();
        let got = load(&base, "/p", "u2").unwrap();
        assert_eq!(got.prev_uuid, Some("u1".to_string()));
        assert_eq!(got.summary_path, Some("/x/summary.md".to_string()));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn load_chain_walks_prev_uuid_oldest_first() {
        let base = temp_base("chain");
        for u in ["u1", "u2", "u3"] {
            save(&base, "/p", &snap(u, "n", "2026-06-19", 1)).unwrap();
        }
        // u1 <- u2 <- u3 (u3 is the head/newest task).
        save_task_meta(&base, "/p", "u2", &TaskMeta { prev_uuid: Some("u1".into()), summary_path: None }).unwrap();
        save_task_meta(&base, "/p", "u3", &TaskMeta { prev_uuid: Some("u2".into()), summary_path: None }).unwrap();
        let chain = load_chain(&base, "/p", "u3");
        let uuids: Vec<_> = chain.iter().map(|s| s.uuid.as_str()).collect();
        assert_eq!(uuids, vec!["u1", "u2", "u3"], "oldest-first");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn load_chain_is_bounded_on_cycle() {
        let base = temp_base("cycle");
        save(&base, "/p", &snap("a", "n", "d", 1)).unwrap();
        save(&base, "/p", &snap("b", "n", "d", 1)).unwrap();
        // a <-> b (corrupt cycle): the walk must terminate, not loop forever.
        save_task_meta(&base, "/p", "a", &TaskMeta { prev_uuid: Some("b".into()), summary_path: None }).unwrap();
        save_task_meta(&base, "/p", "b", &TaskMeta { prev_uuid: Some("a".into()), summary_path: None }).unwrap();
        let chain = load_chain(&base, "/p", "a");
        assert_eq!(chain.len(), 2, "each node visited once under the cycle guard");
        let _ = fs::remove_dir_all(&base);
    }

    // A just-restarted head has a `.task` sidecar but no snapshot body yet; the
    // chain must still reach the previous task (which does have a snapshot).
    #[test]
    fn load_chain_follows_link_without_head_snapshot() {
        let base = temp_base("nohead");
        save(&base, "/p", &snap("old", "n", "d", 1)).unwrap();
        save_task_meta(&base, "/p", "new", &TaskMeta { prev_uuid: Some("old".into()), summary_path: None }).unwrap();
        // "new" has only a sidecar (no .json) — load_chain still returns [old].
        let chain = load_chain(&base, "/p", "new");
        assert_eq!(chain.iter().map(|s| s.uuid.as_str()).collect::<Vec<_>>(), vec!["old"]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn load_chain_stops_at_missing_link() {
        let base = temp_base("missing");
        save(&base, "/p", &snap("u2", "n", "d", 1)).unwrap();
        // u2.prev = u1 but u1 was never saved — the chain is just [u2].
        save_task_meta(&base, "/p", "u2", &TaskMeta { prev_uuid: Some("u1".into()), summary_path: None }).unwrap();
        let chain = load_chain(&base, "/p", "u2");
        assert_eq!(chain.iter().map(|s| s.uuid.as_str()).collect::<Vec<_>>(), vec!["u2"]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn render_for_summary_includes_turns_answers_and_changed_files() {
        use crate::timeline::{AgentStatus, FileDiff, ItemKind, WriteStatus};
        let mut s = snap("u1", "내 작업", "2026-06-20", 0);
        // Two turns with answers.
        s.turns = vec![(1, "첫 질문".into()), (2, "둘째 질문".into())];
        s.answers = vec![(1, "첫 답변".into()), (2, "둘째 답변".into())];
        // An edit item on turn 2 that changed a file.
        s.items = vec![TimelineItem {
            session_id: "u1".into(),
            tool_call_id: "c1".into(),
            turn: 2,
            seq: 0,
            kind: ItemKind::Edit,
            title: "edit".into(),
            locations: vec![],
            project_label: None,
            diffs: vec![FileDiff {
                path: PathBuf::from("src/main.rs"),
                old_text: Some("a".into()),
                new_text: "b".into(),
            }],
            content_text: None,
            raw_input: None,
            agent_status: AgentStatus::Completed,
            write_status: WriteStatus::None,
            revision: 1,
        }];
        let text = render_for_summary(&s);
        assert!(text.contains("내 작업"), "title present");
        assert!(text.contains("첫 질문") && text.contains("첫 답변"));
        assert!(text.contains("둘째 질문") && text.contains("둘째 답변"));
        assert!(text.contains("src/main.rs"), "changed file listed");
    }

    #[test]
    fn render_for_summary_truncates_long_text_safely() {
        let mut s = snap("u1", "n", "d", 0);
        // A long multi-byte (한글) prompt must truncate without panicking.
        let long = "가".repeat(5000);
        s.turns = vec![(1, long)];
        s.answers = vec![];
        let text = render_for_summary(&s);
        assert!(text.contains('…'), "truncated with ellipsis");
        // The whole 5000-char prompt is not emitted verbatim.
        assert!(text.chars().filter(|c| *c == '가').count() < 5000);
    }

    #[test]
    fn save_summary_roundtrips_and_delete_removes_it() {
        let base = temp_base("summary");
        save(&base, "/p", &snap("u1", "n", "d", 1)).unwrap();
        let p = save_summary(&base, "/p", "u1", "요약 내용").unwrap();
        assert!(p.ends_with("u1.summary.md"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "요약 내용");
        assert_eq!(summary_path(&base, "/p", "u1").unwrap(), p);
        delete(&base, "/p", "u1").unwrap();
        assert!(!p.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_task_sidecar() {
        let base = temp_base("deltask");
        save(&base, "/p", &snap("u1", "n", "d", 1)).unwrap();
        save_task_meta(&base, "/p", "u1", &TaskMeta { prev_uuid: Some("p".into()), summary_path: None }).unwrap();
        delete(&base, "/p", "u1").unwrap();
        assert!(read_task_meta(&base, "/p", "u1").is_none());
        let _ = fs::remove_dir_all(&base);
    }
}
