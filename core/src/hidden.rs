//! Per-project **hidden external sessions** — the uuids the user deleted, kept
//! out of the picker's external list.
//!
//! ```text
//! <base>/projects/<project_key>/hidden-sessions.txt   (one uuid per line)
//! ```
//!
//! ## Why this file exists
//!
//! External sessions are a *difference*: transcripts minus snapshots
//! ([`crate::external`]). Deleting a session deletes the snapshot — and that is
//! exactly what puts the session back into the difference, so the row the user
//! just deleted reappears one refresh later as "터미널에서 연 세션". The
//! difference is right; what it lacks is any memory of an intent. This file is
//! that memory, and nothing else: a list of uuids the picker does not offer.
//!
//! ## What it is deliberately *not*
//!
//! It never touches transcripts, snapshots or archives. Hiding is a display
//! decision, so the file is authoritative for nothing: if it is corrupt,
//! unreadable, or gone, [`load`] returns an empty list and every session simply
//! becomes visible again. **Fail-open is the safe direction here** — the failure
//! shows the user rows they had dismissed (annoying, reversible), where
//! fail-closed would hide sessions the user never dismissed and leave no way to
//! find out why (the transcripts are fine, but nothing in the UI would say so).
//! That is the opposite of [`crate::live`], where a wrong answer destroys a
//! transcript and every unknown therefore blocks.
//!
//! Adopting a hidden session un-hides it ([`unhide`]): the user reopened it, so
//! the dismissal is spent.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::history::project_key;

/// How many uuids a project's list keeps. A hidden entry costs ~37 bytes and is
/// only ever consulted for membership, so the cap is about bounding a file that
/// nothing prunes: past it, the **oldest** dismissals are dropped (the sessions
/// they hid are the least likely to still have a transcript on disk).
pub const HIDDEN_CAP: usize = 1000;

/// Process-unique temp suffix, so two windows deleting sessions at once cannot
/// race on a shared temp path.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn dir(base: &Path, project: &str) -> PathBuf {
    base.join("projects").join(project_key(project))
}

/// Absolute path of a project's hidden list. `project_key` sanitizes and hashes
/// the project path, so a hostile `project` string cannot escape `base`.
pub fn path(base: &Path, project: &str) -> PathBuf {
    dir(base, project).join("hidden-sessions.txt")
}

/// The uuids hidden for `project`, oldest dismissal first.
///
/// Never fails: an absent, unreadable or corrupt file is an empty list (module
/// docs — display layer, fail-open). Individual junk lines are skipped rather
/// than poisoning the whole list, and duplicates collapse.
pub fn load(base: &Path, project: &str) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path(base, project)) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let uuid = line.trim();
        if uuid.is_empty() || !crate::snapshot::is_safe_uuid(uuid) {
            continue;
        }
        if !out.iter().any(|u| u == uuid) {
            out.push(uuid.to_string());
        }
    }
    out
}

/// Hide `uuid` for `project` (idempotent).
///
/// A list we could not read is rebuilt from this one entry rather than blocking
/// the delete it accompanies — see the module docs on fail-open. The write
/// itself is atomic (temp + rename), so a crash mid-write cannot leave a
/// half-line that would later parse as a different uuid.
pub fn hide(base: &Path, project: &str, uuid: &str) -> io::Result<()> {
    if !crate::snapshot::is_safe_uuid(uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let mut list = load(base, project);
    if list.iter().any(|u| u == uuid) {
        return Ok(());
    }
    list.push(uuid.to_string());
    if list.len() > HIDDEN_CAP {
        list.drain(..list.len() - HIDDEN_CAP);
    }
    write(base, project, &list)
}

/// Un-hide `uuid` (adopting a hidden session spends the dismissal). Absent
/// entries and absent files are success — this is a "make sure it is not there"
/// call, not a delete.
pub fn unhide(base: &Path, project: &str, uuid: &str) -> io::Result<()> {
    let list = load(base, project);
    if !list.iter().any(|u| u == uuid) {
        return Ok(());
    }
    let kept: Vec<String> = list.into_iter().filter(|u| u != uuid).collect();
    write(base, project, &kept)
}

/// Replace the list atomically. An empty list writes an empty file rather than
/// removing it — "no hidden sessions" and "never hid anything" are the same
/// state to [`load`], and one code path is one behaviour to reason about.
fn write(base: &Path, project: &str, list: &[String]) -> io::Result<()> {
    let d = dir(base, project);
    std::fs::create_dir_all(&d)?;
    let file = d.join("hidden-sessions.txt");
    let tmp = d.join(format!(
        "hidden-sessions.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut body = list.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    let r = std::fs::write(&tmp, body.as_bytes()).and_then(|()| std::fs::rename(&tmp, &file));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    static N: AtomicU64 = AtomicU64::new(0);
    fn temp_base(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("mt_hidden_{tag}_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const A: &str = "aaaaaaaa-1111-2222-3333-444444444444";
    const B: &str = "bbbbbbbb-1111-2222-3333-444444444444";

    #[test]
    fn hide_then_unhide_round_trips() {
        let b = temp_base("rt");
        assert!(load(&b, "/p").is_empty(), "아무것도 숨기지 않았으면 빈 목록");
        hide(&b, "/p", A).unwrap();
        hide(&b, "/p", B).unwrap();
        assert_eq!(load(&b, "/p"), vec![A.to_string(), B.to_string()]);
        // 재adopt = 숨김 자동 해제. 나머지는 그대로다.
        unhide(&b, "/p", A).unwrap();
        assert_eq!(load(&b, "/p"), vec![B.to_string()]);
        // 없는 것을 지우는 것도 성공(멱등), 두 번 숨기는 것도 중복되지 않는다.
        unhide(&b, "/p", A).unwrap();
        hide(&b, "/p", B).unwrap();
        assert_eq!(load(&b, "/p"), vec![B.to_string()]);
        // 마지막 하나를 풀면 빈 목록으로 남는다(파일은 남아도 의미는 동일).
        unhide(&b, "/p", B).unwrap();
        assert!(load(&b, "/p").is_empty());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn projects_are_isolated() {
        let b = temp_base("iso");
        hide(&b, "/a/proj", A).unwrap();
        assert_eq!(load(&b, "/a/proj"), vec![A.to_string()]);
        assert!(load(&b, "/b/proj").is_empty(), "다른 프로젝트의 숨김은 새지 않는다");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn a_corrupt_list_reads_as_empty_not_as_an_error() {
        // 표시 계층 fail-open: 목록이 깨지면 "전부 보이기"로 되돌아간다(모듈 주석).
        let b = temp_base("corrupt");
        let d = dir(&b, "/p");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("hidden-sessions.txt"), b"\x00\x01rubbish\n../../etc/passwd\n").unwrap();
        assert!(load(&b, "/p").is_empty(), "쓰레기 줄은 uuid가 아니므로 전부 버린다");

        // 읽기 자체가 실패해도(디렉토리로 만들어 강제) 오류가 아니라 빈 목록이다.
        let b2 = temp_base("corrupt2");
        std::fs::create_dir_all(dir(&b2, "/p").join("hidden-sessions.txt")).unwrap();
        assert!(load(&b2, "/p").is_empty());

        // 성한 줄이 섞여 있으면 그것만 살린다. (파일명으로 쓸 수 없는 값만
        // 버린다 — uuid 모양이 아닐 뿐인 문자열은 어떤 전사와도 매칭되지 않아
        // 무해하므로 굳이 형태 검사를 더 걸지 않는다.)
        std::fs::write(d.join("hidden-sessions.txt"), format!("{A}\nrub bish\n\n{B}\n{A}\n")).unwrap();
        assert_eq!(load(&b, "/p"), vec![A.to_string(), B.to_string()], "중복은 접히고 순서는 유지");
        let _ = std::fs::remove_dir_all(&b);
        let _ = std::fs::remove_dir_all(&b2);
    }

    #[test]
    fn an_unsafe_uuid_is_never_written() {
        // 줄 단위 파일이라 개행이 섞인 값 하나가 목록 전체를 오염시킨다.
        let b = temp_base("unsafe");
        for bad in ["", "aaaa\nbbbb", "../escape", "a b"] {
            assert_eq!(
                hide(&b, "/p", bad).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{bad:?}"
            );
        }
        assert!(load(&b, "/p").is_empty());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn the_list_is_capped_dropping_the_oldest() {
        let b = temp_base("cap");
        for i in 0..HIDDEN_CAP + 5 {
            hide(&b, "/p", &format!("{i:08x}-1111-2222-3333-444444444444")).unwrap();
        }
        let list = load(&b, "/p");
        assert_eq!(list.len(), HIDDEN_CAP);
        assert_eq!(list[0], format!("{:08x}-1111-2222-3333-444444444444", 5), "가장 오래된 5건이 밀려났다");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn traversal_in_project_is_neutralized() {
        let b = temp_base("trav");
        hide(&b, "../../etc/passwd", A).unwrap();
        let p = path(&b, "../../etc/passwd");
        assert!(p.starts_with(&b), "{p:?} escaped {b:?}");
        assert_eq!(load(&b, "../../etc/passwd"), vec![A.to_string()]);
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn no_temp_files_are_left_behind() {
        let b = temp_base("tmp");
        hide(&b, "/p", A).unwrap();
        unhide(&b, "/p", A).unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(dir(&b, "/p"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = std::fs::remove_dir_all(&b);
    }
}
