use serde::Serialize;

use super::run_git;

/// One changed file from `git status --porcelain`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileChange {
    pub path: String,
    /// The two-char porcelain code (e.g. "M", "??", "A "), trimmed.
    pub code: String,
    /// Whether the change is staged (index column is set and not untracked).
    pub staged: bool,
    /// Whether the file is in a merge conflict (unmerged porcelain code).
    pub conflicted: bool,
}

/// Working-tree status for the Git panel.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
    /// A merge is in progress (MERGE_HEAD exists) — conflicts may need resolving.
    pub merging: bool,
    /// A revert is in progress (REVERT_HEAD exists) — conflicts to resolve, then
    /// `revert --continue`, or `revert --abort` to back out.
    pub reverting: bool,
    pub changes: Vec<FileChange>,
}

impl GitStatus {
    fn not_repo() -> Self {
        GitStatus {
            is_repo: false,
            branch: String::new(),
            upstream: None,
            ahead: 0,
            behind: 0,
            has_remote: false,
            merging: false,
            reverting: false,
            changes: Vec::new(),
        }
    }
}

/// Parse `git status --porcelain=v1 -z -b` output (NUL-separated, so paths with
/// spaces/quotes/newlines round-trip and renames are explicit — codex G1-2).
/// Returns branch/upstream/ahead/behind/changes (caller fills is_repo/has_remote).
/// Pure — unit-tested.
fn parse_status(out: &str) -> (String, Option<String>, u32, u32, Vec<FileChange>) {
    let mut branch = String::new();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut changes = Vec::new();
    let mut recs = out.split('\0');
    while let Some(rec) = recs.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(rest) = rec.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" / "main" / "No commits yet on main"
            let (head, track) = match rest.find(" [") {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            };
            if let Some(stripped) = head.strip_prefix("No commits yet on ") {
                branch = stripped.to_string();
            } else if let Some((local, up)) = head.split_once("...") {
                branch = local.to_string();
                upstream = Some(up.to_string());
            } else {
                branch = head.to_string();
            }
            if let Some(t) = track.trim().strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
                for part in t.split(", ") {
                    if let Some(n) = part.strip_prefix("ahead ") {
                        ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix("behind ") {
                        behind = n.parse().unwrap_or(0);
                    }
                }
            }
        } else if rec.len() >= 4 {
            let code = &rec[..2];
            let path = rec[3..].to_string();
            let b = code.as_bytes();
            let x = b[0] as char;
            let y = b[1] as char;
            // Unmerged (conflict): a 'U' on either side, or both-added/both-deleted.
            let conflicted = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
            let staged = x != ' ' && x != '?';
            // Rename/copy entries carry a second NUL field (the source path) — the
            // shown `path` is the new path; consume the source so it isn't parsed
            // as its own change.
            if x == 'R' || x == 'C' {
                let _ = recs.next();
            }
            changes.push(FileChange {
                path,
                code: code.trim().to_string(),
                staged,
                conflicted,
            });
        }
    }
    (branch, upstream, ahead, behind, changes)
}

/// Full status for `cwd` (never fails — a non-repo yields `is_repo: false`).
pub fn status(cwd: &str) -> GitStatus {
    let inside = run_git(cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false);
    if !inside {
        return GitStatus::not_repo();
    }
    let porcelain = run_git(cwd, &["status", "--porcelain=v1", "-z", "-b"]).unwrap_or_default();
    let (branch, upstream, ahead, behind, changes) = parse_status(&porcelain);
    let has_remote = !run_git(cwd, &["remote"]).unwrap_or_default().is_empty();
    let merging = run_git(cwd, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok();
    let reverting = run_git(cwd, &["rev-parse", "-q", "--verify", "REVERT_HEAD"]).is_ok();
    GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        has_remote,
        merging,
        reverting,
        changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_branch_with_upstream_and_tracking() {
        let (b, up, ahead, behind, _) = parse_status("## main...origin/main [ahead 2, behind 1]\0");
        assert_eq!(b, "main");
        assert_eq!(up.as_deref(), Some("origin/main"));
        assert_eq!(ahead, 2);
        assert_eq!(behind, 1);
    }

    #[test]
    fn parse_branch_no_upstream_and_no_commits_yet() {
        let (b, up, ..) = parse_status("## feature/x\0");
        assert_eq!(b, "feature/x");
        assert_eq!(up, None);
        // "No commits yet on <b>" → branch is the bare name.
        let (b2, ..) = parse_status("## No commits yet on main\0");
        assert_eq!(b2, "main");
    }

    #[test]
    fn parse_changes_staged_unstaged_untracked() {
        let p = "## main\0M  src/a.rs\0 M src/b.rs\0?? new.txt\0A  added.rs\0";
        let (_, _, _, _, changes) = parse_status(p);
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].path, "src/a.rs");
        assert!(changes[0].staged); // "M " staged modify
        assert_eq!(changes[1].path, "src/b.rs");
        assert!(!changes[1].staged); // " M" unstaged modify
        assert_eq!(changes[2].path, "new.txt");
        assert!(!changes[2].staged); // "??" untracked
        assert!(changes[3].staged); // "A " staged add
    }

    #[test]
    fn parse_rename_consumes_source_and_keeps_new_path() {
        // -z rename: "R  new.rs\0old.rs\0" — show the new path, swallow the source.
        let (_, _, _, _, changes) = parse_status("## main\0R  src/new.rs\0src/old.rs\0M  other.rs\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "src/new.rs");
        assert!(changes[0].staged);
        assert_eq!(changes[1].path, "other.rs"); // source not parsed as its own entry
    }

    #[test]
    fn parse_conflict_unmerged() {
        let (_, _, _, _, changes) = parse_status("## main\0UU src/a.rs\0AA b.rs\0 M c.rs\0");
        assert!(changes[0].conflicted); // UU
        assert!(changes[1].conflicted); // AA (both added)
        assert!(!changes[2].conflicted); // " M" normal modify
    }

    #[test]
    fn parse_path_with_spaces() {
        let (_, _, _, _, changes) = parse_status("## main\0 M src/a b.rs\0");
        assert_eq!(changes[0].path, "src/a b.rs");
    }

    #[test]
    fn parse_ahead_only() {
        let (_, _, ahead, behind, _) = parse_status("## main...origin/main [ahead 3]\0");
        assert_eq!((ahead, behind), (3, 0));
    }
}
