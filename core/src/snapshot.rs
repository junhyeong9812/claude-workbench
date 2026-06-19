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

use serde::{Deserialize, Serialize};

use crate::history::project_key;
use crate::timeline::TimelineItem;

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

/// Write (overwrite) a session snapshot atomically (temp file + rename) so a
/// crash mid-write never leaves a half-written snapshot.
pub fn save(base: &Path, project: &str, snap: &SessionSnapshot) -> io::Result<()> {
    let dir = dir(base, project);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string(snap)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let final_path = dir.join(format!("{}.json", snap.uuid));
    let tmp_path = dir.join(format!("{}.json.tmp", snap.uuid));
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, &final_path)
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
        out.push(SnapshotSummary {
            uuid: snap.uuid,
            name: snap.name,
            title,
            date: snap.date,
            count: snap.items.len(),
        });
    }
    out.sort_by(|a, b| b.date.cmp(&a.date).then(a.name.cmp(&b.name)));
    out
}

/// Load one session's full snapshot (for reopen). `None` if absent/corrupt.
pub fn load(base: &Path, project: &str, uuid: &str) -> Option<SessionSnapshot> {
    let path = dir(base, project).join(format!("{uuid}.json"));
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Delete a session's snapshot (the `삭제` action). Missing file is not an error.
pub fn delete(base: &Path, project: &str, uuid: &str) -> io::Result<()> {
    let path = dir(base, project).join(format!("{uuid}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
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
}
