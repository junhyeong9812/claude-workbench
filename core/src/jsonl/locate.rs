//! Locate a session's JSONL transcript by its UUID (P2b-4 Phase B-2a).
//!
//! The `claude` CLI writes each session to
//! `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`, where `<cwd-slug>` is
//! the working directory with `/` and `.` rewritten to `-`. Reproducing that
//! slug rule exactly is fragile (the handling of other characters — `_`, spaces,
//! … — is unverified), so instead of **predicting** the path we **find** it:
//! since we pass our own globally-unique `--session-id <uuid>`, the file is the
//! unique `<uuid>.jsonl` under some single-level subdirectory of the projects
//! root. A one-level scan locates it regardless of how the slug was derived.
//!
//! The file appears only after the CLI's first turn / init, so callers poll
//! [`find_session_jsonl`] until it returns `Some`, then tail that fixed path
//! (see [`crate::jsonl::SessionTail`]).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The default Claude Code projects root: `$HOME/.claude/projects`. `None` if
/// `$HOME` is unset.
pub fn claude_projects_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join(".claude").join("projects")
    })
}

/// Find the transcript file for `session_id` by scanning the immediate
/// subdirectories of `projects_root` for `<session_id>.jsonl`.
///
/// Returns `Ok(None)` when the file doesn't exist yet (the session hasn't been
/// flushed, or `projects_root` itself is absent) — callers retry. Propagates
/// other IO errors. The first match wins; UUIDs are unique, so there is at most
/// one.
pub fn find_session_jsonl(projects_root: &Path, session_id: &str) -> io::Result<Option<PathBuf>> {
    let target = format!("{session_id}.jsonl");
    let entries = match fs::read_dir(projects_root) {
        Ok(entries) => entries,
        // The projects root may not exist until the CLI runs the first time.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let path = entry?.path();
        // Only project subdirectories hold transcripts; skip stray files.
        if !path.is_dir() {
            continue;
        }
        let candidate = path.join(&target);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-jsonl-locate-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_transcript_in_a_project_subdir() {
        let root = temp_root("found");
        let proj = root.join("-home-jun-project-x");
        fs::create_dir_all(&proj).unwrap();
        let uuid = "abc-123";
        let file = proj.join(format!("{uuid}.jsonl"));
        fs::write(&file, b"{}\n").unwrap();
        // A decoy in another project dir with a different uuid.
        let other = root.join("-home-jun-other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("zzz.jsonl"), b"{}\n").unwrap();

        let found = find_session_jsonl(&root, uuid).unwrap();
        assert_eq!(found.as_deref(), Some(file.as_path()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_uuid_is_none() {
        let root = temp_root("absent");
        fs::create_dir_all(root.join("-some-proj")).unwrap();
        assert_eq!(find_session_jsonl(&root, "nope").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_projects_root_is_none_not_error() {
        let root = temp_root("missing");
        let gone = root.join("does-not-exist");
        assert_eq!(find_session_jsonl(&gone, "x").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stray_file_at_root_is_skipped() {
        let root = temp_root("stray");
        // A non-directory entry named like the target must not match.
        fs::write(root.join("abc.jsonl"), b"{}\n").unwrap();
        assert_eq!(find_session_jsonl(&root, "abc").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }
}
