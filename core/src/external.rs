//! **External sessions** — Claude sessions the user started in a terminal, which
//! the app can adopt.
//!
//! The whole feature rests on one difference:
//!
//! ```text
//! external(project) = { transcripts whose cwd is <project> } − { snapshots we own }
//! ```
//!
//! The app writes a snapshot for every session it drives (`crate::snapshot`), so
//! a transcript with no snapshot was never ours. Adopting one spawns
//! `claude --resume` on it, which makes the poll thread write a snapshot — and
//! the session leaves this list on its own. There is deliberately **no adopted
//! flag** anywhere: the difference is self-maintaining, and a flag would be a
//! second source of truth that could disagree with the snapshots.
//!
//! ## The cwd is not cosmetic
//!
//! Measured against the CLI (2.1.221, 2026-08-05): `claude --resume <uuid>` run
//! from any directory other than the one the session was created in fails with
//! `No conversation found with session ID`. The resume lookup is scoped to the
//! caller's own project slug. So [`ExternalSession::cwd`] is not a hint for the
//! UI — it is the directory the adopting PTY **must** be spawned in.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::live::{BlockReason, LiveProbe, Liveness};
use crate::scan::{scan_transcripts, ScanOpts};

/// Longest title we hand to the picker (characters).
const TITLE_CHARS: usize = 60;

/// A session that exists on disk but not in this app.
#[derive(Debug, Clone, Serialize)]
pub struct ExternalSession {
    /// Session uuid = the `--resume` argument.
    pub uuid: String,
    /// The CLI's own title if it generated one, else the first user prompt cut
    /// to [`TITLE_CHARS`]. Empty when the transcript has neither.
    pub title: String,
    /// The directory the session was started in — where the adopting PTY must
    /// run (see the module docs).
    pub cwd: String,
    /// Transcript mtime, unix seconds. The file's own clock is used rather than
    /// the last record's timestamp so listing never has to read whole files.
    pub modified: u64,
    /// Whether something else still holds this session.
    pub live: Liveness,
    /// Why it is blocked — `None` when `live == Free`. The UI needs it to say
    /// anything true about the *other* rows (see [`BlockReason`]).
    pub reason: Option<BlockReason>,
}

/// True when `a` and `b` name the same directory, resolving symlinks and `..`
/// when possible and falling back to a plain string compare when they don't
/// exist (a session whose project has since been deleted or moved).
pub fn same_dir(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// `project`'s transcripts that this app has no snapshot for — the adoptable
/// candidates, before any liveness verdict. Paired with each transcript's path.
///
/// Split out of [`list_external`] because the spawn-time recheck needs the very
/// same set to rank against: "which of this directory's candidates is newest"
/// has to mean the same thing in the picker and at the spawn, or the two would
/// disagree about which row signal 3b blocks.
fn candidates(
    projects_root: &Path,
    snapshot_base: &Path,
    project: &str,
) -> Vec<(ExternalSession, PathBuf)> {
    let known = crate::snapshot::known_uuids(snapshot_base, project);
    // `-tmp-` slugs are scratch sessions (including our own extraction runs);
    // a real project is never under /tmp, so skipping them only saves work.
    let Ok(transcripts) = scan_transcripts(projects_root, &ScanOpts {
        skip_tmp_slugs: true,
        modified_since: None,
    }) else {
        return Vec::new();
    };

    // Two-phase probing, because the projects root holds every project's
    // transcripts (~1.5 GB here) and only a handful belong to this one:
    //   A) `probe_cwd` — stops at the first record with a cwd, so the ~340
    //      rejects cost a few hundred bytes each;
    //   B) the fuller head probe (title, extraction marker) only for the matches.
    // Doing (B) for everything measured 5.2 s per listing; this is ~50 ms.
    let mut found: Vec<(ExternalSession, PathBuf)> = Vec::new();
    for t in transcripts {
        if known.contains(&t.uuid) || !crate::snapshot::is_safe_uuid(&t.uuid) {
            continue;
        }
        let Ok(Some(cwd)) = crate::scan::probe_cwd(&t.path) else { continue };
        if !same_dir(&cwd, project) {
            continue;
        }
        let Ok(probe) =
            crate::scan::probe_head(&t.path, crate::scan::HEAD_RECORDS, crate::scan::HEAD_BYTES)
        else {
            continue;
        };
        // Our own extraction by-products are not user sessions.
        if probe.is_extraction {
            continue;
        }
        let modified = t
            .mtime
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        found.push((
            ExternalSession {
                uuid: t.uuid,
                title: probe.title(TITLE_CHARS).unwrap_or_default(),
                cwd,
                modified,
                live: Liveness::Unknown, // filled in below
                reason: Some(BlockReason::Undecidable),
            },
            t.path,
        ));
    }
    found
}

/// What the picker's external section shows, split by the user's own dismissals
/// ([`crate::hidden`]).
///
/// `hidden` is carried in the same response rather than fetched on demand: the
/// toggle that reveals it must show a **count** before it is expanded, and a
/// count the user can't act on is worse than the rows themselves. `hidden_count`
/// is `hidden.len()` — the hidden sessions that still exist as transcripts here,
/// not the size of the dismissal list (entries whose transcript is gone are
/// nothing the UI can offer).
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExternalListing {
    /// Adoptable rows, newest first.
    pub sessions: Vec<ExternalSession>,
    /// Rows the user deleted and has not adopted since, newest first.
    pub hidden: Vec<ExternalSession>,
    pub hidden_count: usize,
}

/// List `project`'s transcripts that this app has no snapshot for, newest first,
/// split into visible and hidden.
///
/// `proc_root` is `/proc` in production and is injectable for tests. `self_pid`
/// is excluded from the liveness scan so the app's own file handles and command
/// line never make a session look busy.
///
/// Hiding happens **after** the liveness verdict, not before: a hidden
/// transcript is still a file an un-pinned `claude` could be writing, and every
/// row is judged against the same threshold whether or not it is shown.
pub fn list_external(
    projects_root: &Path,
    snapshot_base: &Path,
    project: &str,
    proc_root: &Path,
    self_pid: u32,
) -> ExternalListing {
    let found = candidates(projects_root, snapshot_base, project);

    // One /proc pass for the whole list rather than one per session.
    let targets: HashSet<PathBuf> = found
        .iter()
        .map(|(_, p)| p.canonicalize().unwrap_or_else(|_| p.clone()))
        .collect();
    let probe = LiveProbe::gather(proc_root, &targets, self_pid);
    let mut out: Vec<ExternalSession> = found
        .into_iter()
        .map(|(mut s, path)| {
            let jsonl = path.canonicalize().unwrap_or(path);
            let cwd = std::fs::canonicalize(&s.cwd).unwrap_or_else(|_| PathBuf::from(&s.cwd));
            // The mtime is already in hand here — the closure exists for the
            // recheck path, which has to go and find it.
            let verdict = probe.classify(&s.uuid, &jsonl, &cwd, || Some(s.modified));
            s.live = verdict.live;
            s.reason = verdict.reason;
            s
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.uuid.cmp(&b.uuid)));

    let dismissed: HashSet<String> = crate::hidden::load(snapshot_base, project).into_iter().collect();
    let (hidden, sessions): (Vec<_>, Vec<_>) =
        out.into_iter().partition(|s| dismissed.contains(&s.uuid));
    ExternalListing { hidden_count: hidden.len(), sessions, hidden }
}

/// When `uuid`'s transcript was last written, unix seconds — the input
/// [`LiveProbe::classify`] compares against signal 3b's threshold, recomputed for
/// the single session the spawn-time recheck is about.
///
/// It is deliberately *not* a plain `stat` of the file: the answer must come from
/// the same candidate set the picker was looking at, so that "this is still an
/// adoptable external session of this project" is re-established at the same
/// moment as its mtime. `None` — the uuid is no longer a candidate (a snapshot
/// appeared, the transcript moved, the project no longer matches) — is a refusal,
/// never a pass; `classify` turns it into a block and the caller into an error.
pub fn candidate_mtime(
    projects_root: &Path,
    snapshot_base: &Path,
    project: &str,
    uuid: &str,
) -> Option<u64> {
    candidates(projects_root, snapshot_base, project)
        .into_iter()
        .find(|(s, _)| s.uuid == uuid)
        .map(|(s, _)| s.modified)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::{save, SessionSnapshot};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-external-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn transcript(root: &Path, slug: &str, uuid: &str, cwd: &str, prompt: &str) {
        let dir = root.join(slug);
        std::fs::create_dir_all(&dir).unwrap();
        let body = format!(
            "{}\n",
            format_args!(
                r#"{{"type":"user","cwd":"{cwd}","timestamp":"2026-08-01T09:00:00Z","message":{{"role":"user","content":"{prompt}"}}}}"#
            )
        );
        std::fs::write(dir.join(format!("{uuid}.jsonl")), body).unwrap();
    }

    fn snap(uuid: &str) -> SessionSnapshot {
        SessionSnapshot {
            uuid: uuid.to_string(),
            name: "Claude 1".into(),
            date: "2026-08-01".into(),
            items: Vec::new(),
            turns: Vec::new(),
            answers: Vec::new(),
            dates: Vec::new(),
            tokens: Vec::new(),
            model: None,
            last_usage: None,
            prev_uuid: None,
            summary_path: None,
            title: None,
            summary: None,
        }
    }

    /// The difference式 itself, plus the transition the design leans on: once a
    /// snapshot exists the session must leave the list with no other bookkeeping.
    #[test]
    fn external_is_transcripts_minus_snapshots_and_adopting_removes_a_row() {
        let base = temp("diff");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("myproj");
        std::fs::create_dir_all(&project).unwrap();
        let project_s = project.to_string_lossy().to_string();

        let mine = "aaaaaaaa-1111-2222-3333-444444444444";
        let theirs = "bbbbbbbb-1111-2222-3333-444444444444";
        transcript(&projects, "-myproj", mine, &project_s, "앱이 연 세션");
        transcript(&projects, "-myproj", theirs, &project_s, "터미널에서 연 세션");
        // The app owns `mine`.
        save(&snaps, &project_s, &snap(mine)).unwrap();

        // No /proc → every verdict is Unknown, but membership is what's asserted.
        let missing_proc = base.join("no-proc");
        let list = list_external(&projects, &snaps, &project_s, &missing_proc, 0).sessions;
        assert_eq!(list.iter().map(|s| s.uuid.as_str()).collect::<Vec<_>>(), vec![theirs]);
        assert_eq!(list[0].cwd, project_s);
        assert_eq!(list[0].title, "터미널에서 연 세션");

        // Adopt: the poll thread writes a snapshot → the row disappears. No flag,
        // no state file — just the difference.
        save(&snaps, &project_s, &snap(theirs)).unwrap();
        assert!(list_external(&projects, &snaps, &project_s, &missing_proc, 0).sessions.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_transcripts_of_this_project_are_listed() {
        let base = temp("scope");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let mine = base.join("mine");
        let other = base.join("other");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        transcript(&projects, "-mine", "aaaaaaaa-1111-2222-3333-444444444444", &mine.to_string_lossy(), "here");
        transcript(&projects, "-other", "bbbbbbbb-1111-2222-3333-444444444444", &other.to_string_lossy(), "there");
        // A scratch slug is skipped outright.
        transcript(&projects, "-tmp-scratch", "cccccccc-1111-2222-3333-444444444444", &mine.to_string_lossy(), "scratch");

        let list =
            list_external(&projects, &snaps, &mine.to_string_lossy(), &base.join("no-proc"), 0).sessions;
        assert_eq!(
            list.iter().map(|s| s.uuid.as_str()).collect::<Vec<_>>(),
            vec!["aaaaaaaa-1111-2222-3333-444444444444"]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn our_own_extraction_transcripts_are_not_offered() {
        let base = temp("extract");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        transcript(
            &projects,
            "-p",
            "aaaaaaaa-1111-2222-3333-444444444444",
            &p,
            crate::knowledge::EXTRACTION_MARKER,
        );
        assert!(list_external(&projects, &snaps, &p, &base.join("no-proc"), 0).sessions.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_process_table_blocks_rather_than_frees() {
        let base = temp("liveness");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        transcript(&projects, "-p", "aaaaaaaa-1111-2222-3333-444444444444", &p, "hi");

        let blind = list_external(&projects, &snaps, &p, &base.join("no-proc"), 0).sessions;
        assert_eq!(blind[0].live, Liveness::Unknown);
        // With a real /proc and nothing running on it, the same row is adoptable.
        #[cfg(target_os = "linux")]
        {
            let seeing = list_external(&projects, &snaps, &p, Path::new("/proc"), 0).sessions;
            assert_eq!(seeing[0].live, Liveness::Free);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Force a transcript's mtime so its position relative to a process's start
    /// time is a fact of the test, not of how fast the clock ticked between two
    /// writes.
    fn set_mtime(root: &Path, slug: &str, uuid: &str, secs_ago: u64) {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(root.join(slug).join(format!("{uuid}.jsonl")))
            .unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn candidate_mtime_answers_for_candidates_and_refuses_otherwise() {
        // What the spawn-time recheck feeds the classifier. "Not a candidate" has
        // to be `None` — a refusal — rather than any value that could pass.
        let base = temp("mtime");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        let (mine, other_project) = (
            "aaaaaaaa-1111-2222-3333-444444444444",
            "bbbbbbbb-1111-2222-3333-444444444444",
        );
        transcript(&projects, "-p", mine, &p, "hi");
        set_mtime(&projects, "-p", mine, 100);
        transcript(&projects, "-other", other_project, "/somewhere/else", "hi");

        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let got = candidate_mtime(&projects, &snaps, &p, mine).expect("a candidate has an mtime");
        assert!(now - got >= 99 && now - got <= 102, "mtime {got} ≉ now−100 ({now})");

        // Never a candidate of this project.
        assert_eq!(candidate_mtime(&projects, &snaps, &p, other_project), None);
        assert_eq!(candidate_mtime(&projects, &snaps, &p, "dddddddd-1111-2222-3333-444444444444"), None);
        // …and a session this app already owns has left the candidate set, which
        // is exactly the state that must refuse rather than resolve.
        save(&snaps, &p, &snap(mine)).unwrap();
        assert_eq!(candidate_mtime(&projects, &snaps, &p, mine), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hidden_sessions_move_to_their_own_bucket_and_stay_candidates() {
        let base = temp("hidden");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        let (new, old) = (
            "aaaaaaaa-1111-2222-3333-444444444444",
            "bbbbbbbb-1111-2222-3333-444444444444",
        );
        for (u, ago) in [(new, 10u64), (old, 1000)] {
            transcript(&projects, "-p", u, &p, "hi");
            set_mtime(&projects, "-p", u, ago);
        }
        let blind = base.join("no-proc");
        let uuids = |v: &[ExternalSession]| v.iter().map(|s| s.uuid.clone()).collect::<Vec<_>>();

        // 삭제 = 숨김. 그 행은 목록에서 빠지고 숨김 버킷으로 간다.
        crate::hidden::hide(&snaps, &p, new).unwrap();
        let l = list_external(&projects, &snaps, &p, &blind, 0);
        assert_eq!(uuids(&l.sessions), vec![old.to_string()]);
        assert_eq!(uuids(&l.hidden), vec![new.to_string()]);
        assert_eq!(l.hidden_count, 1);

        // 숨겨도 후보에서 빠지지는 않는다 — 그 전사는 여전히 디스크에 있고
        // 무특정 claude가 쓰고 있을 수 있으므로 live 판정 입력으로 남는다.
        assert!(candidate_mtime(&projects, &snaps, &p, new).is_some());
        assert!(candidate_mtime(&projects, &snaps, &p, old).is_some());

        // adopt = 숨김 해제. 목록이 원래대로 돌아온다.
        crate::hidden::unhide(&snaps, &p, new).unwrap();
        let l = list_external(&projects, &snaps, &p, &blind, 0);
        assert_eq!(uuids(&l.sessions), vec![new.to_string(), old.to_string()]);
        assert!(l.hidden.is_empty());
        assert_eq!(l.hidden_count, 0);

        // 전사가 사라진 숨김 uuid는 아무 수에도 잡히지 않는다(보여줄 게 없다).
        crate::hidden::hide(&snaps, &p, "cccccccc-1111-2222-3333-444444444444").unwrap();
        assert_eq!(list_external(&projects, &snaps, &p, &blind, 0).hidden_count, 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A project directory with `rows` transcripts, plus real stand-in processes.
    /// Returns the listing taken while they run (the children are killed first).
    #[cfg(target_os = "linux")]
    fn listing_with_processes(
        tag: &str,
        rows: &[(&str, u64)],
        procs: &[Option<&str>],
    ) -> (PathBuf, Vec<ExternalSession>) {
        let base = temp(tag);
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let p = project.to_string_lossy().to_string();

        let mut children: Vec<std::process::Child> =
            procs.iter().map(|pin| crate::live::spawn_stand_in_claude(&project, *pin)).collect();
        // Transcripts are written *after* the processes start, then back-dated —
        // so "ago" is measured against a start time that really precedes them.
        for (uuid, ago) in rows {
            transcript(&projects, "-p", uuid, &p, "hi");
            set_mtime(&projects, "-p", uuid, *ago);
        }
        // Wait until the process table shows what we spawned (cwd link included).
        let mut list = Vec::new();
        for _ in 0..150 {
            list = list_external(&projects, &snaps, &p, Path::new("/proc"), std::process::id())
                .sessions;
            if list.iter().any(|s| s.live != Liveness::Free) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        for c in children.iter_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        (base, list)
    }

    /// MISS2, reproduced with real processes: a **pinned** session and a newer
    /// transcript whose writer has already exited used to steal the "newest" slot
    /// from the transcript an un-pinned `claude` was actually holding, which then
    /// read `Free`. The threshold has no slot to steal.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_pinned_or_dead_writer_no_longer_steals_the_block() {
        // Uuids unique to this test: it puts a **real pinned process** on the
        // machine for the length of the run, and a sibling test reusing the same
        // uuid would read its own row as Live (tests run in parallel).
        let (held, dead_newer, pinned, ancient) = (
            "2aaaaaaa-1111-2222-3333-444444444444",
            "2bbbbbbb-1111-2222-3333-444444444444",
            "2ccccccc-1111-2222-3333-444444444444",
            "2ddddddd-1111-2222-3333-444444444444",
        );
        let (base, list) = listing_with_processes(
            "miss2",
            // `dead_newer` is the newest row — under the old rule it took the
            // block and `held` (2 s older) went Free.
            &[(held, 2), (dead_newer, 0), (pinned, 3600), (ancient, 3600)],
            &[None, Some(pinned)],
        );
        let by = |u: &str| list.iter().find(|s| s.uuid == u).unwrap();
        // The fixture only reproduces MISS2 while `held` is *not* the newest row:
        // that is the exact condition under which the old "block the newest one"
        // rule reported it adoptable.
        assert!(
            by(dead_newer).modified >= by(held).modified,
            "fixture no longer reproduces the miss"
        );
        assert_eq!(
            (by(held).live, by(held).reason),
            (Liveness::Unknown, Some(BlockReason::WrittenSinceStart)),
            "the transcript written since the un-pinned claude started must block"
        );
        assert_eq!(by(dead_newer).live, Liveness::Unknown, "so must every other recent row");
        assert_eq!(
            (by(pinned).live, by(pinned).reason),
            (Liveness::Live, Some(BlockReason::ThisSession)),
            "the pinned session reads Live on its own row"
        );
        assert_eq!(
            by(ancient).live,
            Liveness::Free,
            "an hour-old transcript is provably not what a process started minutes ago is writing"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// MISS1, reproduced with real processes: two un-pinned `claude`s in one
    /// directory could only ever block one row between them, because the rule
    /// blocked a row rather than a time window.
    #[cfg(target_os = "linux")]
    #[test]
    fn two_real_unpinned_claudes_block_every_recent_row() {
        // Uuids unique to this test — see the sibling MISS2 test on why.
        let (a, b, ancient) = (
            "1aaaaaaa-1111-2222-3333-444444444444",
            "1bbbbbbb-1111-2222-3333-444444444444",
            "1ccccccc-1111-2222-3333-444444444444",
        );
        let (base, list) = listing_with_processes(
            "miss1",
            &[(a, 0), (b, 2), (ancient, 3600)],
            &[None, None],
        );
        let row = |u: &str| list.iter().find(|s| s.uuid == u).unwrap();
        let by = |u: &str| row(u).live;
        // Same trap as MISS2: `b` is not the newest row, so the old rule left it
        // adoptable no matter how many un-pinned `claude`s were running.
        assert!(row(a).modified >= row(b).modified, "fixture no longer reproduces the miss");
        assert_eq!(by(a), Liveness::Unknown);
        assert_eq!(by(b), Liveness::Unknown, "the second un-pinned claude's row must block too");
        // The narrowing is still real — this is not a return to blocking the
        // whole project (#69 item 6).
        assert_eq!(by(ancient), Liveness::Free);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The other half of #69 item 6: with nothing running, everything is
    /// adoptable — the threshold only exists while a process does.
    #[cfg(target_os = "linux")]
    #[test]
    fn nothing_running_leaves_every_row_adoptable() {
        let base = temp("quiet");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        for (u, ago) in [("aaaaaaaa-1111-2222-3333-444444444444", 0u64),
                         ("bbbbbbbb-1111-2222-3333-444444444444", 3600)] {
            transcript(&projects, "-p", u, &p, "hi");
            set_mtime(&projects, "-p", u, ago);
        }
        let list = list_external(&projects, &snaps, &p, Path::new("/proc"), 0).sessions;
        assert!(list.iter().all(|s| s.live == Liveness::Free && s.reason.is_none()), "{list:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn same_dir_matches_through_a_symlink() {
        let base = temp("symlink");
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(same_dir(&real.to_string_lossy(), &link.to_string_lossy()));
        assert!(!same_dir(&real.to_string_lossy(), &base.join("nope").to_string_lossy()));
        // Non-existent paths still compare equal when literally identical.
        assert!(same_dir("/gone/x", "/gone/x"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
