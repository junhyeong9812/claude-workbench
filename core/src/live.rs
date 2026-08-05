//! Is an external Claude session **still open somewhere else**?
//!
//! Adopting a session means spawning `claude --resume <uuid>` on a transcript
//! the user may still have open in a terminal. Both processes would then append
//! to the same JSONL — the session is corrupted, and neither side is told. So a
//! session is only adoptable when we can positively establish that nothing else
//! holds it; anything we cannot establish is [`Liveness::Unknown`] and stays
//! blocked (fail-closed — the cost of a false "busy" is one greyed-out row, the
//! cost of a false "free" is a destroyed transcript).
//!
//! ## Why this is not (only) an fd scan
//!
//! The original design was "scan `/proc/*/fd` for the transcript path". Measured
//! against the real CLI (2.1.221, 2026-08-05) that signal is nearly useless: the
//! CLI **opens, appends and closes** per write rather than holding the file. A
//! tight poll of a live session's fds during an active turn caught the open
//! descriptor in **1 of 387 polls** (~0.3%), and 0 times while the session sat
//! idle at its prompt. The fd scan is kept — when it *does* hit, it is proof,
//! and it also catches holders that aren't the CLI — but the load-bearing
//! signals are the two below.
//!
//! ## The signals, in order
//!
//! 1. **fd holder** — some process has the transcript open. Definite.
//! 2. **uuid in argv** — some process's command line contains this exact session
//!    uuid (`claude --resume <uuid>` / `--session-id <uuid>`, including through
//!    wrappers like `script -c`). Definite.
//! 3. **an un-pinned `claude` in the same cwd** — a `claude` process running in
//!    the session's own directory whose argv names *no* session uuid (a plain
//!    `claude`, or one that picked a session from the TUI). It could be this
//!    session and we cannot tell → `Unknown`. If its argv *does* name some uuid,
//!    it is pinned to a different session and is no threat.
//!
//! Signal 3 is why the cwd matters: resuming a transcript only works from the
//! directory it was created in, so the only processes that can collide with an
//! adopt are the ones running there.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Whether an external session can be safely adopted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Liveness {
    /// Nothing else holds this session — adoptable.
    Free,
    /// Definitely open elsewhere (fd holder, or its uuid is on a command line).
    Live,
    /// Could not be established either way — treated as busy.
    Unknown,
}

/// One process as seen through `/proc`.
#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    /// Resolved `/proc/<pid>/cwd`. `None` when the link isn't readable (another
    /// user's process, or the process exited mid-scan).
    pub cwd: Option<PathBuf>,
    /// `/proc/<pid>/cmdline` split on NUL.
    pub argv: Vec<String>,
}

impl ProcInfo {
    /// Is this the `claude` CLI itself? Matched on `argv[0]`'s file name only —
    /// matching *any* argv token would fire on every `grep claude` and block
    /// whole projects for no reason.
    pub fn is_claude(&self) -> bool {
        self.argv
            .first()
            .map(|a| Path::new(a).file_name().and_then(|f| f.to_str()) == Some("claude"))
            .unwrap_or(false)
    }

    /// Does the command line name a specific session (any uuid-shaped token)?
    /// Such a process is pinned to that session and can't be on another one.
    pub fn names_a_session(&self) -> bool {
        self.argv.iter().any(|a| is_uuid_shaped(a))
    }
}

/// `8-4-4-4-12` lowercase-or-uppercase hex — the shape of a Claude session id.
fn is_uuid_shaped(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for want in groups {
        let Some(p) = parts.next() else { return false };
        if p.len() != want || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

/// The result of walking `/proc`. `ok == false` means the walk itself failed
/// (no `/proc`, e.g. a non-Linux host) — callers must degrade every verdict to
/// [`Liveness::Unknown`] rather than concluding "nothing is running".
#[derive(Debug, Clone, Default)]
pub struct ProcScan {
    pub procs: Vec<ProcInfo>,
    pub ok: bool,
}

/// Snapshot every readable process under `proc_root`, excluding `self_pid`.
///
/// Processes that vanish mid-scan, and links we may not read, are skipped
/// silently — a partial view is normal and is exactly why an un-establishable
/// verdict is `Unknown` rather than `Free`.
pub fn scan_processes(proc_root: &Path, self_pid: u32) -> ProcScan {
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return ProcScan { procs: Vec::new(), ok: false };
    };
    let mut procs = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        if pid == self_pid {
            continue;
        }
        let dir = e.path();
        let Ok(raw) = std::fs::read(dir.join("cmdline")) else { continue };
        if raw.is_empty() {
            continue; // kernel thread
        }
        let argv: Vec<String> = raw
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        procs.push(ProcInfo { pid, cwd: std::fs::read_link(dir.join("cwd")).ok(), argv });
    }
    ProcScan { procs, ok: true }
}

/// Which of `targets` some process (other than `self_pid`) currently has open.
///
/// Best-effort: see the module docs for why a miss proves nothing. Walking every
/// process's fds is the only way to catch a non-CLI holder, and it costs a few
/// milliseconds for a few hundred processes.
pub fn scan_path_holders(
    proc_root: &Path,
    targets: &HashSet<PathBuf>,
    self_pid: u32,
) -> HashSet<PathBuf> {
    let mut held = HashSet::new();
    if targets.is_empty() {
        return held;
    }
    let Ok(entries) = std::fs::read_dir(proc_root) else { return held };
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(e.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            if targets.contains(&target) {
                held.insert(target);
            }
        }
    }
    held
}

/// Everything [`classify`] needs, gathered once for a whole listing.
#[derive(Debug, Clone, Default)]
pub struct LiveProbe {
    pub scan: ProcScan,
    pub holders: HashSet<PathBuf>,
}

impl LiveProbe {
    /// Gather the process table and the fd holders of `paths` in one pass.
    pub fn gather(proc_root: &Path, paths: &HashSet<PathBuf>, self_pid: u32) -> Self {
        LiveProbe {
            scan: scan_processes(proc_root, self_pid),
            holders: scan_path_holders(proc_root, paths, self_pid),
        }
    }

    /// Verdict for one session. Pure — all IO already happened in [`Self::gather`].
    ///
    /// `cwd` is the session's own directory (the transcript's first `cwd`),
    /// already canonicalized by the caller if it wants symlink-proof matching.
    pub fn classify(&self, uuid: &str, jsonl: &Path, cwd: &Path) -> Liveness {
        if self.holders.contains(jsonl) {
            return Liveness::Live; // signal 1
        }
        if !self.scan.ok {
            return Liveness::Unknown; // we never saw the process table
        }
        if self.scan.procs.iter().any(|p| p.argv.iter().any(|a| a == uuid)) {
            return Liveness::Live; // signal 2
        }
        let ambiguous = self.scan.procs.iter().any(|p| {
            p.is_claude() && !p.names_a_session() && p.cwd.as_deref() == Some(cwd)
        });
        if ambiguous {
            return Liveness::Unknown; // signal 3
        }
        Liveness::Free
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, cwd: Option<&str>, argv: &[&str]) -> ProcInfo {
        ProcInfo {
            pid,
            cwd: cwd.map(PathBuf::from),
            argv: argv.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn probe(procs: Vec<ProcInfo>, holders: &[&str]) -> LiveProbe {
        LiveProbe {
            scan: ProcScan { procs, ok: true },
            holders: holders.iter().map(PathBuf::from).collect(),
        }
    }

    const U: &str = "88b05349-b927-42aa-ad5c-57155ed29ec5";
    const OTHER: &str = "11111111-2222-3333-4444-555555555555";
    const J: &str = "/home/jun/.claude/projects/-p/88b05349-b927-42aa-ad5c-57155ed29ec5.jsonl";

    #[test]
    fn nothing_running_is_free() {
        let p = probe(vec![proc(1, Some("/home/jun/p"), &["bash"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Free);
    }

    #[test]
    fn an_fd_holder_is_live() {
        let p = probe(Vec::new(), &[J]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Live);
    }

    #[test]
    fn the_uuid_on_any_command_line_is_live() {
        // Directly…
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "--resume", U])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Live);
        // …and through a wrapper whose argv[0] isn't claude, from another cwd.
        let p = probe(
            vec![proc(9, Some("/elsewhere"), &["script", "-c", "claude --resume", U])],
            &[],
        );
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Live);
    }

    #[test]
    fn an_unpinned_claude_in_the_same_cwd_is_unknown() {
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Unknown);
    }

    #[test]
    fn an_unpinned_claude_elsewhere_does_not_block() {
        let p = probe(vec![proc(9, Some("/home/jun/other"), &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Free);
    }

    #[test]
    fn a_claude_pinned_to_another_session_does_not_block() {
        // It names a uuid, so it cannot also be on ours — no blanket block.
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "--resume", OTHER])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Free);
    }

    #[test]
    fn a_bare_claude_token_in_someone_elses_argv_does_not_block() {
        // `pgrep -af claude` must not look like a running session (argv[0] rule).
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["pgrep", "-af", "claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Free);
    }

    #[test]
    fn a_failed_process_scan_is_unknown_never_free() {
        let p = LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Unknown);
        // …but a positive fd hit still wins, since it needs no process table.
        let p = LiveProbe {
            scan: ProcScan { procs: Vec::new(), ok: false },
            holders: [PathBuf::from(J)].into_iter().collect(),
        };
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p")), Liveness::Live);
    }

    #[test]
    fn uuid_shape_recognition() {
        assert!(is_uuid_shaped(U));
        assert!(is_uuid_shaped("11111111-2222-3333-4444-555555555555"));
        assert!(!is_uuid_shaped("--resume"));
        assert!(!is_uuid_shaped("88b05349-b927-42aa-ad5c"));
        assert!(!is_uuid_shaped("88b05349-b927-42aa-ad5c-57155ed29ec5-extra"));
        assert!(!is_uuid_shaped("zzzzzzzz-b927-42aa-ad5c-57155ed29ec5"));
    }

    #[test]
    fn a_missing_proc_root_reports_not_ok() {
        let scan = scan_processes(Path::new("/definitely/not/proc"), 0);
        assert!(!scan.ok);
        assert!(scan.procs.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_scan_finds_a_really_open_file() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("mt-live-fd-{}.tmp", std::process::id()));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"held\n").unwrap();
        // Resolve through /tmp's own symlinks so the value matches readlink's.
        let path = path.canonicalize().unwrap();
        let targets: HashSet<PathBuf> = [path.clone()].into_iter().collect();

        // This test process holds it: excluding pid 0 (nobody) must find it…
        let held = scan_path_holders(Path::new("/proc"), &targets, 0);
        assert!(held.contains(&path), "open fd not found by the /proc scan");
        // …and excluding ourselves must not (self-exclusion works).
        let mine = scan_path_holders(Path::new("/proc"), &targets, std::process::id());
        assert!(!mine.contains(&path), "self-held fd was not excluded");

        drop(f);
        // Closed now — no holder.
        let after = scan_path_holders(Path::new("/proc"), &targets, 0);
        assert!(!after.contains(&path));
        let _ = std::fs::remove_file(&path);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn real_proc_scan_sees_this_test_process() {
        let scan = scan_processes(Path::new("/proc"), 0);
        assert!(scan.ok);
        assert!(scan.procs.iter().any(|p| p.pid == std::process::id()));
        // Excluding ourselves actually removes us.
        let without = scan_processes(Path::new("/proc"), std::process::id());
        assert!(!without.procs.iter().any(|p| p.pid == std::process::id()));
    }
}
