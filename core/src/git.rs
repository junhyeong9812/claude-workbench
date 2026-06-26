//! Git operations for the in-app Git panel (G1) — thin wrappers over the system
//! `git` CLI run in a project's working directory, returning structured data.
//!
//! All user-supplied values (branch names, commit messages, paths) are passed as
//! separate `Command::args` entries — never interpolated into a shell — so there
//! is no shell-injection surface.

use std::path::Path;
use std::process::{Command, Stdio};

mod branch;
mod history;
mod rewrite;
mod status;
mod worktree;

pub use branch::*;
pub use history::*;
pub use rewrite::*;
pub use status::*;
pub use worktree::*;

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

/// Like [`run_git`] but with extra environment variables and an optional stdin
/// payload (raw BYTES) — used by the history-rewrite plumbing (`commit-tree`) to
/// preserve each commit's author (`GIT_AUTHOR_*`) and feed the message on stdin
/// (`-F -`). Bytes (not `&str`) so a descendant message is forwarded verbatim —
/// empty, multi-line, trailing-blank, or non-UTF-8 — with no shell, no arg-length
/// limit. Only used for tiny stdout (a commit hash), so writing stdin before
/// reading stdout can't deadlock. Trims trailing newline of stdout.
fn run_git_io(
    cwd: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("--literal-pathspecs")
        .args(args)
        .current_dir(cwd)
        .envs(envs.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().map_err(|e| format!("git 실행 실패: {e}"))?;
    // Write stdin but DON'T early-return on failure: if git already exited (e.g.
    // bad args → broken pipe), its stderr is the real cause, so always reap the
    // child first and prefer git's stderr (codex review).
    let mut write_err: Option<String> = None;
    if let Some(data) = stdin {
        use std::io::Write;
        match child.stdin.take() {
            Some(mut pipe) => {
                if let Err(e) = pipe.write_all(data) {
                    write_err = Some(format!("stdin 쓰기 실패: {e}"));
                }
                // pipe dropped here → EOF for git.
            }
            None => write_err = Some("stdin 파이프 실패".to_string()),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git 대기 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if !err.is_empty() {
            err
        } else if let Some(w) = write_err {
            w
        } else {
            "git 명령이 실패했습니다".to_string()
        });
    }
    if let Some(w) = write_err {
        // git exited 0 yet our write failed — surface it rather than a truncated result.
        return Err(w);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Like [`run_git`] but returns RAW stdout BYTES (no trim, no UTF-8 lossy) — needed
/// where every byte matters: a commit message is a byte payload whose trailing
/// newline and any non-UTF-8 bytes must survive a re-commit verbatim (codex/dual
/// review). The trimming/lossy [`run_git`]/[`run_git_raw`-style] paths would corrupt it.
fn run_git_bytes(cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("--literal-pathspecs")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            "git 명령이 실패했습니다".to_string()
        } else {
            err
        })
    }
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

/// Resolve a ref to exactly one commit (`rev-parse --verify <r>^{commit}`), erroring
/// for ranges/revspecs or non-commit objects — hardens commit-taking commands beyond
/// `safe_ref` (codex). Returns the resolved 40-char hash.
fn resolve_commit(cwd: &str, r: &str) -> Result<String, String> {
    safe_ref(r)?;
    run_git(cwd, &["rev-parse", "--verify", &format!("{r}^{{commit}}")])
        .map_err(|_| "유효한 커밋이 아닙니다".to_string())
}

/// True if a merge/revert/cherry-pick/rebase sequencer operation is in progress —
/// HEAD-moving commands refuse during these to avoid leaving confusing state.
fn op_in_progress(cwd: &str) -> bool {
    for r in ["MERGE_HEAD", "REVERT_HEAD", "CHERRY_PICK_HEAD"] {
        if run_git(cwd, &["rev-parse", "-q", "--verify", r]).is_ok() {
            return true;
        }
    }
    for dir in ["rebase-merge", "rebase-apply"] {
        if let Ok(p) = run_git(cwd, &["rev-parse", "--git-path", dir]) {
            if Path::new(&p).exists() {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_ref_rejects_leading_dash() {
        assert!(safe_ref("-rf").is_err());
        assert!(safe_ref("").is_err());
        assert!(safe_ref("feature/ok").is_ok());
    }
}
