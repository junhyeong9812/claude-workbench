//! Git operations for the in-app Git panel (G1) — thin wrappers over the system
//! `git` CLI run in a project's working directory, returning structured data.
//!
//! All user-supplied values (branch names, commit messages, paths) are passed as
//! separate `Command::args` entries — never interpolated into a shell — so there
//! is no shell-injection surface.

use std::process::Command;

use serde::Serialize;

/// Run `git <args>` in `cwd`. `Ok(stdout)` on success (trailing newline trimmed),
/// `Err(stderr)` on a non-zero exit or spawn failure.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    // `--literal-pathspecs` so a file literally named like a pathspec-magic form
    // (`:(glob)…`) can't make path-taking commands match more than the literal
    // path (codex G1-1). Harmless for non-path commands.
    let out = Command::new("git")
        .arg("--literal-pathspecs")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "git 명령이 실패했습니다".to_string()
        } else {
            err
        })
    }
}

/// One changed file from `git status --porcelain`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileChange {
    pub path: String,
    /// The two-char porcelain code (e.g. "M", "??", "A "), trimmed.
    pub code: String,
    /// Whether the change is staged (index column is set and not untracked).
    pub staged: bool,
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
            let index = code.chars().next().unwrap_or(' ');
            let staged = index != ' ' && index != '?';
            // Rename/copy entries carry a second NUL field (the source path) — the
            // shown `path` is the new path; consume the source so it isn't parsed
            // as its own change.
            if index == 'R' || index == 'C' {
                let _ = recs.next();
            }
            changes.push(FileChange {
                path,
                code: code.trim().to_string(),
                staged,
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
    GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        has_remote,
        changes,
    }
}

/// Local + remote branches, with the current local branch.
#[derive(Debug, Clone, Serialize)]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
    /// Remote-tracking branches (e.g. `origin/main`), excluding `origin/HEAD`.
    pub remote: Vec<String>,
}

pub fn branches(cwd: &str) -> Result<Branches, String> {
    let current = run_git(cwd, &["branch", "--show-current"])?;
    let local = run_git(cwd, &["branch", "--format=%(refname:short)"])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let remote = run_git(cwd, &["branch", "-r", "--format=%(refname:short)"])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
        .collect();
    Ok(Branches { current, local, remote })
}

/// One commit for the history graph.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Commit {
    pub hash: String,
    pub short: String,
    /// Parent full hashes (>1 = merge).
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    /// Ref decoration (`HEAD -> main, origin/main, tag: v1`), as git prints it.
    pub refs: String,
    pub subject: String,
}

/// Parse `git log` records (one per `\x1e`, fields per `\x1f`). Pure — tested.
fn parse_log(out: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    for rec in out.split('\u{1e}') {
        let rec = rec.trim_matches('\n');
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.split('\u{1f}').collect();
        if f.len() < 7 {
            continue;
        }
        commits.push(Commit {
            hash: f[0].to_string(),
            short: f[1].to_string(),
            parents: f[2].split_whitespace().map(|s| s.to_string()).collect(),
            author: f[3].to_string(),
            date: f[4].to_string(),
            refs: f[5].to_string(),
            subject: f[6].to_string(),
        });
    }
    commits
}

/// Recent commits across all refs (newest first), for the history graph.
pub fn log(cwd: &str, limit: u32) -> Result<Vec<Commit>, String> {
    let fmt = "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e";
    let out = run_git(
        cwd,
        &[
            "log",
            &format!("-{limit}"),
            "--all",
            "--date=format:%Y-%m-%d %H:%M",
            fmt,
        ],
    )?;
    Ok(parse_log(&out))
}

/// Reject refs that would be parsed as a git option (leading `-`) — valid branch
/// names never start with `-`, so this is safe and blocks option injection (G1-3).
fn safe_ref(name: &str) -> Result<(), String> {
    if name.starts_with('-') || name.is_empty() {
        Err("잘못된 브랜치 이름입니다".to_string())
    } else {
        Ok(())
    }
}

pub fn checkout(cwd: &str, branch: &str) -> Result<String, String> {
    safe_ref(branch)?;
    run_git(cwd, &["checkout", branch])
}

pub fn create_branch(cwd: &str, name: &str) -> Result<String, String> {
    safe_ref(name)?;
    run_git(cwd, &["checkout", "-b", name])
}

pub fn stage(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["add", "--", path])
}

pub fn stage_all(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["add", "-A"])
}

pub fn unstage(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["reset", "-q", "--", path])
}

pub fn commit(cwd: &str, message: &str) -> Result<String, String> {
    run_git(cwd, &["commit", "-m", message])
}

/// Push the current branch. If it has no upstream yet, set it on `origin`.
pub fn push(cwd: &str) -> Result<String, String> {
    let has_upstream = run_git(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .is_ok();
    if has_upstream {
        run_git(cwd, &["push"])
    } else {
        let branch = run_git(cwd, &["branch", "--show-current"])?;
        if branch.is_empty() {
            return Err("현재 브랜치를 확인할 수 없습니다".to_string());
        }
        run_git(cwd, &["push", "-u", "origin", &branch])
    }
}

// ---- GP3: more actions ----

/// Merge `branch` into the current branch.
pub fn merge(cwd: &str, branch: &str) -> Result<String, String> {
    safe_ref(branch)?;
    run_git(cwd, &["merge", branch])
}

/// Fetch all remotes (pruning deleted remote branches).
pub fn fetch(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["fetch", "--all", "--prune"])
}

/// Pull the current branch.
pub fn pull(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["pull"])
}

/// Discard unstaged changes to a tracked file (`git restore`).
pub fn discard(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["restore", "--", path])
}

/// Delete a local branch (`-d`; `-D` to force-delete unmerged).
pub fn delete_branch(cwd: &str, name: &str, force: bool) -> Result<String, String> {
    safe_ref(name)?;
    run_git(cwd, &["branch", if force { "-D" } else { "-d" }, name])
}

/// Stash entries (`stash list`), one per line.
pub fn stash_list(cwd: &str) -> Result<Vec<String>, String> {
    Ok(run_git(cwd, &["stash", "list"])?
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Stash the working tree (optionally with a message).
pub fn stash_save(cwd: &str, message: &str) -> Result<String, String> {
    if message.is_empty() {
        run_git(cwd, &["stash", "push"])
    } else {
        run_git(cwd, &["stash", "push", "-m", message])
    }
}

/// Pop the most recent stash.
pub fn stash_pop(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["stash", "pop"])
}

// ---- GP4: worktrees ----

/// One git worktree.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Worktree {
    pub path: String,
    pub head: String,
    pub branch: String,
}

/// Parse `git worktree list --porcelain`. Pure — tested.
fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut res = Vec::new();
    let mut path = String::new();
    let mut head = String::new();
    let mut branch = String::new();
    let flush = |res: &mut Vec<Worktree>, path: &str, head: &str, branch: &str| {
        if !path.is_empty() {
            res.push(Worktree {
                path: path.to_string(),
                head: head.to_string(),
                branch: branch.to_string(),
            });
        }
    };
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut res, &path, &head, &branch);
            path = p.to_string();
            head = String::new();
            branch = "(detached)".to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line == "detached" {
            branch = "(detached)".to_string();
        }
    }
    flush(&mut res, &path, &head, &branch);
    res
}

pub fn worktrees(cwd: &str) -> Result<Vec<Worktree>, String> {
    Ok(parse_worktrees(&run_git(cwd, &["worktree", "list", "--porcelain"])?))
}

/// Add a worktree at `path` checking out `branch` (must exist). `--` so a `path`
/// starting with `-` can't be parsed as a git option (codex GP-2).
pub fn worktree_add(cwd: &str, path: &str, branch: &str) -> Result<String, String> {
    safe_ref(branch)?;
    run_git(cwd, &["worktree", "add", "--", path, branch])
}

/// Remove the worktree at `path`.
pub fn worktree_remove(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["worktree", "remove", "--", path])
}

// ---- diff viewer ----

/// Unified diff for one path — staged (`--cached`) or working-tree.
pub fn diff(cwd: &str, path: &str, staged: bool) -> Result<String, String> {
    if staged {
        run_git(cwd, &["diff", "--cached", "--", path])
    } else {
        run_git(cwd, &["diff", "--", path])
    }
}

/// A commit's full diff (`git show`). `hash` comes from our log; guard a leading
/// `-` defensively so it can't be parsed as an option.
pub fn show(cwd: &str, hash: &str) -> Result<String, String> {
    if hash.starts_with('-') || hash.is_empty() {
        return Err("잘못된 커밋 해시입니다".to_string());
    }
    run_git(cwd, &["show", hash])
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
    fn parse_path_with_spaces() {
        let (_, _, _, _, changes) = parse_status("## main\0 M src/a b.rs\0");
        assert_eq!(changes[0].path, "src/a b.rs");
    }

    #[test]
    fn parse_ahead_only() {
        let (_, _, ahead, behind, _) = parse_status("## main...origin/main [ahead 3]\0");
        assert_eq!((ahead, behind), (3, 0));
    }

    #[test]
    fn parse_log_records() {
        let out = "h1\u{1f}abc\u{1f}p1 p2\u{1f}Jun\u{1f}2026-06-20\u{1f}HEAD -> main\u{1f}merge\u{1e}h2\u{1f}def\u{1f}p3\u{1f}Jun\u{1f}2026-06-19\u{1f}\u{1f}init\u{1e}";
        let commits = parse_log(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].short, "abc");
        assert_eq!(commits[0].parents, vec!["p1", "p2"]); // merge
        assert_eq!(commits[0].refs, "HEAD -> main");
        assert_eq!(commits[1].subject, "init");
    }

    #[test]
    fn parse_worktrees_main_and_detached() {
        let out = "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD bbb\ndetached\n";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/repo");
        assert_eq!(wts[0].branch, "main");
        assert_eq!(wts[1].path, "/repo/wt");
        assert_eq!(wts[1].branch, "(detached)");
    }

    #[test]
    fn safe_ref_rejects_leading_dash() {
        assert!(safe_ref("-rf").is_err());
        assert!(safe_ref("").is_err());
        assert!(safe_ref("feature/ok").is_ok());
    }
}
