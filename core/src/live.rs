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
//! 2. **the session is pinned on a command line** — some process was launched
//!    with `--resume <uuid>` / `--session-id <uuid>` naming *this* session.
//!    Definite. See [`ProcInfo::session_ids`] for what counts as "named".
//! 3. **an un-pinned `claude` that could be here** — a `claude` process whose
//!    command line names no session at all (a plain `claude`, or one that picked
//!    a session from the TUI) and whose cwd is this session's directory, or whose
//!    cwd we could not read. It could be this session and we cannot tell →
//!    `Unknown`. A `claude` pinned to a *different* session is no threat.
//!
//! Signal 3 is why the cwd matters: resuming a transcript only works from the
//! directory it was created in, so the only processes that can collide with an
//! adopt are the ones running there. A `claude` whose cwd is unreadable is
//! therefore treated as if it *might* be there — an unreadable `/proc` entry
//! must never resolve to "safe" (review #3).
//!
//! ### Signal 3 is narrowed to one row per directory
//!
//! Blocking *every* transcript of a directory because one un-pinned `claude` runs
//! there was measured to make whole projects unadoptable (#69 review item 6: four
//! projects, nothing adoptable, for as long as a terminal `claude` sat at its
//! prompt). The narrowing rests on what such a process actually does: it appends
//! to the transcript it is running, and an append moves that file's mtime to now.
//! So among the candidates of that directory only the **mtime-newest** one is
//! held `Unknown` ([`CwdRank`]); the older ones are as adoptable as they were
//! before the process appeared. Ties (same-second mtimes) count as newest on both
//! sides — the cheap direction of error.
//!
//! The residual hole is stated rather than papered over: a `claude` that resumed
//! a session and has **not written a single record yet** leaves that transcript's
//! mtime where it was, so a *different* row can hold the newest slot and the real
//! one reads `Free`. That window is one turn long, and it is the price of the
//! narrowing — accepted deliberately (see
//! `a_freshly_resumed_session_that_has_not_written_yet_is_missed`).
//!
//! Everything that is not "an un-pinned `claude` whose cwd we positively read as
//! *this* directory" is unchanged and still blocks every row: an opaque process,
//! and a `claude` whose cwd we could not read, tell us nothing about *which*
//! transcript they hold, so no ranking applies to them.
//!
//! ## Known limits
//!
//! - **PID namespaces.** `scan.ok` only reports that *our* `/proc` was walked. A
//!   `claude` inside a container or another PID namespace is invisible to it, and
//!   its absence looks identical to "nothing is running". The fd scan has the
//!   same blind spot. Sessions of a containerised CLI are out of scope for the
//!   app (it spawns and lists host transcripts), but the guarantee here is "no
//!   host process holds this", not "no process anywhere".
//! - **Other users' processes.** `/proc/<pid>/cmdline` is world-readable but
//!   `cwd` is not, so another user's `claude` is identified yet un-located, and
//!   by the rule above blocks every row. That is the intended direction of
//!   error, not an oversight.

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

/// Where a session's transcript sits, by mtime, among the adoptable candidates
/// of its own directory. Only signal 3's "un-pinned `claude` *here*" case reads
/// it — see the module docs for why the newest row is the one that absorbs the
/// block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CwdRank {
    /// Nothing in this directory was written more recently — the transcript an
    /// un-pinned `claude` running here is presumed to be appending to. Also the
    /// value to pass whenever the rank could not be established (fail-closed).
    Newest,
    /// Some other candidate in the same directory is strictly newer, so this one
    /// is not what a currently-writing `claude` is holding.
    Older,
}

/// One process as seen through `/proc`.
#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    /// Resolved `/proc/<pid>/cwd`. `None` when the link isn't readable (another
    /// user's process, or the process exited mid-scan).
    pub cwd: Option<PathBuf>,
    /// `/proc/<pid>/cmdline` split on NUL. Empty when [`Self::opaque`].
    pub argv: Vec<String>,
    /// We could not read this process's command line at all, so we cannot say
    /// whether it is a `claude` or what it is running. Dropping such a process
    /// from the scan would let it resolve to "safe", so it is kept and treated
    /// as ambiguous (audit B3).
    pub opaque: bool,
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

    /// The session ids this command line **pins itself to**.
    ///
    /// Only a uuid in `--resume` / `--session-id` flag position counts. An
    /// earlier version accepted any uuid-shaped token anywhere in the argv,
    /// which inverted the verdict for the most ordinary command there is:
    /// `claude -p "... 88b05349-… ..."` — a prompt that merely quotes a session
    /// id — looked "pinned to another session", so signal 3 skipped it and a
    /// genuinely live session was reported adoptable (review #2). A uuid that
    /// isn't in flag position tells us nothing, so such a process stays
    /// un-pinned and converges on signal 3's `Unknown` instead.
    ///
    /// Tokens are split on whitespace first, so a wrapper that passes the whole
    /// command as one argument — `script -c "claude --resume <uuid>"` — is read
    /// the same as the flat form. (The mirror image, a *prompt* that literally
    /// contains `--resume <uuid>`, is then read as a pin; that is contrived, and
    /// it errs toward reporting that session Live.)
    pub fn session_ids(&self) -> Vec<&str> {
        // `-r` is the CLI's short form for `--resume` and is what people
        // actually type. A non-CLI process that happens to use `-r` for
        // something else (`grep -r <uuid>`) can only over-report that one
        // session as Live, never under-report.
        const FLAGS: [&str; 3] = ["--resume", "--session-id", "-r"];
        let mut out = Vec::new();
        let mut want_value = false;
        for word in self.argv.iter().flat_map(|a| a.split_whitespace()) {
            if want_value {
                want_value = false;
                if is_uuid_shaped(word) {
                    out.push(word);
                    continue;
                }
                // Not a uuid — fall through; this word may itself be a flag.
            }
            if FLAGS.contains(&word) {
                want_value = true;
            } else if let Some(v) =
                FLAGS.iter().find_map(|f| word.strip_prefix(f).and_then(|r| r.strip_prefix('=')))
            {
                if is_uuid_shaped(v) {
                    out.push(v);
                }
            }
        }
        out
    }

    /// Whether this command line pins itself to *some* session — such a process
    /// cannot also be on a different one.
    pub fn names_a_session(&self) -> bool {
        !self.session_ids().is_empty()
    }

    /// An un-pinned `claude` we positively located **in this directory**. This is
    /// the one signal-3 case narrow enough to rank: we know where it is, so we
    /// can ask *which* of that directory's transcripts it is writing (module
    /// docs, [`CwdRank`]).
    fn is_unpinned_claude_in(&self, cwd: &Path) -> bool {
        self.is_claude() && !self.names_a_session() && self.cwd.as_deref() == Some(cwd)
    }

    /// A process that could be running **any** session anywhere — an un-pinned
    /// `claude` whose cwd we could not read (fail-closed — review #3), or a
    /// process whose command line we could not read at all, which might be any
    /// `claude` anywhere (audit B3).
    ///
    /// Nothing about these says *which* transcript they hold, so they are not
    /// ranked: they keep blocking every row, exactly as before.
    fn is_unlocatable(&self) -> bool {
        self.opaque || (self.is_claude() && !self.names_a_session() && self.cwd.is_none())
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

/// Snapshot every process under `proc_root`, excluding `self_pid`.
///
/// Three outcomes per pid, and the distinction is the whole point:
///
/// - **gone** (`NotFound`) — the process exited between listing `/proc` and
///   reading it. Dropped, and that is a *positive* fact: something that has
///   exited holds nothing.
/// - **opaque** (any other read error) — it exists but we may not look at it.
///   Kept with [`ProcInfo::opaque`] set, so it blocks rather than disappears.
///   Dropping it, as an earlier version did, let an uninspectable process
///   resolve to "nothing is running here" (audit B3).
/// - **readable** — the normal case.
///
/// An empty command line is a kernel thread and is dropped, not treated as
/// opaque; kernel threads never run a CLI and blocking on them would make every
/// verdict `Unknown` forever.
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
        let raw = match std::fs::read(dir.join("cmdline")) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, // exited
            Err(_) => {
                procs.push(ProcInfo { pid, cwd: None, argv: Vec::new(), opaque: true });
                continue;
            }
        };
        if raw.is_empty() {
            continue; // kernel thread
        }
        let argv: Vec<String> = raw
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        procs.push(ProcInfo {
            pid,
            cwd: std::fs::read_link(dir.join("cwd")).ok(),
            argv,
            opaque: false,
        });
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
    ///
    /// `rank` is this transcript's mtime standing among the adoptable candidates
    /// of that same directory ([`crate::external::rank_of`] computes it). Pass
    /// [`CwdRank::Newest`] whenever it could not be established — that is the
    /// blocking value.
    pub fn classify(&self, uuid: &str, jsonl: &Path, cwd: &Path, rank: CwdRank) -> Liveness {
        if self.holders.contains(jsonl) {
            return Liveness::Live; // signal 1
        }
        if !self.scan.ok {
            return Liveness::Unknown; // we never saw the process table
        }
        if self.scan.procs.iter().any(|p| p.session_ids().contains(&uuid)) {
            return Liveness::Live; // signal 2
        }
        // signal 3a — something that could be on any session at all. Unranked:
        // it blocks every row of every directory (unchanged).
        if self.scan.procs.iter().any(|p| p.is_unlocatable()) {
            return Liveness::Unknown;
        }
        // signal 3b — an un-pinned `claude` running right here. It is writing one
        // of this directory's transcripts, and the newest one is the presumption
        // (module docs); the rest stay adoptable.
        if rank == CwdRank::Newest && self.scan.procs.iter().any(|p| p.is_unpinned_claude_in(cwd)) {
            return Liveness::Unknown;
        }
        Liveness::Free
    }
}

/// Test-only stand-in for "a terminal `claude` sitting at its prompt in `dir`":
/// a symlink named `claude` pointing at `sleep`, executed with `dir` as its cwd.
/// [`ProcInfo::is_claude`] matches on argv[0]'s **file name**, so this reads as a
/// real un-pinned `claude` through `/proc` without needing the CLI installed.
///
/// It lives outside `mod tests` because [`crate::external`]'s end-to-end test
/// needs the identical process shape — two copies of this would be two different
/// definitions of what the classifier is being tested against.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn spawn_unpinned_claude(dir: &Path) -> std::process::Child {
    let sleep = ["/bin/sleep", "/usr/bin/sleep"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.exists())
        .expect("no sleep binary to stand in for the CLI");
    let link = dir.join("claude");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(sleep, &link).unwrap();
    std::process::Command::new(&link)
        .arg("30")
        .current_dir(dir)
        .spawn()
        .expect("spawn stand-in claude")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, cwd: Option<&str>, argv: &[&str]) -> ProcInfo {
        ProcInfo {
            pid,
            cwd: cwd.map(PathBuf::from),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            opaque: false,
        }
    }

    /// A process whose command line we could not read at all.
    fn opaque(pid: u32) -> ProcInfo {
        ProcInfo { pid, cwd: None, argv: Vec::new(), opaque: true }
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
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
    }

    #[test]
    fn an_fd_holder_is_live() {
        let p = probe(Vec::new(), &[J]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Live);
    }

    #[test]
    fn a_session_named_in_flag_position_is_live() {
        for argv in [
            ["claude", "--resume", U].as_slice(),
            ["claude", "--session-id", U].as_slice(),
            ["claude", "--resume=88b05349-b927-42aa-ad5c-57155ed29ec5"].as_slice(),
        ] {
            let p = probe(vec![proc(9, Some("/home/jun/p"), argv)], &[]);
            assert_eq!(
                p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest),
                Liveness::Live,
                "{argv:?}"
            );
        }
    }

    #[test]
    fn a_wrapper_passing_the_command_as_one_token_is_read_the_same() {
        // `script -c "claude --resume <uuid>"` — the whole command is a single
        // argv entry. Splitting on whitespace makes the flat and wrapped forms
        // identical (the module doc claimed this before the code did).
        let wrapped = format!("claude --resume {U}");
        let p = probe(vec![proc(9, Some("/elsewhere"), &["script", "-c", &wrapped])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Live);
        assert_eq!(proc(9, None, &["script", "-c", &wrapped]).session_ids(), vec![U]);
    }

    #[test]
    fn a_uuid_quoted_in_a_prompt_is_not_a_pin() {
        // Regression (review #2): `claude -p "... <uuid> ..."` used to read as
        // "pinned to another session", which skipped signal 3 and reported a
        // genuinely live session adoptable. It names no session, so the verdict
        // must fall through to Unknown.
        let prompt = format!("이 세션 {OTHER} 좀 봐줘");
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "-p", &prompt])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
        assert!(!proc(9, None, &["claude", "-p", &prompt]).names_a_session());

        // Same for a bare uuid argument that isn't a session flag's value.
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "-p", OTHER])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
    }

    #[test]
    fn a_dangling_session_flag_pins_nothing() {
        let p = proc(9, None, &["claude", "--resume"]);
        assert!(p.session_ids().is_empty());
        // A non-uuid value doesn't pin, and the following word is still parsed.
        let p = proc(9, None, &["claude", "--resume", "latest", "--session-id", U]);
        assert_eq!(p.session_ids(), vec![U]);
    }

    #[test]
    fn an_unpinned_claude_in_the_same_cwd_is_unknown() {
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
    }

    #[test]
    fn an_unpinned_claude_here_blocks_only_the_newest_transcript() {
        // #69 review item 6: one terminal `claude` used to make every transcript
        // of the directory unadoptable. It writes one of them, and writing moves
        // that file's mtime to now — so the block lands on the newest row only.
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude"])], &[]);
        assert_eq!(
            p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest),
            Liveness::Unknown
        );
        assert_eq!(
            p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Older),
            Liveness::Free,
            "an older transcript of the same directory stays adoptable"
        );
    }

    #[test]
    fn a_freshly_resumed_session_that_has_not_written_yet_is_missed() {
        // The accepted hole in the narrowing above, pinned down so it can never
        // be mistaken for a bug in the ranking: an un-pinned `claude` resumed
        // this very session from the TUI but has not appended a record yet, so
        // some *other* transcript still holds the newest mtime and this one is
        // reported adoptable. One turn of exposure, taken knowingly (spec B).
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude"])], &[]);
        assert_eq!(
            p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Older),
            Liveness::Free
        );
        // Its first write flips the rank, and with it the verdict.
        assert_eq!(
            p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest),
            Liveness::Unknown
        );
    }

    #[test]
    fn the_rank_never_softens_the_other_signals() {
        // Only signal 3b is ranked. Everything that establishes liveness without
        // knowing *which* transcript is held must ignore the rank entirely.
        let older = CwdRank::Older;
        // signal 1 — an fd holder.
        let p = probe(Vec::new(), &[J]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), older), Liveness::Live);
        // signal 2 — pinned on a command line.
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "--resume", U])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), older), Liveness::Live);
        // signal 3a — an un-pinned claude we could not locate.
        let p = probe(vec![proc(9, None, &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), older), Liveness::Unknown);
        // signal 3a — an opaque process.
        let p = probe(vec![opaque(9)], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), older), Liveness::Unknown);
        // …and a failed scan.
        let p = LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), older), Liveness::Unknown);
    }

    #[test]
    fn an_unpinned_claude_elsewhere_does_not_block() {
        let p = probe(vec![proc(9, Some("/home/jun/other"), &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
    }

    #[test]
    fn a_claude_pinned_to_another_session_does_not_block() {
        // It names a uuid, so it cannot also be on ours — no blanket block.
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["claude", "--resume", OTHER])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
    }

    #[test]
    fn a_claude_whose_cwd_is_unreadable_blocks_every_row() {
        // Fail-closed (review #3): identified as claude, un-pinned, but we can't
        // say where it is — so it might be here, and here is every project.
        let p = probe(vec![proc(9, None, &["claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
        assert_eq!(
            p.classify(U, Path::new(J), Path::new("/somewhere/else"), CwdRank::Newest),
            Liveness::Unknown
        );
        // A *pinned* claude with an unreadable cwd is still no threat to others.
        let p = probe(vec![proc(9, None, &["claude", "--resume", OTHER])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
        // …and a non-claude process with an unreadable cwd is irrelevant.
        let p = probe(vec![proc(9, None, &["vim", "notes.md"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
    }

    #[test]
    fn an_unreadable_command_line_blocks_rather_than_vanishing() {
        // Audit B3: a process we may not inspect used to be dropped from the
        // scan entirely, so it resolved to "nothing is running here".
        let p = probe(vec![opaque(9)], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
        // It is not claimed to be running any particular session, though.
        assert!(opaque(9).session_ids().is_empty());
        assert!(!opaque(9).is_claude());
    }

    #[test]
    fn the_short_resume_flag_pins_too() {
        for argv in [["claude", "-r", U].as_slice(), ["claude", "-r=88b05349-b927-42aa-ad5c-57155ed29ec5"].as_slice()] {
            let p = probe(vec![proc(9, Some("/home/jun/p"), argv)], &[]);
            assert_eq!(
                p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest),
                Liveness::Live,
                "{argv:?}"
            );
        }
        // `-r` with a non-uuid value (`grep -r pattern`) pins nothing.
        assert!(proc(9, None, &["grep", "-r", "TODO", "."]).session_ids().is_empty());
        // A bundled short flag isn't `-r`.
        assert!(proc(9, None, &["rm", "-rf", U]).session_ids().is_empty());
    }

    #[test]
    fn a_bare_claude_token_in_someone_elses_argv_does_not_block() {
        // `pgrep -af claude` must not look like a running session (argv[0] rule).
        let p = probe(vec![proc(9, Some("/home/jun/p"), &["pgrep", "-af", "claude"])], &[]);
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Free);
    }

    #[test]
    fn a_failed_process_scan_is_unknown_never_free() {
        let p = LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Unknown);
        // …but a positive fd hit still wins, since it needs no process table.
        let p = LiveProbe {
            scan: ProcScan { procs: Vec::new(), ok: false },
            holders: [PathBuf::from(J)].into_iter().collect(),
        };
        assert_eq!(p.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest), Liveness::Live);
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

    /// Signal 2 end-to-end against a **real** process rather than a hand-built
    /// `ProcInfo` — the rest of the suite mocks the process table, so nothing
    /// else checks that `/proc/<pid>/cmdline` actually parses into the argv the
    /// classifier expects (review #8).
    #[cfg(target_os = "linux")]
    #[test]
    fn signal_two_catches_a_real_process_holding_the_uuid() {
        // `sh -c 'sleep 20' claude --resume <uuid>` — the words after the script
        // become $0.. and land in argv verbatim, so this stands in for a CLI
        // launched with the session pinned, without needing the CLI.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 20", "claude", "--resume", U])
            .spawn()
            .expect("spawn stand-in process");
        // Wait for the kernel to publish its cmdline.
        let mut probe = None;
        for _ in 0..100 {
            let p = LiveProbe {
                scan: scan_processes(Path::new("/proc"), std::process::id()),
                holders: HashSet::new(),
            };
            if p.scan.procs.iter().any(|x| x.pid == child.id()) {
                probe = Some(p);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let probe = probe.expect("stand-in process never appeared in /proc");
        let verdict = probe.classify(U, Path::new(J), Path::new("/home/jun/p"), CwdRank::Newest);
        let other =
            probe.classify(OTHER, Path::new("/nope.jsonl"), Path::new("/home/jun/p"), CwdRank::Newest);
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(verdict, Liveness::Live, "a real pinned process must read as Live");
        // It pins one session, so it must not blanket-block a different one.
        assert_eq!(other, Liveness::Free);
    }

    /// Signal 3b end-to-end against a **real** process: the narrowing is only
    /// sound if `/proc/<pid>/cwd` really resolves to the directory we compare
    /// against, which no mocked `ProcInfo` can show.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_unpinned_claude_here_blocks_only_the_newest() {
        let dir = std::env::temp_dir().join(format!("mt-live-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let mut child = spawn_unpinned_claude(&dir);
        let mut probe = None;
        for _ in 0..100 {
            let p = LiveProbe {
                scan: scan_processes(Path::new("/proc"), std::process::id()),
                holders: HashSet::new(),
            };
            // Wait until its cwd link is published too, not just its cmdline.
            if p.scan.procs.iter().any(|x| x.pid == child.id() && x.cwd.as_deref() == Some(&*dir)) {
                probe = Some(p);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let probe = probe.expect("stand-in process never appeared in /proc with its cwd");
        // A uuid of this test's own, so the sibling signal-2 test's stand-in
        // process (which pins `U`) can't decide this verdict when the suite runs
        // its tests in parallel.
        const MINE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        let jsonl = Path::new("/home/jun/.claude/projects/-p/7c9e6679-7425-40de-944b-e07fc1f90ae7.jsonl");
        let newest = probe.classify(MINE, jsonl, &dir, CwdRank::Newest);
        let older = probe.classify(MINE, jsonl, &dir, CwdRank::Older);
        let elsewhere = probe.classify(MINE, jsonl, Path::new("/home/jun/p"), CwdRank::Newest);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(newest, Liveness::Unknown, "the newest row of that cwd must block");
        assert_eq!(older, Liveness::Free, "older rows of that cwd must stay adoptable");
        assert_eq!(elsewhere, Liveness::Free, "another directory is untouched");
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
