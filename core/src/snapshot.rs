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
use crate::timeline::TimelineItem;

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
    if let Some(name) = read_name(base, project, uuid) {
        snap.name = name;
    }
    Some(snap)
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
        delete(&base, "/p", "../evil").unwrap(); // no-op, not an error
        let _ = fs::remove_dir_all(&base);
    }
}
