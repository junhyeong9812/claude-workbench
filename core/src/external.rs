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

use crate::live::{CwdRank, LiveProbe, Liveness};
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
            },
            t.path,
        ));
    }
    found
}

/// The newest mtime among `rows` — the rank boundary. Ties share the crown, so
/// same-second transcripts all count as [`CwdRank::Newest`] and all block; that
/// is the direction of error this whole module errs in.
fn newest_mtime(rows: &[(ExternalSession, PathBuf)]) -> Option<u64> {
    rows.iter().map(|(s, _)| s.modified).max()
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
/// transcript is still a file an un-pinned `claude` could be writing, so it must
/// keep taking part in the mtime ranking (see [`crate::live`]). Dropping hidden
/// rows earlier would hand their `Newest` slot to a visible row and report a
/// blocked session as adoptable.
pub fn list_external(
    projects_root: &Path,
    snapshot_base: &Path,
    project: &str,
    proc_root: &Path,
    self_pid: u32,
) -> ExternalListing {
    let found = candidates(projects_root, snapshot_base, project);
    let newest = newest_mtime(&found);

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
            let rank = if Some(s.modified) == newest { CwdRank::Newest } else { CwdRank::Older };
            s.live = probe.classify(&s.uuid, &jsonl, &cwd, rank);
            s
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.uuid.cmp(&b.uuid)));

    let dismissed: HashSet<String> = crate::hidden::load(snapshot_base, project).into_iter().collect();
    let (hidden, sessions): (Vec<_>, Vec<_>) =
        out.into_iter().partition(|s| dismissed.contains(&s.uuid));
    ExternalListing { hidden_count: hidden.len(), sessions, hidden }
}

/// Where `uuid` ranks by mtime among `project`'s adoptable candidates — the
/// argument [`LiveProbe::classify`] needs, recomputed for the single session the
/// spawn-time recheck is about.
///
/// **Fail-closed**: anything we cannot establish — the scan failing, the uuid no
/// longer being a candidate at all — is [`CwdRank::Newest`], the value that
/// blocks. `Older` is returned only on positive evidence, i.e. some *other*
/// candidate of the same project is strictly newer.
pub fn rank_of(projects_root: &Path, snapshot_base: &Path, project: &str, uuid: &str) -> CwdRank {
    let rows = candidates(projects_root, snapshot_base, project);
    let Some((mine, _)) = rows.iter().find(|(s, _)| s.uuid == uuid) else {
        return CwdRank::Newest;
    };
    if rows.iter().any(|(s, _)| s.uuid != uuid && s.modified > mine.modified) {
        CwdRank::Older
    } else {
        CwdRank::Newest
    }
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

    /// Force a transcript's mtime so the rank is a fact of the test, not of how
    /// fast the filesystem clock ticked between two writes.
    fn set_mtime(root: &Path, slug: &str, uuid: &str, secs_ago: u64) {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(root.join(slug).join(format!("{uuid}.jsonl")))
            .unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn only_the_newest_candidate_of_a_directory_ranks_newest() {
        let base = temp("rank");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        let (new, mid, old) = (
            "aaaaaaaa-1111-2222-3333-444444444444",
            "bbbbbbbb-1111-2222-3333-444444444444",
            "cccccccc-1111-2222-3333-444444444444",
        );
        for (u, ago) in [(new, 10u64), (mid, 100), (old, 1000)] {
            transcript(&projects, "-p", u, &p, "hi");
            set_mtime(&projects, "-p", u, ago);
        }
        assert_eq!(rank_of(&projects, &snaps, &p, new), CwdRank::Newest);
        assert_eq!(rank_of(&projects, &snaps, &p, mid), CwdRank::Older);
        assert_eq!(rank_of(&projects, &snaps, &p, old), CwdRank::Older);

        // A session this app owns is not a candidate, so it neither ranks nor
        // pushes the others down: adopting the newest *external* row is still
        // the thing an un-pinned claude here would be blocking.
        save(&snaps, &p, &snap(new)).unwrap();
        assert_eq!(rank_of(&projects, &snaps, &p, mid), CwdRank::Newest);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unrankable_uuid_fails_closed_to_newest() {
        let base = temp("rank-fail");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let p = project.to_string_lossy().to_string();
        let known = "aaaaaaaa-1111-2222-3333-444444444444";
        transcript(&projects, "-p", known, &p, "hi");
        set_mtime(&projects, "-p", known, 10);
        // A uuid that isn't a candidate at all (deleted transcript, other
        // project, snapshot already written) must not read as "safely older".
        assert_eq!(
            rank_of(&projects, &snaps, &p, "dddddddd-1111-2222-3333-444444444444"),
            CwdRank::Newest
        );
        // Same-second transcripts share the crown — both block.
        let twin = "eeeeeeee-1111-2222-3333-444444444444";
        transcript(&projects, "-p", twin, &p, "hi");
        set_mtime(&projects, "-p", twin, 10);
        assert_eq!(rank_of(&projects, &snaps, &p, known), CwdRank::Newest);
        assert_eq!(rank_of(&projects, &snaps, &p, twin), CwdRank::Newest);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hidden_sessions_move_to_their_own_bucket_and_keep_ranking() {
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
        // 무특정 claude가 쓰고 있을 수 있으므로 mtime 순위를 계속 차지한다.
        assert_eq!(rank_of(&projects, &snaps, &p, new), CwdRank::Newest);
        assert_eq!(rank_of(&projects, &snaps, &p, old), CwdRank::Older);

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

    /// End-to-end for the #69 review item 6 fix: a real un-pinned `claude`
    /// running in the project directory used to make **every** row of that
    /// project unadoptable. Now it costs exactly the newest row.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_unpinned_claude_costs_only_the_newest_row() {
        let base = temp("live-narrow");
        let projects = base.join("projects-root");
        let snaps = base.join("app-data");
        let project = base.join("p");
        std::fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let p = project.to_string_lossy().to_string();
        let (new, old) = (
            "aaaaaaaa-1111-2222-3333-444444444444",
            "bbbbbbbb-1111-2222-3333-444444444444",
        );
        for (u, ago) in [(new, 10u64), (old, 1000)] {
            transcript(&projects, "-p", u, &p, "hi");
            set_mtime(&projects, "-p", u, ago);
        }
        // Nothing running yet: both adoptable.
        let before = list_external(&projects, &snaps, &p, Path::new("/proc"), 0).sessions;
        assert!(before.iter().all(|s| s.live == Liveness::Free), "{before:?}");

        // An un-pinned `claude` sitting in the project directory (live.rs's own
        // stand-in, so both tests exercise the same process shape).
        let mut child = crate::live::spawn_unpinned_claude(&project);
        let mut list = Vec::new();
        for _ in 0..100 {
            list = list_external(&projects, &snaps, &p, Path::new("/proc"), std::process::id()).sessions;
            if list.iter().any(|s| s.live == Liveness::Unknown) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();

        let by = |u: &str| list.iter().find(|s| s.uuid == u).unwrap().live;
        assert_eq!(by(new), Liveness::Unknown, "the newest row absorbs the block");
        assert_eq!(by(old), Liveness::Free, "older rows stay adoptable (#69 item 6)");
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
