use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use super::{run_git, safe_ref};

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
}
