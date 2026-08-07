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
//! ### Signal 3 is narrowed by **when the process started**, not by rank
//!
//! Blocking *every* transcript of a directory because one un-pinned `claude` runs
//! there was measured to make whole projects unadoptable (#69 review item 6: four
//! projects, nothing adoptable, for as long as a terminal `claude` sat at its
//! prompt). The narrowing that replaces it is a time threshold:
//!
//! > take the **earliest start time** among the un-pinned `claude` processes
//! > running in this directory, subtract a margin ε, and block every candidate
//! > whose transcript was written at or after that instant.
//!
//! The argument is one-directional and does not depend on guessing *which*
//! transcript a process holds: a running process can only have appended to its
//! transcript **after it started**, so any transcript last written before every
//! such process started cannot be the one being written now. Older rows are
//! therefore provably safe; everything from the threshold on is blocked, however
//! many rows that is.
//!
//! A first attempt ranked by mtime instead — "only the newest row is at risk" —
//! and the review broke it with real processes twice: a *pinned* session or a
//! newer transcript whose writer had already exited stole the crown and let the
//! genuinely held one read `Free` (MISS2), and two un-pinned `claude`s in one
//! directory could only ever block one row between them (MISS1). Both are
//! single-writer assumptions. The threshold has no such assumption: it is
//! computed from the processes, and every row is compared against it
//! independently.
//!
//! The residual hole is exactly the one accepted from the start, and no larger: a
//! `claude` that resumed a session and has **not written a single record yet**
//! leaves that transcript's mtime where it was, so a transcript older than the
//! threshold can still be the one it holds (see
//! `a_freshly_resumed_session_that_has_not_written_yet_is_missed`).
//!
//! The threshold rests on one conversion — process start (ticks since boot) into
//! a wall-clock instant comparable with an mtime — and that conversion is where
//! the remaining ways to be wrong live. A suspend or stall between its reads is
//! detected and refused ([`boot_instant`]); a forward step of the wall clock is
//! not detectable from inside and moves the threshold later by the size of the
//! step, so [`START_EPSILON_SECS`] is a minute rather than a few seconds. Both
//! defences push in the same direction: when the clocks are unclear, block.
//!
//! Everything that is not "an un-pinned `claude` whose cwd we positively read as
//! *this* directory" is unchanged and still blocks every row: an opaque process,
//! and a `claude` whose cwd we could not read, tell us nothing about *where* they
//! are, so no threshold can be computed for them. An un-pinned `claude` that *is*
//! here but whose start time we cannot read blocks this directory whole — a
//! threshold we failed to compute must never resolve to "safe".
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
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Safety margin subtracted from the earliest un-pinned `claude`'s start time
/// before comparing it against transcript mtimes.
///
/// What it absorbs: second-level truncation on both sides of the conversion
/// (`/proc/uptime` → boot instant → start instant), a write that landed in the
/// same moment the process came up, and — the reason it is a minute rather than a
/// few seconds — a **wall-clock step** between reading the uptime and reading the
/// clock. The conversion window is validated ([`boot_instant`]), which catches a
/// suspend; a pure forward step of the clock is invisible to that check and moves
/// the computed start *later* by exactly the step, i.e. straight into the missing
/// direction.
///
/// The trade is deliberately lopsided. Over-blocking costs only "transcripts last
/// written in the 60 s before a `claude` started" — a window in which a session
/// nobody has touched since is unlikely to be sitting, and the row comes back the
/// moment that process exits. Under-blocking costs a destroyed transcript. So the
/// residual miss is narrowed to clock steps larger than a minute.
pub const START_EPSILON_SECS: u64 = 60;

/// How long the boot-instant conversion may take before we distrust it.
///
/// The three reads (`uptime`, wall clock, `uptime` again) are microseconds apart
/// in the normal case. A second or more between the two uptime reads means the
/// machine was not running normally in between — a suspend, a stalled VM — and
/// the arithmetic tying them to the wall clock no longer holds.
const CONVERSION_WINDOW_SECS: f64 = 1.0;

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

/// *Why* a session is not adoptable. The verdict alone is not enough to say
/// anything true to the user: "확인 불가" from a process we could not place means
/// **no** session anywhere can be opened, while "확인 불가" from the time
/// threshold means the older sessions of this directory still can. Telling the
/// user the second sentence in the first situation is a lie the UI used to tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    /// Signals 1–2 — *this* session is open elsewhere. Closing that window frees
    /// exactly this row.
    ThisSession,
    /// Signal 3a — a process we could not place at all (opaque command line, an
    /// un-pinned `claude` with an unreadable cwd), or no process table. Every
    /// session everywhere is blocked until it goes away.
    Undecidable,
    /// Signal 3b — an un-pinned `claude` is running in this directory and this
    /// transcript was written at or after it started. Sessions of the same
    /// directory last written before that are unaffected.
    WrittenSinceStart,
}

/// A verdict plus the reason behind it. `reason` is `None` exactly when
/// `live == Free`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Verdict {
    pub live: Liveness,
    pub reason: Option<BlockReason>,
}

impl Verdict {
    const FREE: Verdict = Verdict { live: Liveness::Free, reason: None };

    fn blocked(live: Liveness, reason: BlockReason) -> Verdict {
        Verdict { live, reason: Some(reason) }
    }
}

/// What signal 3b blocks in one directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Threshold {
    /// An un-pinned `claude` is here but we could not read when it started —
    /// block the whole directory (a threshold we failed to compute is not a
    /// threshold of "everything is fine").
    All,
    /// Block transcripts whose mtime is at or after this unix second.
    Since(u64),
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
    /// When this process started, unix seconds — the input to signal 3b's
    /// threshold.
    ///
    /// Only filled in for the processes that can *set* a threshold, i.e.
    /// un-pinned `claude`s whose cwd we read ([`Self::is_unpinned_claude_in`]).
    /// Reading `/proc/<pid>/stat` for the other few hundred processes on the
    /// machine would be pure waste — nothing ever asks for their start time.
    /// `None` on such a process therefore means "not applicable"; on an un-pinned
    /// `claude` it means "unreadable", and that one blocks its whole directory.
    pub started: Option<u64>,
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
    /// the one signal-3 case narrow enough to bound: we know where it is and when
    /// it started, so we can say which of that directory's transcripts it cannot
    /// have written (module docs, [`Threshold`]).
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

/// The instant the machine booted, unix seconds, derived from `/proc/uptime`.
///
/// `/proc/<pid>/stat` reports a process's start as ticks **since boot**, so this
/// is what turns it into a wall-clock instant comparable with a file mtime.
///
/// The conversion is only valid if the two clocks it bridges did not diverge
/// while it ran, so the uptime is read **on both sides** of the wall-clock read
/// and the window between them is checked ([`boot_from_window`]). A machine that
/// suspended mid-conversion produces a boot instant that is wrong by the length
/// of the suspend, and every start time with it. One retry, then `None`.
///
/// `None` — unreadable (`a fake proc root in tests, a non-Linux host`) or an
/// untrustworthy window — makes every start time read as unreadable, which blocks
/// the directories those processes are in. That is the point: a conversion we
/// cannot trust must not produce a threshold.
fn boot_instant(proc_root: &Path) -> Option<u64> {
    (0..2).find_map(|_| boot_instant_once(proc_root))
}

fn boot_instant_once(proc_root: &Path) -> Option<u64> {
    let up1 = read_uptime(proc_root)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let up2 = read_uptime(proc_root)?;
    boot_from_window(up1, now, up2)
}

fn read_uptime(proc_root: &Path) -> Option<f64> {
    let uptime = std::fs::read_to_string(proc_root.join("uptime")).ok()?;
    let secs: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    (secs.is_finite() && secs >= 0.0).then_some(secs)
}

/// `now − uptime`, but only when the two uptime readings taken around `now` are
/// close enough to call the whole thing one instant.
///
/// The **later** uptime is the one used: a larger uptime means an earlier boot,
/// an earlier start, an earlier threshold — more blocking. Where the arithmetic
/// has slack, the slack goes toward blocking.
fn boot_from_window(up1: f64, now: u64, up2: f64) -> Option<u64> {
    if !(up2 >= up1) || up2 - up1 > CONVERSION_WINDOW_SECS {
        return None; // suspended, stalled, or the clock went backwards
    }
    Some(now.saturating_sub(up2 as u64))
}

/// Clock ticks per second — the unit of `/proc/<pid>/stat`'s `starttime` field.
/// `sysconf(_SC_CLK_TCK)` is 100 on every Linux the app runs on; a bogus value
/// falls back to that rather than dividing by zero.
fn clock_ticks() -> u64 {
    let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if t > 0 {
        t as u64
    } else {
        100
    }
}

/// Wall-clock start of the process at `proc_dir`, unix seconds.
///
/// `starttime` is field 22 of `/proc/<pid>/stat`, and the fields cannot be split
/// on whitespace from the left: field 2 is the executable name in parentheses and
/// may itself contain spaces **and** parentheses (`(sh -c (x))`). Everything is
/// therefore read relative to the **last** `)`, after which field 3 begins.
fn start_instant(proc_dir: &Path, boot: Option<u64>) -> Option<u64> {
    let boot = boot?;
    let stat = std::fs::read_to_string(proc_dir.join("stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')?.checked_add(1)?..];
    // after_comm starts at field 3, so field 22 is the 20th token (index 19).
    let ticks: u64 = after_comm.split_whitespace().nth(19)?.parse().ok()?;
    Some(boot + ticks / clock_ticks())
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
    // Read once for the whole walk: every start time is boot + ticks.
    let boot = boot_instant(proc_root);
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
                procs.push(ProcInfo {
                    pid,
                    cwd: None,
                    argv: Vec::new(),
                    opaque: true,
                    started: None,
                });
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
        let mut p = ProcInfo {
            pid,
            cwd: std::fs::read_link(dir.join("cwd")).ok(),
            argv,
            opaque: false,
            started: None,
        };
        // Only an un-pinned `claude` we could place can set a threshold, so only
        // those pay for a `stat` read (see [`ProcInfo::started`]).
        if p.is_claude() && !p.names_a_session() && p.cwd.is_some() {
            p.started = start_instant(&dir, boot);
        }
        procs.push(p);
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
    /// `modified` yields the transcript's mtime in unix seconds, and is called
    /// **only** when signal 3b actually needs it — i.e. when an un-pinned
    /// `claude` is running in `cwd` with a readable start time. Nothing else in
    /// the verdict depends on it, so a caller that would have to go and stat the
    /// world (the spawn-time recheck holds a lock while it does) pays for it only
    /// in the one case that can change the answer.
    ///
    /// `None` from `modified` means the caller could not establish the mtime —
    /// the transcript is gone, or is no longer a candidate at all. That is a
    /// question we failed to answer while a `claude` is running here, so it
    /// blocks ([`BlockReason::Undecidable`]); it must never fall through to
    /// `Free`.
    pub fn classify(
        &self,
        uuid: &str,
        jsonl: &Path,
        cwd: &Path,
        modified: impl FnOnce() -> Option<u64>,
    ) -> Verdict {
        if self.holders.contains(jsonl) {
            return Verdict::blocked(Liveness::Live, BlockReason::ThisSession); // signal 1
        }
        if !self.scan.ok {
            // We never saw the process table.
            return Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable);
        }
        if self.scan.procs.iter().any(|p| p.session_ids().contains(&uuid)) {
            return Verdict::blocked(Liveness::Live, BlockReason::ThisSession); // signal 2
        }
        // signal 3a — something that could be on any session at all. It blocks
        // every row of every directory (unchanged).
        if self.scan.procs.iter().any(|p| p.is_unlocatable()) {
            return Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable);
        }
        // signal 3b — an un-pinned `claude` running right here cannot have
        // appended before it started, so everything written since is suspect and
        // everything older is provably not what it holds (module docs).
        match self.block_threshold(cwd) {
            None => Verdict::FREE,
            Some(Threshold::All) => Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable),
            Some(Threshold::Since(t)) => match modified() {
                Some(m) if m < t => Verdict::FREE,
                Some(_) => Verdict::blocked(Liveness::Unknown, BlockReason::WrittenSinceStart),
                None => Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable),
            },
        }
    }

    /// What signal 3b blocks in `cwd`: `None` when no un-pinned `claude` is
    /// running there at all.
    ///
    /// The **earliest** start wins: with two such processes, either could be on
    /// any of the directory's transcripts, so only transcripts older than both
    /// are safe. (An earlier design took the newest-mtime row instead and could
    /// only ever block one row between the two — MISS1.)
    fn block_threshold(&self, cwd: &Path) -> Option<Threshold> {
        let mut earliest: Option<u64> = None;
        let mut any = false;
        for p in self.scan.procs.iter().filter(|p| p.is_unpinned_claude_in(cwd)) {
            any = true;
            match p.started {
                // One unreadable start time loses the threshold: we no longer
                // know how far back to trust, so nothing here is trusted. (Note
                // this must not be written with `?` — returning `None` from here
                // would mean "nothing is blocked", the exact inversion.)
                None => return Some(Threshold::All),
                Some(s) => earliest = Some(earliest.map_or(s, |e: u64| e.min(s))),
            }
        }
        if !any {
            return None;
        }
        Some(earliest.map_or(Threshold::All, |e| {
            Threshold::Since(e.saturating_sub(START_EPSILON_SECS))
        }))
    }
}

/// Test-only stand-in for "a terminal `claude` running in `dir`": a symlink named
/// `claude` pointing at `/bin/sh`, executed with `dir` as its cwd.
/// [`ProcInfo::is_claude`] matches on argv[0]'s **file name**, so this reads as a
/// real `claude` through `/proc` without needing the CLI installed — with a real
/// cwd link and a real `/proc/<pid>/stat` start time, which is the whole point:
/// no hand-built `ProcInfo` can show that those two reads work.
///
/// `pinned_to` appends `--resume <uuid>`, giving the other shape the classifier
/// must tell apart (a pinned process sets no threshold). The script is
/// `sleep 30; true` rather than a bare `sleep 30` on purpose: `sh -c` with a
/// single simple command `exec`s it, which would replace the argv this whole
/// trick depends on.
///
/// It lives outside `mod tests` because [`crate::external`]'s end-to-end tests
/// need the identical process shape — two copies of this would be two different
/// definitions of what the classifier is being tested against.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn spawn_stand_in_claude(dir: &Path, pinned_to: Option<&str>) -> std::process::Child {
    let sh = ["/bin/sh", "/usr/bin/sh"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.exists())
        .expect("no sh to stand in for the CLI");
    let link = dir.join("claude");
    if !link.exists() {
        std::os::unix::fs::symlink(sh, &link).unwrap();
    }
    let mut cmd = std::process::Command::new(&link);
    cmd.args(["-c", "sleep 30; true", "stand-in"]).current_dir(dir);
    if let Some(uuid) = pinned_to {
        cmd.args(["--resume", uuid]);
    }
    cmd.spawn().expect("spawn stand-in claude")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// When the stand-in un-pinned `claude` of a mocked process table started.
    const STARTED: u64 = 1_800_000_000;
    /// A transcript last written well before any of them started — provably not
    /// what a running process is appending to.
    const BEFORE: u64 = STARTED - 3600;
    /// A transcript written after one started — inside the blocked window.
    const AFTER: u64 = STARTED + 10;

    /// A readable process. `started` is filled in for every entry: only un-pinned
    /// `claude`s in the directory under test ever read it, and giving them all a
    /// value keeps the tests about the signal rather than the bookkeeping.
    fn proc(pid: u32, cwd: Option<&str>, argv: &[&str]) -> ProcInfo {
        proc_started(pid, cwd, argv, Some(STARTED))
    }

    /// Same, with an explicit start time — `None` stands for "`/proc/<pid>/stat`
    /// was unreadable".
    fn proc_started(pid: u32, cwd: Option<&str>, argv: &[&str], started: Option<u64>) -> ProcInfo {
        ProcInfo {
            pid,
            cwd: cwd.map(PathBuf::from),
            argv: argv.iter().map(|s| s.to_string()).collect(),
            opaque: false,
            started,
        }
    }

    /// A process whose command line we could not read at all.
    fn opaque(pid: u32) -> ProcInfo {
        ProcInfo { pid, cwd: None, argv: Vec::new(), opaque: true, started: None }
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
    const P: &str = "/home/jun/p";

    /// Verdict for session `U` in `cwd`, whose transcript was last written at
    /// `modified`.
    fn verdict(p: &LiveProbe, cwd: &str, modified: u64) -> Verdict {
        p.classify(U, Path::new(J), Path::new(cwd), || Some(modified))
    }

    /// The same, when only the verdict (not the reason) is the point. `AFTER` is
    /// the worst case for the caller, so a `Free` here is the strong assertion.
    fn live_at(p: &LiveProbe, cwd: &str) -> Liveness {
        verdict(p, cwd, AFTER).live
    }

    #[test]
    fn nothing_running_is_free() {
        let p = probe(vec![proc(1, Some(P), &["bash"])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
    }

    #[test]
    fn an_fd_holder_is_live() {
        let p = probe(Vec::new(), &[J]);
        assert_eq!(
            verdict(&p, P, AFTER),
            Verdict::blocked(Liveness::Live, BlockReason::ThisSession)
        );
    }

    #[test]
    fn a_session_named_in_flag_position_is_live() {
        for argv in [
            ["claude", "--resume", U].as_slice(),
            ["claude", "--session-id", U].as_slice(),
            ["claude", "--resume=88b05349-b927-42aa-ad5c-57155ed29ec5"].as_slice(),
        ] {
            let p = probe(vec![proc(9, Some(P), argv)], &[]);
            assert_eq!(live_at(&p, P), Liveness::Live, "{argv:?}");
        }
    }

    #[test]
    fn a_wrapper_passing_the_command_as_one_token_is_read_the_same() {
        // `script -c "claude --resume <uuid>"` — the whole command is a single
        // argv entry. Splitting on whitespace makes the flat and wrapped forms
        // identical (the module doc claimed this before the code did).
        let wrapped = format!("claude --resume {U}");
        let p = probe(vec![proc(9, Some("/elsewhere"), &["script", "-c", &wrapped])], &[]);
        assert_eq!(live_at(&p, P), Liveness::Live);
        assert_eq!(proc(9, None, &["script", "-c", &wrapped]).session_ids(), vec![U]);
    }

    #[test]
    fn a_uuid_quoted_in_a_prompt_is_not_a_pin() {
        // Regression (review #2): `claude -p "... <uuid> ..."` used to read as
        // "pinned to another session", which skipped signal 3 and reported a
        // genuinely live session adoptable. It names no session, so the verdict
        // must fall through to the time threshold — and this transcript was
        // written after it started.
        let prompt = format!("이 세션 {OTHER} 좀 봐줘");
        let p = probe(vec![proc(9, Some(P), &["claude", "-p", &prompt])], &[]);
        assert_eq!(live_at(&p, P), Liveness::Unknown);
        assert!(!proc(9, None, &["claude", "-p", &prompt]).names_a_session());

        // Same for a bare uuid argument that isn't a session flag's value.
        let p = probe(vec![proc(9, Some(P), &["claude", "-p", OTHER])], &[]);
        assert_eq!(live_at(&p, P), Liveness::Unknown);
    }

    #[test]
    fn a_dangling_session_flag_pins_nothing() {
        let p = proc(9, None, &["claude", "--resume"]);
        assert!(p.session_ids().is_empty());
        // A non-uuid value doesn't pin, and the following word is still parsed.
        let p = proc(9, None, &["claude", "--resume", "latest", "--session-id", U]);
        assert_eq!(p.session_ids(), vec![U]);
    }

    // ---- signal 3b: the start-time threshold ----

    #[test]
    fn an_unpinned_claude_here_blocks_what_was_written_since_it_started() {
        // #69 review item 6: one terminal `claude` used to make every transcript
        // of the directory unadoptable. It cannot have appended before it
        // started, so only transcripts touched since are suspect.
        let p = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        assert_eq!(
            verdict(&p, P, AFTER),
            Verdict::blocked(Liveness::Unknown, BlockReason::WrittenSinceStart)
        );
        assert_eq!(
            verdict(&p, P, BEFORE),
            Verdict::FREE,
            "a transcript last written before it started cannot be the one it holds"
        );
    }

    #[test]
    fn two_unpinned_claudes_are_covered_by_the_earliest_start() {
        // MISS1 (review, real processes): the previous rule blocked the single
        // mtime-newest row, so a second un-pinned `claude` in the same directory
        // got no coverage at all. The threshold is per-directory, not per-row.
        let old = STARTED - 600;
        let p = probe(
            vec![
                proc_started(9, Some(P), &["claude"], Some(STARTED)),
                proc_started(10, Some(P), &["claude"], Some(old)),
            ],
            &[],
        );
        // Written between the two starts: still inside the earlier one's window.
        assert_eq!(verdict(&p, P, old + 120).live, Liveness::Unknown);
        // Both rows of a two-row directory block, not just one.
        assert_eq!(verdict(&p, P, AFTER).live, Liveness::Unknown);
        // Older than both (and than ε) — safe.
        assert_eq!(verdict(&p, P, old - START_EPSILON_SECS - 1), Verdict::FREE);
    }

    #[test]
    fn a_pinned_or_dead_writer_cannot_steal_the_verdict() {
        // MISS2 (review, real processes): the previous rule handed the block to
        // whichever transcript had the newest mtime, so a *pinned* session or one
        // whose writer had already exited could absorb it and leave the genuinely
        // held transcript reading Free. Nothing about a threshold depends on the
        // other rows, so the pinned neighbour changes nothing here.
        let p = probe(
            vec![
                proc(9, Some(P), &["claude"]),                        // un-pinned, here
                proc(10, Some(P), &["claude", "--resume", OTHER]),    // pinned elsewhere
            ],
            &[],
        );
        // Our row was written after the un-pinned one started → blocked, however
        // much newer the pinned session's own transcript is.
        assert_eq!(
            verdict(&p, P, AFTER),
            Verdict::blocked(Liveness::Unknown, BlockReason::WrittenSinceStart)
        );
        // …and the pinned session itself still reads Live on its own row.
        let pinned =
            p.classify(OTHER, Path::new("/other.jsonl"), Path::new(P), || Some(BEFORE));
        assert_eq!(pinned, Verdict::blocked(Liveness::Live, BlockReason::ThisSession));
    }

    #[test]
    fn the_epsilon_keeps_a_write_that_raced_the_start_blocked() {
        // Second-level truncation on both sides of the clock conversion, a write
        // landing in the same instant the process came up, and a wall-clock step
        // up to ε must not fall on the "safe" side of the line.
        let p = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        assert_eq!(verdict(&p, P, STARTED).live, Liveness::Unknown);
        assert_eq!(verdict(&p, P, STARTED - START_EPSILON_SECS).live, Liveness::Unknown);
        // …but the margin is finite, and the row comes back just outside it.
        assert_eq!(verdict(&p, P, STARTED - START_EPSILON_SECS - 1), Verdict::FREE);
        // The margin is a minute, not a few seconds: a clock step is invisible to
        // the conversion-window check and moves the threshold *later*, i.e. into
        // the missing direction, so this constant is a safety property.
        assert!(START_EPSILON_SECS >= 60, "ε was narrowed — see the module docs on clock steps");
    }

    #[test]
    fn a_conversion_window_that_cannot_be_trusted_yields_no_boot_instant() {
        // now − uptime is only one instant's arithmetic if the machine was
        // running normally across the three reads. A suspend shows up as a gap
        // between the two uptime readings.
        let now = 1_800_000_000u64;
        // Normal: microseconds apart, and the *later* uptime wins (earlier boot →
        // earlier threshold → more blocking).
        assert_eq!(boot_from_window(1000.0, now, 1000.002), Some(now - 1000));
        assert_eq!(boot_from_window(1000.0, now, 1001.0), Some(now - 1001), "슬랙은 차단 쪽으로");
        // Suspended (or a stalled VM) between the reads — refuse.
        assert_eq!(boot_from_window(1000.0, now, 1001.001), None);
        assert_eq!(boot_from_window(1000.0, now, 4000.0), None);
        // Uptime went backwards: nothing about this is trustworthy either.
        assert_eq!(boot_from_window(1000.0, now, 999.9), None);
        // A boot instant after the epoch's start is still just arithmetic.
        assert_eq!(boot_from_window(0.0, 0, 0.0), Some(0));
    }

    /// A synthetic `/proc` — the only way to exercise `scan_processes`'s start
    /// time plumbing (and its **absence**) without a suspend to reproduce.
    fn fake_proc(tag: &str, uptime: Option<&str>, stat_ticks: Option<u64>) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mt-live-fakeproc-{}-{tag}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let pid_dir = root.join("4242");
        std::fs::create_dir_all(&pid_dir).unwrap();
        if let Some(u) = uptime {
            std::fs::write(root.join("uptime"), u).unwrap();
        }
        std::fs::write(pid_dir.join("cmdline"), b"claude\0").unwrap();
        let cwd = root.join("cwd-target");
        std::fs::create_dir_all(&cwd).unwrap();
        std::os::unix::fs::symlink(&cwd, pid_dir.join("cwd")).unwrap();
        if let Some(ticks) = stat_ticks {
            // Field 2 carries spaces and parens on purpose: the parser must find
            // the *last* ')' rather than splitting from the left.
            std::fs::write(
                pid_dir.join("stat"),
                format!(
                    "4242 (claude (odd) name) S {} {ticks} 0 0\n",
                    "0 ".repeat(18).trim()
                ),
            )
            .unwrap();
        }
        root
    }

    #[test]
    fn an_unusable_clock_conversion_blocks_the_directory_it_would_have_bounded() {
        // End to end through `scan_processes`: an un-pinned claude whose start we
        // cannot convert must leave the directory blocked, not open.
        let ticks = clock_ticks();
        // No /proc/uptime → no boot instant → no start time → Threshold::All.
        let root = fake_proc("nouptime", None, Some(10 * ticks));
        let scan = scan_processes(&root, 0);
        let p = LiveProbe { scan, holders: HashSet::new() };
        let cwd = root.join("cwd-target").canonicalize().unwrap();
        assert!(p.scan.procs.iter().all(|x| x.started.is_none()));
        assert_eq!(
            p.classify(U, Path::new(J), &cwd, || Some(0)),
            Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable),
            "시각 환산 불가 = 그 cwd 전체 차단"
        );
        let _ = std::fs::remove_dir_all(&root);

        // Uptime readable but the process's own stat is missing — same answer.
        let root = fake_proc("nostat", Some("5000.00 4000.00\n"), None);
        let scan = scan_processes(&root, 0);
        let cwd = root.join("cwd-target").canonicalize().unwrap();
        let p = LiveProbe { scan, holders: HashSet::new() };
        assert_eq!(p.classify(U, Path::new(J), &cwd, || Some(0)).live, Liveness::Unknown);
        let _ = std::fs::remove_dir_all(&root);

        // Both readable → a real threshold, and the row written before it is free.
        let root = fake_proc("ok", Some("5000.00 4000.00\n"), Some(4000 * ticks));
        let scan = scan_processes(&root, 0);
        let cwd = root.join("cwd-target").canonicalize().unwrap();
        let started = scan
            .procs
            .iter()
            .find(|x| x.pid == 4242)
            .and_then(|x| x.started)
            .expect("start time must come back from a well-formed /proc");
        let p = LiveProbe { scan, holders: HashSet::new() };
        assert_eq!(p.classify(U, Path::new(J), &cwd, || Some(started + 1)).live, Liveness::Unknown);
        assert_eq!(
            p.classify(U, Path::new(J), &cwd, || Some(started - START_EPSILON_SECS - 1)),
            Verdict::FREE
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_freshly_resumed_session_that_has_not_written_yet_is_missed() {
        // The one accepted hole, pinned down so it can never be mistaken for a
        // bug: an un-pinned `claude` resumed *this* session from the TUI but has
        // not appended a record yet, so its mtime is still older than the
        // threshold and the row reads Free. One turn of exposure, taken knowingly
        // (spec B) — and the redesign deliberately did not widen it.
        let p = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        assert_eq!(verdict(&p, P, BEFORE), Verdict::FREE);
        // Its first write moves the mtime past the threshold, and with it the
        // verdict.
        assert_eq!(verdict(&p, P, AFTER).live, Liveness::Unknown);
    }

    #[test]
    fn an_unreadable_start_time_blocks_the_whole_directory() {
        // A threshold we failed to compute is not a threshold of "everything is
        // fine": with no idea how far back to trust, nothing here is trusted.
        let p = probe(vec![proc_started(9, Some(P), &["claude"], None)], &[]);
        for m in [BEFORE, AFTER] {
            assert_eq!(
                verdict(&p, P, m),
                Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable),
                "mtime {m}"
            );
        }
        // One unreadable start poisons the directory even when a sibling's is
        // readable — the unreadable one could have started at any time.
        let p = probe(
            vec![
                proc_started(9, Some(P), &["claude"], Some(STARTED)),
                proc_started(10, Some(P), &["claude"], None),
            ],
            &[],
        );
        assert_eq!(verdict(&p, P, BEFORE).live, Liveness::Unknown);
        // Another directory is still unaffected.
        assert_eq!(verdict(&p, "/elsewhere", AFTER), Verdict::FREE);
    }

    #[test]
    fn an_mtime_we_could_not_establish_blocks() {
        // The caller could not say when (or whether) this transcript was written
        // — while an un-pinned `claude` runs here. Unanswered is not safe.
        let p = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        assert_eq!(
            p.classify(U, Path::new(J), Path::new(P), || None),
            Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable)
        );
    }

    #[test]
    fn the_mtime_is_only_read_when_the_threshold_needs_it() {
        // The spawn-time recheck stats the whole projects root to answer this
        // closure while holding the runtime lock, so every verdict that does not
        // depend on it must not ask (review P3: lazy threshold).
        let calls = Cell::new(0);
        let mtime = || {
            calls.set(calls.get() + 1);
            Some(AFTER)
        };
        // No claude here at all.
        let quiet = probe(vec![proc(1, Some(P), &["bash"])], &[]);
        assert_eq!(quiet.classify(U, Path::new(J), Path::new(P), &mtime), Verdict::FREE);
        // signal 1, signal 2, signal 3a, failed scan.
        let held = probe(Vec::new(), &[J]);
        held.classify(U, Path::new(J), Path::new(P), &mtime);
        let pinned = probe(vec![proc(9, Some(P), &["claude", "--resume", U])], &[]);
        pinned.classify(U, Path::new(J), Path::new(P), &mtime);
        let blind = probe(vec![opaque(9)], &[]);
        blind.classify(U, Path::new(J), Path::new(P), &mtime);
        let noscan =
            LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        noscan.classify(U, Path::new(J), Path::new(P), &mtime);
        assert_eq!(calls.get(), 0, "mtime was read when it could not change the verdict");

        // …and it *is* read once the threshold applies.
        let here = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        here.classify(U, Path::new(J), Path::new(P), &mtime);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn the_threshold_never_softens_the_other_signals() {
        // Only signal 3b consults the clock. Everything that establishes liveness
        // without knowing *which* transcript is held must block regardless of how
        // old the transcript is.
        let ancient = BEFORE;
        // signal 1 — an fd holder.
        let p = probe(Vec::new(), &[J]);
        assert_eq!(verdict(&p, P, ancient).live, Liveness::Live);
        // signal 2 — pinned on a command line.
        let p = probe(vec![proc(9, Some(P), &["claude", "--resume", U])], &[]);
        assert_eq!(verdict(&p, P, ancient).live, Liveness::Live);
        // signal 3a — an un-pinned claude we could not locate.
        let p = probe(vec![proc(9, None, &["claude"])], &[]);
        assert_eq!(
            verdict(&p, P, ancient),
            Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable)
        );
        // signal 3a — an opaque process.
        let p = probe(vec![opaque(9)], &[]);
        assert_eq!(
            verdict(&p, P, ancient),
            Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable)
        );
        // …and a failed scan.
        let p = LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        assert_eq!(
            verdict(&p, P, ancient),
            Verdict::blocked(Liveness::Unknown, BlockReason::Undecidable)
        );
    }

    #[test]
    fn the_two_unknown_reasons_are_distinguishable() {
        // The UI says different things about the *other* rows for each, so the
        // reason has to survive to the caller (review P2 #3).
        let anywhere = probe(vec![opaque(9)], &[]);
        assert_eq!(verdict(&anywhere, P, AFTER).reason, Some(BlockReason::Undecidable));
        let here = probe(vec![proc(9, Some(P), &["claude"])], &[]);
        assert_eq!(verdict(&here, P, AFTER).reason, Some(BlockReason::WrittenSinceStart));
        // Free carries no reason at all.
        assert_eq!(verdict(&here, P, BEFORE).reason, None);
    }

    #[test]
    fn an_unpinned_claude_elsewhere_does_not_block() {
        let p = probe(vec![proc(9, Some("/home/jun/other"), &["claude"])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
    }

    #[test]
    fn a_claude_pinned_to_another_session_does_not_block() {
        // It names a uuid, so it cannot also be on ours — and it sets no
        // threshold for this directory either.
        let p = probe(vec![proc(9, Some(P), &["claude", "--resume", OTHER])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
    }

    #[test]
    fn a_claude_whose_cwd_is_unreadable_blocks_every_row() {
        // Fail-closed (review #3): identified as claude, un-pinned, but we can't
        // say where it is — so it might be here, and here is every project. No
        // threshold can be computed for a process we cannot place.
        let p = probe(vec![proc(9, None, &["claude"])], &[]);
        assert_eq!(verdict(&p, P, BEFORE).live, Liveness::Unknown);
        assert_eq!(verdict(&p, "/somewhere/else", BEFORE).live, Liveness::Unknown);
        // A *pinned* claude with an unreadable cwd is still no threat to others.
        let p = probe(vec![proc(9, None, &["claude", "--resume", OTHER])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
        // …and a non-claude process with an unreadable cwd is irrelevant.
        let p = probe(vec![proc(9, None, &["vim", "notes.md"])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
    }

    #[test]
    fn an_unreadable_command_line_blocks_rather_than_vanishing() {
        // Audit B3: a process we may not inspect used to be dropped from the
        // scan entirely, so it resolved to "nothing is running here".
        let p = probe(vec![opaque(9)], &[]);
        assert_eq!(verdict(&p, P, BEFORE).live, Liveness::Unknown);
        // It is not claimed to be running any particular session, though.
        assert!(opaque(9).session_ids().is_empty());
        assert!(!opaque(9).is_claude());
    }

    #[test]
    fn the_short_resume_flag_pins_too() {
        for argv in [
            ["claude", "-r", U].as_slice(),
            ["claude", "-r=88b05349-b927-42aa-ad5c-57155ed29ec5"].as_slice(),
        ] {
            let p = probe(vec![proc(9, Some(P), argv)], &[]);
            assert_eq!(live_at(&p, P), Liveness::Live, "{argv:?}");
        }
        // `-r` with a non-uuid value (`grep -r pattern`) pins nothing.
        assert!(proc(9, None, &["grep", "-r", "TODO", "."]).session_ids().is_empty());
        // A bundled short flag isn't `-r`.
        assert!(proc(9, None, &["rm", "-rf", U]).session_ids().is_empty());
    }

    #[test]
    fn a_bare_claude_token_in_someone_elses_argv_does_not_block() {
        // `pgrep -af claude` must not look like a running session (argv[0] rule).
        let p = probe(vec![proc(9, Some(P), &["pgrep", "-af", "claude"])], &[]);
        assert_eq!(verdict(&p, P, AFTER), Verdict::FREE);
    }

    #[test]
    fn a_failed_process_scan_is_unknown_never_free() {
        let p = LiveProbe { scan: ProcScan { procs: Vec::new(), ok: false }, holders: HashSet::new() };
        assert_eq!(verdict(&p, P, BEFORE).live, Liveness::Unknown);
        // …but a positive fd hit still wins, since it needs no process table.
        let p = LiveProbe {
            scan: ProcScan { procs: Vec::new(), ok: false },
            holders: [PathBuf::from(J)].into_iter().collect(),
        };
        assert_eq!(verdict(&p, P, BEFORE).live, Liveness::Live);
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
        let verdict = probe.classify(U, Path::new(J), Path::new(P), || Some(BEFORE));
        let other =
            probe.classify(OTHER, Path::new("/nope.jsonl"), Path::new(P), || Some(BEFORE));
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(verdict.live, Liveness::Live, "a real pinned process must read as Live");
        // It pins one session, so it must not blanket-block a different one.
        assert_eq!(other, Verdict::FREE);
    }

    /// Signal 3b end-to-end against a **real** process: the threshold is only
    /// sound if `/proc/<pid>/cwd` and `/proc/<pid>/stat` really resolve to the
    /// directory and the instant we compare against, which no mocked `ProcInfo`
    /// can show.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_unpinned_claude_blocks_by_its_real_start_time() {
        let dir = std::env::temp_dir().join(format!("mt-live-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let mut child = spawn_stand_in_claude(&dir, None);
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
        // Its start time must have been read from the real /proc, not guessed.
        let started = probe
            .scan
            .procs
            .iter()
            .find(|x| x.pid == child.id())
            .and_then(|x| x.started)
            .expect("a real un-pinned claude must carry a start time");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(
            started <= now && now - started < 120,
            "start time {started} is not plausible against now {now}"
        );

        // A uuid of this test's own, so the sibling signal-2 test's stand-in
        // process (which pins `U`) can't decide this verdict when the suite runs
        // its tests in parallel.
        const MINE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
        let jsonl = Path::new("/home/jun/.claude/projects/-p/7c9e6679-7425-40de-944b-e07fc1f90ae7.jsonl");
        let since = probe.classify(MINE, jsonl, &dir, || Some(now));
        let older = probe.classify(MINE, jsonl, &dir, || Some(now - 3600));
        let elsewhere = probe.classify(MINE, jsonl, Path::new(P), || Some(now));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            since,
            Verdict::blocked(Liveness::Unknown, BlockReason::WrittenSinceStart),
            "a transcript written since it started must block"
        );
        assert_eq!(older, Verdict::FREE, "an hour-old transcript of that cwd stays adoptable");
        assert_eq!(elsewhere, Verdict::FREE, "another directory is untouched");
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

    /// The start-time reader against this very process: the `/proc/<pid>/stat`
    /// field offset is the kind of thing that is either exactly right or wildly
    /// wrong, and only a real read shows which.
    #[cfg(target_os = "linux")]
    #[test]
    fn start_instant_reads_this_process_plausibly() {
        let boot = boot_instant(Path::new("/proc")).expect("/proc/uptime must be readable");
        let me = start_instant(&Path::new("/proc").join(std::process::id().to_string()), Some(boot))
            .expect("our own stat must parse");
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(boot <= me && me <= now, "boot {boot} <= start {me} <= now {now}");
        assert!(now - me < 3600, "this test process did not start an hour ago");
        // No boot instant → no start time (a fake proc root in tests).
        assert_eq!(start_instant(Path::new("/proc/1"), None), None);
        assert_eq!(boot_instant(Path::new("/definitely/not/proc")), None);
    }
}
