//! Per-project **memo** persistence — one long-form scratch document per project.
//!
//! Layout (one file per project, keyed by the same `project_key` the snapshot
//! layer uses so a project's app-data lives under one directory):
//! ```text
//! <base>/projects/<project_key>/memo.md
//! ```
//!
//! This is a thin byte store shaped after [`crate::scrollback_store`]: the
//! policy (when to save — debounce/blur/unmount) lives in the frontend, here we
//! only guarantee that a write is **atomic** (temp + rename) so a crash or a
//! concurrent read can never observe a half-written memo.
//!
//! One deliberate difference from the scrollback store: the cap is **enforced,
//! not silently applied**. Scrollback is a rolling tail, so trimming it is
//! lossless in meaning; a memo is a document the user typed, so quietly dropping
//! its head or tail would be data loss. Over-cap input is rejected and the
//! caller reports it.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::history::project_key;

/// Cap on a persisted memo (1 MiB of UTF-8). Generous for prose, small enough
/// that a load is a single cheap read on every panel mount.
pub const MEMO_CAP: usize = 1024 * 1024;

/// Process-unique suffix counter for temp files, so two writers (two windows
/// editing the same project's memo) never race on a shared temp path.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// The directory holding this project's app data (shared with snapshots).
fn dir(base: &Path, project: &str) -> PathBuf {
    base.join("projects").join(project_key(project))
}

/// Absolute path of a project's memo file. `project_key` sanitizes and hashes
/// the project path, so a hostile `project` string can't traverse out of `base`.
pub fn path(base: &Path, project: &str) -> PathBuf {
    dir(base, project).join("memo.md")
}

/// 메모 본문의 콘텐츠 해시 — 낙관적 잠금의 토큰이자 "디스크가 내가 읽은 그대로
/// 인가"의 판정 값.
///
/// FNV-1a 64bit + 바이트 길이. 적대적 위조를 막는 용도가 아니라 **다른 창이
/// 끼어들어 썼는지**를 알아채는 용도라 암호학적 해시가 필요 없다(길이를 함께
/// 넣어 우연한 충돌 여지를 한 번 더 줄인다). 판정은 항상 [`load`]가 돌려준
/// *문자열*을 기준으로 한다 — 잘못된 UTF-8이 lossy로 치환되므로 원시 바이트로
/// 해시하면 읽기와 쓰기의 기준이 어긋난다.
pub fn content_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in text.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{}-{:016x}", text.len(), hash)
}

/// Load a project's memo.
///
/// - `Ok(None)` — 아직 메모가 없다(첫 열기). 정상 상태다.
/// - `Ok(Some(text))` — 본문.
/// - `Err(e)` — **진짜 I/O 실패**(권한·손상·디렉토리 충돌 등).
///
/// 이 셋을 구분하는 것이 중요하다(리뷰 P2-4): 읽기 실패를 "빈 메모"로 뭉개면
/// 호출부가 빈 문서를 기반으로 저장해 **멀쩡한 파일을 빈 값으로 덮는다**. 부재만
/// 빈 메모다.
///
/// Reads at most [`MEMO_CAP`] bytes from the **head** (a memo is a document, so
/// the head is the meaningful part — unlike scrollback, whose tail is), which
/// also bounds IO if the file grew out of band. Invalid UTF-8 is replaced rather
/// than failing: showing a slightly mangled memo beats showing none.
pub fn load(base: &Path, project: &str) -> io::Result<Option<String>> {
    use std::io::Read;
    let f = match std::fs::File::open(path(base, project)) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut buf = Vec::new();
    f.take(MEMO_CAP as u64).read_to_end(&mut buf)?;
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Persist a project's memo atomically (temp + rename).
///
/// Returns [`io::ErrorKind::InvalidInput`] when `text` exceeds [`MEMO_CAP`] —
/// the write is refused whole rather than truncated (see module docs).
pub fn save(base: &Path, project: &str, text: &str) -> io::Result<()> {
    if text.len() > MEMO_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "memo exceeds the size cap",
        ));
    }
    let d = dir(base, project);
    std::fs::create_dir_all(&d)?;
    atomic_write(&d, text)
}

/// temp + rename. **어느 단계에서 실패하든** 임시 파일을 지운다 — 쓰기 실패로
/// 남은 반쪽짜리 `.tmp`도 누적되면 프로젝트 디렉토리를 채운다(rename 실패만
/// 정리하던 것을 전 구간으로 넓힘, 리뷰 P3).
fn atomic_write(d: &Path, text: &str) -> io::Result<()> {
    let tmp = d.join(format!(
        "memo.md.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let r = std::fs::write(&tmp, text.as_bytes())
        .and_then(|()| std::fs::rename(&tmp, d.join("memo.md")));
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
        let d = std::env::temp_dir().join(format!("mt_memo_{tag}_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trip() {
        let b = temp_base("rt");
        save(&b, "/home/u/proj", "첫 줄\n둘째 줄\n").unwrap();
        assert_eq!(load(&b, "/home/u/proj").unwrap().as_deref(), Some("첫 줄\n둘째 줄\n"));
    }

    #[test]
    fn missing_is_none() {
        let b = temp_base("missing");
        assert_eq!(load(&b, "/home/u/never-written").unwrap(), None);
    }

    #[test]
    fn read_failure_is_an_error_not_missing() {
        // 읽기 실패를 "메모 없음"으로 뭉개면 호출부가 빈 문서를 기반으로 저장해
        // 멀쩡한 파일을 빈 값으로 덮는다 (리뷰 P2-4). memo.md를 디렉토리로 만들어
        // 읽기 실패를 강제한다 — 열기는 되고 read가 EISDIR로 실패하는 경로.
        let b = temp_base("readerr");
        let d = dir(&b, "/p");
        std::fs::create_dir_all(d.join("memo.md")).unwrap();
        assert!(load(&b, "/p").is_err(), "부재가 아니라 오류여야 한다");
    }

    #[test]
    fn overwrite_replaces_whole_content() {
        let b = temp_base("over");
        save(&b, "/p", "긴 원본 내용").unwrap();
        save(&b, "/p", "짧게").unwrap();
        // rename semantics: no leftover tail from the longer previous write.
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("짧게"));
    }

    #[test]
    fn empty_memo_round_trips() {
        // Clearing the memo must persist as empty, not as "absent" (which would
        // resurrect the old text on the next mount).
        let b = temp_base("empty");
        save(&b, "/p", "내용").unwrap();
        save(&b, "/p", "").unwrap();
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn projects_are_isolated() {
        let b = temp_base("iso");
        save(&b, "/a/proj", "A").unwrap();
        save(&b, "/b/proj", "B").unwrap();
        assert_eq!(load(&b, "/a/proj").unwrap().as_deref(), Some("A"));
        assert_eq!(load(&b, "/b/proj").unwrap().as_deref(), Some("B"));
    }

    #[test]
    fn over_cap_is_refused_not_truncated() {
        let b = temp_base("cap");
        save(&b, "/p", "지켜야 할 내용").unwrap();
        let huge = "x".repeat(MEMO_CAP + 1);
        let err = save(&b, "/p", &huge).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        // The refused write left the previous memo intact.
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("지켜야 할 내용"));
    }

    #[test]
    fn traversal_in_project_is_neutralized() {
        let b = temp_base("trav");
        save(&b, "../../etc/passwd", "x").unwrap();
        // The file landed under `base/projects/<key>/`, never outside `base`.
        let p = path(&b, "../../etc/passwd");
        assert!(p.starts_with(&b), "{p:?} escaped {b:?}");
        assert_eq!(load(&b, "../../etc/passwd").unwrap().as_deref(), Some("x"));
    }

    /// 남아 있는 `.tmp` 파일 이름들.
    fn temps(d: &Path) -> Vec<String> {
        std::fs::read_dir(d)
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn failed_write_leaves_no_temp_file() {
        // rename 실패를 강제한다: 목적지 `memo.md`를 디렉토리로 만들어 두면
        // 파일→디렉토리 rename이 실패한다. 임시 파일은 이미 만들어진 뒤다.
        let b = temp_base("failtmp");
        let d = dir(&b, "/p");
        std::fs::create_dir_all(d.join("memo.md")).unwrap();
        assert!(save(&b, "/p", "내용").is_err());
        assert!(temps(&d).is_empty(), "실패한 쓰기가 .tmp를 남겼다: {:?}", temps(&d));
    }

    #[test]
    fn no_temp_files_left_behind() {
        let b = temp_base("tmp");
        save(&b, "/p", "내용").unwrap();
        let d = dir(&b, "/p");
        let leftovers: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temps: {leftovers:?}");
    }
}
