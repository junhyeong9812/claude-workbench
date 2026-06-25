//! Git operations for the in-app Git panel (G1) — thin wrappers over the system
//! `git` CLI run in a project's working directory, returning structured data.
//!
//! All user-supplied values (branch names, commit messages, paths) are passed as
//! separate `Command::args` entries — never interpolated into a shell — so there
//! is no shell-injection surface.

use std::collections::BTreeSet;
use std::path::Path;
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

/// Abort an in-progress merge.
pub fn merge_abort(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["merge", "--abort"])
}

/// Conclude a merge after conflicts are resolved + staged (commit the merge with
/// its prepared message; no editor).
pub fn merge_continue(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["commit", "--no-edit"])
}

/// Resolve a conflict by taking our side (current branch) + stage it.
pub fn resolve_ours(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["checkout", "--ours", "--", path])?;
    run_git(cwd, &["add", "--", path])
}

/// Resolve a conflict by taking their side (merged-in branch) + stage it.
pub fn resolve_theirs(cwd: &str, path: &str) -> Result<String, String> {
    run_git(cwd, &["checkout", "--theirs", "--", path])?;
    run_git(cwd, &["add", "--", path])
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

/// Recent commits across all refs for the history graph. `order`: "topo"
/// (topological — keeps branches contiguous), "author" (author-date), else
/// "date" (commit-date, default).
pub fn log(cwd: &str, limit: u32, order: &str, gitref: Option<&str>) -> Result<Vec<Commit>, String> {
    let order_flag = match order {
        "topo" => "--topo-order",
        "author" => "--author-date-order",
        _ => "--date-order",
    };
    let fmt = "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s%x1e";
    let limit_arg = format!("-{limit}");
    // A specific branch (e.g. "main") scopes the log to that ref; otherwise `--all`
    // shows every branch. Reject a ref that would parse as a git option (leading `-`).
    let ref_arg = match gitref {
        Some(r) if !r.is_empty() && !r.starts_with('-') => r,
        _ => "--all",
    };
    let out = run_git(
        cwd,
        &[
            "log",
            &limit_arg,
            ref_arg,
            order_flag,
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

/// Rename a local branch (`git branch -m <old> <new>`).
pub fn rename_branch(cwd: &str, old: &str, new: &str) -> Result<String, String> {
    safe_ref(old)?;
    safe_ref(new)?;
    run_git(cwd, &["branch", "-m", old, new])
}

/// Resolve a ref to exactly one commit (`rev-parse --verify <r>^{commit}`), erroring
/// for ranges/revspecs or non-commit objects — hardens commit-taking commands beyond
/// `safe_ref` (codex). Returns the resolved 40-char hash.
fn resolve_commit(cwd: &str, r: &str) -> Result<String, String> {
    safe_ref(r)?;
    run_git(cwd, &["rev-parse", "--verify", &format!("{r}^{{commit}}")])
        .map_err(|_| "유효한 커밋이 아닙니다".to_string())
}

/// Reword the latest commit (`git commit --amend -m <message>`). Guards (codex):
/// `hash` must BE HEAD (never reword a non-HEAD row by mistake), the index must be
/// clean (so staged changes aren't silently folded in), and HEAD must be a
/// single-line message (a one-line prompt would drop a body/trailers — use a
/// terminal for those). Rewrites HEAD's hash, so the UI confirms first.
pub fn amend_message(cwd: &str, hash: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("커밋 메시지가 비어 있습니다".to_string());
    }
    if resolve_commit(cwd, "HEAD")? != resolve_commit(cwd, hash)? {
        return Err("HEAD 커밋만 메시지를 수정할 수 있습니다".to_string());
    }
    if run_git(cwd, &["diff", "--cached", "--quiet"]).is_err() {
        return Err("스테이지된 변경이 있습니다 — 먼저 커밋/언스테이지 후 수정하세요".to_string());
    }
    let body = run_git(cwd, &["log", "-1", "--format=%B", "HEAD"]).unwrap_or_default();
    if body.trim().lines().count() > 1 {
        return Err("본문이 있는 커밋입니다 — 본문 유실 방지를 위해 터미널에서 수정하세요".to_string());
    }
    run_git(cwd, &["commit", "--amend", "-m", message])
}

/// Revert a commit (`git revert --no-edit <hash>`) — a NEW commit undoing it
/// (non-destructive). `hash` must resolve to a single commit. On conflict it leaves
/// REVERT_HEAD (status.reverting) for [`revert_abort`] / [`revert_continue`].
pub fn revert(cwd: &str, hash: &str) -> Result<String, String> {
    resolve_commit(cwd, hash)?;
    run_git(cwd, &["revert", "--no-edit", hash])
}

/// Abort an in-progress revert (`git revert --abort`).
pub fn revert_abort(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["revert", "--abort"])
}

/// Conclude a revert after conflicts are resolved + staged — committing while
/// REVERT_HEAD exists clears it (no editor; mirrors merge_continue).
pub fn revert_continue(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["commit", "--no-edit"])
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
    /// The repo's main working tree (vs a linked worktree). `git worktree list`
    /// emits the main tree first for a non-bare repo, so the first parsed entry is
    /// the main one (a bare repo would list its bare source first — not a case this
    /// app opens).
    pub is_main: bool,
}

/// The work-tree root containing `cwd` (`git rev-parse --show-toplevel`) — i.e. the
/// worktree a session running in `cwd` belongs to. `None` if `cwd` isn't in a repo.
/// Lets the worktree panel match a session to its worktree even when the session's
/// cwd is a subdirectory (canonicalized by git, so symlinks/`..` don't false-miss).
pub fn worktree_root(cwd: &str) -> Option<String> {
    run_git(cwd, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|s| !s.is_empty())
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
                is_main: res.is_empty(), // first entry = main working tree
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

/// One file changed by a commit, for the history viewer's file list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommitFile {
    pub path: String,
    /// `git show --name-status` status: M/A/D/R…/C… (rename/copy keep just the
    /// first letter; the new path is used).
    pub status: String,
}

/// Parse `git show --name-status -z --format=` output. With `-z`, every field is
/// NUL-terminated (no tabs/newlines), so paths with odd characters parse correctly:
/// a normal entry is `STATUS\0path\0`; a rename/copy is `R<score>\0old\0new\0`
/// (use the new path).
fn parse_name_status(out: &str) -> Vec<CommitFile> {
    let mut res = Vec::new();
    let mut it = out.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = it.next() {
        let status = code.chars().next().map(|c| c.to_string()).unwrap_or_default();
        // Rename/copy carry two path fields (old, new); other statuses carry one.
        let path = if code.starts_with('R') || code.starts_with('C') {
            it.next(); // old path — skip
            it.next()
        } else {
            it.next()
        };
        if let Some(p) = path {
            if !p.is_empty() {
                res.push(CommitFile {
                    path: p.to_string(),
                    status,
                });
            }
        }
    }
    res
}

/// Files a commit changed (path + status), for the history viewer's file list.
/// `--format=` drops the commit-message header so only the file list remains; `-z`
/// makes the field separators NUL so unusual filenames aren't misparsed.
pub fn commit_files(cwd: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    if hash.starts_with('-') || hash.is_empty() {
        return Err("잘못된 커밋 해시입니다".to_string());
    }
    let out = run_git(cwd, &["show", "--name-status", "-z", "--format=", "--no-color", hash])?;
    Ok(parse_name_status(&out))
}

/// Unified diff for one file in one commit (`git show <hash> -- <path>`) — the
/// history viewer's per-file diff (DETAIL mode). `--` so a path can't be parsed as
/// an option.
pub fn commit_file_diff(cwd: &str, hash: &str, path: &str) -> Result<String, String> {
    if hash.starts_with('-') || hash.is_empty() {
        return Err("잘못된 커밋 해시입니다".to_string());
    }
    run_git(cwd, &["show", "--format=", "--no-color", hash, "--", path])
}

/// A file's full content AT a commit (`git show <hash>:<path>`) — the history
/// viewer's "원본 보기" toggle (the file as it was in that commit, for md→html /
/// raw rendering). Errors if the path didn't exist at that commit (e.g. a delete).
pub fn commit_file_content(cwd: &str, hash: &str, path: &str) -> Result<String, String> {
    if hash.starts_with('-') || hash.is_empty() {
        return Err("잘못된 커밋 해시입니다".to_string());
    }
    // `<hash>:<path>` is a rev:path spec, not an option, but guard the path anyway.
    let spec = format!("{hash}:{path}");
    run_git(cwd, &["show", "--no-color", &spec])
}

// ---- T1: tags ----

/// Tags, newest first.
pub fn tags(cwd: &str) -> Result<Vec<String>, String> {
    Ok(run_git(cwd, &["tag", "--sort=-creatordate"])?
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Create a tag at HEAD — lightweight, or annotated when `message` is given.
pub fn create_tag(cwd: &str, name: &str, message: &str) -> Result<String, String> {
    safe_ref(name)?;
    if message.is_empty() {
        run_git(cwd, &["tag", name])
    } else {
        run_git(cwd, &["tag", "-a", name, "-m", message])
    }
}

/// Delete a tag.
pub fn delete_tag(cwd: &str, name: &str) -> Result<String, String> {
    safe_ref(name)?;
    run_git(cwd, &["tag", "-d", name])
}

// ---- multi-root discovery (nested .git detection) ----

const MAX_SCAN_DEPTH: usize = 8;
const MAX_ROOTS: usize = 200;
/// Hard cap on directories visited, so a wide shallow tree with few repos (where
/// the depth/root caps don't bite) still terminates promptly (codex P2).
const MAX_VISITED_DIRS: usize = 20_000;
/// Directory names that are pruned during the nested-repo scan — VCS internals and
/// heavy build/dependency trees that never hold a *separate* project repo we'd want
/// as a root (and that would make a recursive walk slow).
const PRUNE_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "out", ".next",
    "vendor", ".cache", "coverage", "__pycache__", ".venv", "venv", ".tox", ".gradle",
];

/// Discover the git roots reachable from `cwd`: the enclosing work-tree root (at or
/// above `cwd`, if any) plus every nested repository found by scanning the subtree
/// under `cwd`. A directory is a root if it directly contains a `.git` (a dir for a
/// normal repo, or a gitlink file for a worktree/submodule). The scan prunes
/// VCS/build dirs, **never follows symlinks** (so it can't escape the tree or loop),
/// stops descending once a repo is found (its internals aren't more roots), and is
/// bounded by depth + root-count + visited-dir caps so a pathological tree can't
/// hang the UI. Returned lexicographically sorted (BTreeSet) — a repo sorts before
/// its own nested repos, though two unrelated subtrees order by path string.
/// A discovered git root: its absolute path + the branch it's currently on (the
/// short symbolic ref, or "(detached)" for a detached HEAD, "" if unreadable). The
/// branch lets the UI label each root without a separate status round-trip.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GitRoot {
    pub path: String,
    pub branch: String,
}

pub fn git_roots(cwd: &str) -> Vec<GitRoot> {
    let mut roots: BTreeSet<String> = BTreeSet::new();
    // Enclosing repo (work-tree root at or above cwd), if cwd is inside one.
    if let Ok(top) = run_git(cwd, &["rev-parse", "--show-toplevel"]) {
        if !top.is_empty() {
            roots.insert(top);
        }
    }
    // Nested repos strictly under cwd.
    let mut count = 0usize;
    let mut visited = 0usize;
    scan_git_roots(Path::new(cwd), 0, &mut roots, &mut count, &mut visited);
    // Resolve each root's current branch (cheap per-root rev-parse). Detached HEAD
    // returns the literal "HEAD" → label it as detached.
    roots
        .into_iter()
        .map(|path| {
            let branch = match run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]) {
                Ok(b) if b == "HEAD" => "(detached)".to_string(),
                Ok(b) => b,
                Err(_) => String::new(),
            };
            GitRoot { path, branch }
        })
        .collect()
}

fn scan_git_roots(
    dir: &Path,
    depth: usize,
    roots: &mut BTreeSet<String>,
    count: &mut usize,
    visited: &mut usize,
) {
    if depth > MAX_SCAN_DEPTH || *count >= MAX_ROOTS || *visited >= MAX_VISITED_DIRS {
        return;
    }
    *visited += 1;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir (permissions) — skip, not fatal
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Never follow symlinks (could escape the project tree or cycle); only walk
        // real directories.
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if PRUNE_DIRS.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        // A directory holding a `.git` entry is a repo root — record it and do NOT
        // descend (a repository's own contents aren't additional roots).
        if path.join(".git").exists() {
            roots.insert(path.to_string_lossy().to_string());
            *count += 1;
            if *count >= MAX_ROOTS {
                return;
            }
            continue;
        }
        scan_git_roots(&path, depth + 1, roots, count, visited);
        if *count >= MAX_ROOTS || *visited >= MAX_VISITED_DIRS {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_git_{tag}_{nanos}_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn scan_finds_nested_repos_prunes_heavy_and_stops_at_boundary() {
        let root = temp_dir("roots");
        // Two nested repos at different depths + a heavy dir + a repo-inside-a-repo
        // (which must NOT be reported — scan stops at the outer repo boundary).
        std::fs::create_dir_all(root.join("a/.git")).unwrap();
        std::fs::create_dir_all(root.join("nested/b/.git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg/.git")).unwrap(); // pruned
        std::fs::create_dir_all(root.join("a/inner/.git")).unwrap(); // inside repo a → skipped
        std::fs::create_dir_all(root.join("plain/sub")).unwrap(); // no repo

        let mut set: BTreeSet<String> = BTreeSet::new();
        let mut count = 0;
        let mut visited = 0;
        scan_git_roots(&root, 0, &mut set, &mut count, &mut visited);

        let a = root.join("a").to_string_lossy().to_string();
        let b = root.join("nested/b").to_string_lossy().to_string();
        assert!(set.contains(&a), "direct-child repo found");
        assert!(set.contains(&b), "depth-2 repo found");
        assert!(
            !set.contains(&root.join("node_modules/pkg").to_string_lossy().to_string()),
            "node_modules pruned"
        );
        assert!(
            !set.contains(&root.join("a/inner").to_string_lossy().to_string()),
            "repo inside a repo not descended into"
        );
        assert_eq!(set.len(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn gitlink_file_counts_as_repo_root() {
        // A worktree/submodule has `.git` as a FILE (gitlink), not a dir.
        let root = temp_dir("gitlink");
        std::fs::create_dir_all(root.join("wt")).unwrap();
        std::fs::write(root.join("wt/.git"), "gitdir: /somewhere\n").unwrap();
        let mut set: BTreeSet<String> = BTreeSet::new();
        let mut count = 0;
        let mut visited = 0;
        scan_git_roots(&root, 0, &mut set, &mut count, &mut visited);
        assert!(set.contains(&root.join("wt").to_string_lossy().to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

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
        assert!(wts[0].is_main); // first entry = main working tree
        assert_eq!(wts[1].path, "/repo/wt");
        assert_eq!(wts[1].branch, "(detached)");
        assert!(!wts[1].is_main); // linked worktree
    }

    #[test]
    fn parse_name_status_z() {
        // -z output: normal `STATUS\0path\0`, rename `R<score>\0old\0new\0`.
        let out = "M\0src/a.rs\0A\0b\tc.rs\0R100\0old.rs\0new.rs\0D\0gone.rs\0";
        let fs = parse_name_status(out);
        assert_eq!(fs.len(), 4);
        assert_eq!((fs[0].status.as_str(), fs[0].path.as_str()), ("M", "src/a.rs"));
        assert_eq!((fs[1].status.as_str(), fs[1].path.as_str()), ("A", "b\tc.rs")); // tab in name
        assert_eq!((fs[2].status.as_str(), fs[2].path.as_str()), ("R", "new.rs")); // rename → new
        assert_eq!((fs[3].status.as_str(), fs[3].path.as_str()), ("D", "gone.rs"));
    }

    #[test]
    fn safe_ref_rejects_leading_dash() {
        assert!(safe_ref("-rf").is_err());
        assert!(safe_ref("").is_err());
        assert!(safe_ref("feature/ok").is_ok());
    }
}
