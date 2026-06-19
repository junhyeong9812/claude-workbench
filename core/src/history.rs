//! Filesystem persistence for the change timeline (P2b-2 S3b).
//!
//! The timeline is stored **outside the project** under the app data dir, keyed
//! by project, date, and session, as append-only JSONL — one record per line:
//!
//! ```text
//! <base>/projects/<project_key>/timeline/<YYYY-MM-DD>/<session>.jsonl
//! ```
//!
//! The filesystem is the source of truth (design D5/D6): each event the host
//! emits (a turn start or a timeline item) is appended as its own line, so a
//! crash loses at most the last partial line. Restart restore is a plain scan +
//! replay. This module is pure plumbing — it appends and returns **opaque JSON
//! lines** without parsing them, so the event shape stays owned by the caller.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// A stable, filesystem-safe key for a project path: its sanitized final
/// component plus a hash of the full path (so different projects that share a
/// basename never collide).
pub fn project_key(project_path: &str) -> String {
    let base = Path::new(project_path)
        .file_name()
        .map(|s| sanitize(&s.to_string_lossy()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string());
    format!("{base}-{:016x}", fnv1a(project_path.as_bytes()))
}

/// Append one opaque JSON `line` for `(project, date, session)`.
pub fn append(
    base: &Path,
    project_path: &str,
    date: &str,
    session: &str,
    line: &str,
) -> io::Result<()> {
    let dir = base
        .join("projects")
        .join(project_key(project_path))
        .join("timeline")
        .join(sanitize(date));
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.jsonl", sanitize(session)));
    let mut f = OpenOptions::new().create(true).append(true).open(file)?;
    writeln!(f, "{line}")
}

/// Load every persisted JSON line for a project across all dates/sessions, in a
/// stable order (date, then session file, then line order). Missing data yields
/// an empty vector — restore never fails.
pub fn load(base: &Path, project_path: &str) -> Vec<String> {
    let root = base
        .join("projects")
        .join(project_key(project_path))
        .join("timeline");
    let mut dates: Vec<PathBuf> = read_dir_sorted(&root);
    dates.sort();
    let mut out = Vec::new();
    for date_dir in dates {
        let mut files = read_dir_sorted(&date_dir);
        files.sort();
        for file in files {
            if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&file) {
                for line in content.lines() {
                    if !line.trim().is_empty() {
                        out.push(line.to_string());
                    }
                }
            }
        }
    }
    out
}

/// All persisted session files for a project (`<date>/<session>.jsonl`), sorted
/// by date then session.
pub fn session_files(base: &Path, project_path: &str) -> Vec<PathBuf> {
    let root = base
        .join("projects")
        .join(project_key(project_path))
        .join("timeline");
    let mut dates = read_dir_sorted(&root);
    dates.sort();
    let mut files = Vec::new();
    for date_dir in dates {
        let mut fs = read_dir_sorted(&date_dir);
        fs.sort();
        for f in fs {
            if f.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                files.push(f);
            }
        }
    }
    files
}

/// JSON lines for a single session (by its `session_id`, across dates).
pub fn load_session(base: &Path, project_path: &str, session_id: &str) -> Vec<String> {
    let target = format!("{}.jsonl", sanitize(session_id));
    let mut out = Vec::new();
    for f in session_files(base, project_path) {
        if f.file_name().and_then(|n| n.to_str()) == Some(target.as_str()) {
            if let Ok(content) = fs::read_to_string(&f) {
                out.extend(content.lines().filter(|l| !l.trim().is_empty()).map(String::from));
            }
        }
    }
    out
}

/// Delete a session's persisted history (the `삭제` action). Missing files are
/// not an error.
pub fn delete_session(base: &Path, project_path: &str, session_id: &str) -> io::Result<()> {
    let target = format!("{}.jsonl", sanitize(session_id));
    for f in session_files(base, project_path) {
        if f.file_name().and_then(|n| n.to_str()) == Some(target.as_str()) {
            match fs::remove_file(&f) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

fn read_dir_sorted(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Replace characters unsafe in a path component with `_`.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect()
}

/// FNV-1a 64-bit — a small deterministic hash (std's `DefaultHasher` is seeded
/// randomly, so it can't be used for a stable on-disk key).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mt-history-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn project_key_is_stable_and_distinguishes_paths() {
        assert_eq!(project_key("/a/b/proj"), project_key("/a/b/proj"));
        assert_ne!(project_key("/a/proj"), project_key("/b/proj"));
        assert!(project_key("/home/x/acp-test").starts_with("acp-test-"));
    }

    #[test]
    fn append_then_load_roundtrips_in_order() {
        let base = tempdir();
        let proj = "/home/x/acp-test";
        append(&base, proj, "2026-06-18", "s1", r#"{"a":1}"#).unwrap();
        append(&base, proj, "2026-06-19", "s1", r#"{"a":2}"#).unwrap();
        append(&base, proj, "2026-06-19", "s2", r#"{"a":3}"#).unwrap();

        let lines = load(&base, proj);
        // Ordered by date (18 before 19), then by session file (s1 before s2).
        assert_eq!(lines, vec![r#"{"a":1}"#, r#"{"a":2}"#, r#"{"a":3}"#]);

        // A different project is isolated.
        assert!(load(&base, "/home/x/other").is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn load_and_delete_single_session() {
        let base = tempdir();
        let proj = "/home/x/acp-test";
        append(&base, proj, "2026-06-19", "sess-A", r#"{"a":1}"#).unwrap();
        append(&base, proj, "2026-06-19", "sess-A", r#"{"a":2}"#).unwrap();
        append(&base, proj, "2026-06-19", "sess-B", r#"{"b":1}"#).unwrap();

        assert_eq!(load_session(&base, proj, "sess-A"), vec![r#"{"a":1}"#, r#"{"a":2}"#]);
        assert_eq!(session_files(&base, proj).len(), 2);

        delete_session(&base, proj, "sess-A").unwrap();
        assert!(load_session(&base, proj, "sess-A").is_empty());
        assert_eq!(load_session(&base, proj, "sess-B"), vec![r#"{"b":1}"#]);
        // Deleting a missing session is a no-op, not an error.
        delete_session(&base, proj, "nope").unwrap();
        let _ = fs::remove_dir_all(&base);
    }
}
