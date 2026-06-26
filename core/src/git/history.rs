use serde::Serialize;

use super::{resolve_commit, run_git};

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
            // Keep auto-created reset backups out of the graph (they'd pile up as
            // decorations/nodes under `--all`). Harmless when ref_arg is a branch.
            "--exclude=refs/backup/*",
            ref_arg,
            order_flag,
            "--date=format:%Y-%m-%d %H:%M",
            fmt,
        ],
    )?;
    Ok(parse_log(&out))
}

/// The HEAD commit's full message (`%B`) — prefills the reword editor.
pub fn head_message(cwd: &str) -> Result<String, String> {
    run_git(cwd, &["log", "-1", "--format=%B", "HEAD"])
}

/// A specific commit's full message (`%B`) — prefills the past-commit reword editor.
/// `hash` is resolved to a single commit (rejects ranges / leading-dash).
pub fn commit_message(cwd: &str, hash: &str) -> Result<String, String> {
    let c = resolve_commit(cwd, hash)?;
    run_git(cwd, &["log", "-1", "--format=%B", &c])
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
