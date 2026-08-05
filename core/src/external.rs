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

use crate::live::{LiveProbe, Liveness};
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

/// List `project`'s transcripts that this app has no snapshot for, newest first.
///
/// `proc_root` is `/proc` in production and is injectable for tests. `self_pid`
/// is excluded from the liveness scan so the app's own file handles and command
/// line never make a session look busy.
pub fn list_external(
    projects_root: &Path,
    snapshot_base: &Path,
    project: &str,
    proc_root: &Path,
    self_pid: u32,
) -> Vec<ExternalSession> {
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
            s.live = probe.classify(&s.uuid, &jsonl, &cwd);
            s
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.uuid.cmp(&b.uuid)));
    out
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
        let list = list_external(&projects, &snaps, &project_s, &missing_proc, 0);
        assert_eq!(list.iter().map(|s| s.uuid.as_str()).collect::<Vec<_>>(), vec![theirs]);
        assert_eq!(list[0].cwd, project_s);
        assert_eq!(list[0].title, "터미널에서 연 세션");

        // Adopt: the poll thread writes a snapshot → the row disappears. No flag,
        // no state file — just the difference.
        save(&snaps, &project_s, &snap(theirs)).unwrap();
        assert!(list_external(&projects, &snaps, &project_s, &missing_proc, 0).is_empty());
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

        let list = list_external(&projects, &snaps, &mine.to_string_lossy(), &base.join("no-proc"), 0);
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
        assert!(list_external(&projects, &snaps, &p, &base.join("no-proc"), 0).is_empty());
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

        let blind = list_external(&projects, &snaps, &p, &base.join("no-proc"), 0);
        assert_eq!(blind[0].live, Liveness::Unknown);
        // With a real /proc and nothing running on it, the same row is adoptable.
        #[cfg(target_os = "linux")]
        {
            let seeing = list_external(&projects, &snaps, &p, Path::new("/proc"), 0);
            assert_eq!(seeing[0].live, Liveness::Free);
        }
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
