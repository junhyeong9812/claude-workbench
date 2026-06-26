use serde::Serialize;

use super::{run_git, safe_ref};

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
