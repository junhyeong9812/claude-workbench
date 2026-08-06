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

/// The **same store keyed by an explicit file path** — [`load`]/[`save`] are
/// this with the project layout baked in.
///
/// It exists because a second kind of memo shares every guarantee here (atomic
/// replace, cap, optimistic lock, absent≠empty) but not the location: the
/// 프롬프트 정리 세션's draft lives in that session's `/tmp` scratch directory,
/// keyed by session uuid, not under `<base>/projects/`. Duplicating the store to
/// change one path is how the two contracts would drift.
///
/// The caller owns the path's safety — these take it verbatim.
pub fn load_at(file: &Path) -> io::Result<Option<String>> {
    use std::io::Read;
    let f = match std::fs::File::open(file) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut buf = Vec::new();
    f.take(MEMO_CAP as u64).read_to_end(&mut buf)?;
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// See [`load_at`] / [`save`]. Creates the parent directory as needed.
pub fn save_at(file: &Path, text: &str, base_hash: Option<&str>) -> io::Result<SaveOutcome> {
    if text.len() > MEMO_CAP {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "memo exceeds the size cap",
        ));
    }
    // 읽기 실패는 오류로 올린다 — "못 읽었으니 그냥 덮자"는 P2-4가 막은 바로 그
    // 경로다.
    let disk_hash = load_at(file)?.as_deref().map(content_hash);
    if disk_hash.as_deref() != base_hash {
        return Ok(SaveOutcome::Conflict { disk_hash });
    }
    let Some(d) = file.parent() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "memo path has no parent"));
    };
    std::fs::create_dir_all(d)?;
    atomic_write_to(file, text)?;
    Ok(SaveOutcome::Saved {
        hash: content_hash(text),
    })
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
    load_at(&path(base, project))
}

/// [`save`]의 결과 — 썼거나, 디스크가 그 사이 바뀌어 **거부했거나**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveOutcome {
    /// 저장 완료. `hash`는 방금 쓴 본문의 해시 = 다음 저장의 base.
    Saved { hash: String },
    /// 디스크가 `base_hash`와 다르다 — 쓰지 않았다. `disk_hash`는 지금 디스크
    /// 상태(파일이 없으면 `None`).
    Conflict { disk_hash: Option<String> },
}

/// Persist a project's memo atomically (temp + rename), **낙관적 잠금**으로.
///
/// `base_hash` = 이 편집이 출발한 디스크 상태의 [`content_hash`]. 파일이 없다고
/// 믿었으면 `None`. 지금 디스크가 그와 다르면 아무것도 쓰지 않고
/// [`SaveOutcome::Conflict`]를 돌려준다 (리뷰 P2-3).
///
/// 왜 필요한가: 메모는 창을 넘어 같은 파일을 두 에디터가 볼 수 있다. 잠금이
/// 없으면 마지막 쓰기가 상대의 문서를 **통째로** 덮는다 — 부분 병합이 아니라
/// 전문 교체라 손실이 전부다. 잠금이 있으면 최악이 "저장이 거부됐다"이고,
/// 사용자의 글자는 아직 에디터에 남아 있다.
///
/// 판정과 쓰기 사이에는 TOCTOU 창이 남는다(프로세스 간 파일 잠금은 쓰지 않는다).
/// 사람이 타이핑하는 속도에서 그 창은 실질적으로 닫혀 있고, 이 방어선의 목적은
/// 경쟁 조건의 완전 배제가 아니라 **조용한 전문 덮어쓰기를 시끄럽게 만드는 것**
/// 이다.
///
/// Returns [`io::ErrorKind::InvalidInput`] when `text` exceeds [`MEMO_CAP`] —
/// the write is refused whole rather than truncated (see module docs).
pub fn save(
    base: &Path,
    project: &str,
    text: &str,
    base_hash: Option<&str>,
) -> io::Result<SaveOutcome> {
    save_at(&path(base, project), text, base_hash)
}

/// temp + rename. **어느 단계에서 실패하든** 임시 파일을 지운다 — 쓰기 실패로
/// 남은 반쪽짜리 `.tmp`도 누적되면 프로젝트 디렉토리를 채운다(rename 실패만
/// 정리하던 것을 전 구간으로 넓힘, 리뷰 P3).
fn atomic_write_to(file: &Path, text: &str) -> io::Result<()> {
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "memo path has no file name"))?;
    let d = file.parent().unwrap_or_else(|| Path::new("."));
    let tmp = d.join(format!(
        "{name}.{}-{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let r = std::fs::write(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, file));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;


    /// 현재 디스크 해시 (base).
    fn cur(b: &Path, project: &str) -> Option<String> {
        load(b, project).unwrap().as_deref().map(content_hash)
    }

    /// 현재 디스크 상태를 base로 삼아 저장하고 Saved임을 확인한다 (충돌 없는 경로).
    fn put(b: &Path, project: &str, text: &str) {
        let base = cur(b, project);
        assert!(matches!(
            save(b, project, text, base.as_deref()).unwrap(),
            SaveOutcome::Saved { .. }
        ));
    }

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
        put(&b, "/home/u/proj", "첫 줄\n둘째 줄\n");
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
        put(&b, "/p", "긴 원본 내용");
        put(&b, "/p", "짧게");
        // rename semantics: no leftover tail from the longer previous write.
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("짧게"));
    }

    #[test]
    fn empty_memo_round_trips() {
        // Clearing the memo must persist as empty, not as "absent" (which would
        // resurrect the old text on the next mount).
        let b = temp_base("empty");
        put(&b, "/p", "내용");
        put(&b, "/p", "");
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn projects_are_isolated() {
        let b = temp_base("iso");
        put(&b, "/a/proj", "A");
        put(&b, "/b/proj", "B");
        assert_eq!(load(&b, "/a/proj").unwrap().as_deref(), Some("A"));
        assert_eq!(load(&b, "/b/proj").unwrap().as_deref(), Some("B"));
    }

    #[test]
    fn over_cap_is_refused_not_truncated() {
        let b = temp_base("cap");
        put(&b, "/p", "지켜야 할 내용");
        let huge = "x".repeat(MEMO_CAP + 1);
        let err = save(&b, "/p", &huge, cur(&b, "/p").as_deref()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        // The refused write left the previous memo intact.
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("지켜야 할 내용"));
    }

    #[test]
    fn traversal_in_project_is_neutralized() {
        let b = temp_base("trav");
        put(&b, "../../etc/passwd", "x");
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
        // (`save`가 아니라 `atomic_write`를 직접 부른다 — save는 이제 앞단의
        // load에서 먼저 실패해 쓰기 경로에 닿지도 못하기 때문이다.)
        let b = temp_base("failtmp");
        let d = dir(&b, "/p");
        std::fs::create_dir_all(d.join("memo.md")).unwrap();
        assert!(atomic_write_to(&d.join("memo.md"), "내용").is_err());
        assert!(temps(&d).is_empty(), "실패한 쓰기가 .tmp를 남겼다: {:?}", temps(&d));
    }

    #[test]
    fn no_temp_files_left_behind() {
        let b = temp_base("tmp");
        put(&b, "/p", "내용");
        assert!(temps(&dir(&b, "/p")).is_empty());
    }

    // ---- 낙관적 잠금 (리뷰 P2-3) ----

    #[test]
    fn stale_base_is_rejected_not_overwritten() {
        let b = temp_base("lock_stale");
        put(&b, "/p", "창 A가 읽은 원본");
        let stale = cur(&b, "/p"); // 창 B가 이 시점에 읽었다
        put(&b, "/p", "창 A가 나중에 쓴 것"); // 창 A가 먼저 저장

        let out = save(&b, "/p", "창 B가 통째로 덮어쓸 뻔한 것", stale.as_deref()).unwrap();
        assert_eq!(out, SaveOutcome::Conflict { disk_hash: cur(&b, "/p") });
        // 거부됐으므로 창 A의 글이 그대로 남아 있다.
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("창 A가 나중에 쓴 것"));
    }

    #[test]
    fn missing_file_passes_with_none_base() {
        let b = temp_base("lock_none");
        let out = save(&b, "/p", "첫 메모", None).unwrap();
        assert_eq!(out, SaveOutcome::Saved { hash: content_hash("첫 메모") });
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("첫 메모"));
    }

    #[test]
    fn none_base_against_existing_file_conflicts() {
        // "내가 처음 쓴다"고 믿었는데 이미 남의 메모가 있다 = 충돌이다.
        let b = temp_base("lock_none_conflict");
        put(&b, "/p", "이미 있던 메모");
        let out = save(&b, "/p", "덮어쓸 뻔한 것", None).unwrap();
        assert!(matches!(out, SaveOutcome::Conflict { .. }));
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("이미 있던 메모"));
    }

    #[test]
    fn returned_hash_is_the_next_base() {
        // 연속 저장이 재조회 없이 이어지려면 Saved.hash가 곧 다음 base여야 한다.
        let b = temp_base("lock_chain");
        let SaveOutcome::Saved { hash: h1 } = save(&b, "/p", "1", None).unwrap() else {
            panic!("첫 저장은 Saved여야 한다");
        };
        let SaveOutcome::Saved { hash: h2 } = save(&b, "/p", "2", Some(&h1)).unwrap() else {
            panic!("이어지는 저장도 Saved여야 한다");
        };
        assert_eq!(h2, cur(&b, "/p").unwrap());
        assert_eq!(load(&b, "/p").unwrap().as_deref(), Some("2"));
    }

    /// 경로 지정형도 같은 계약이다 — 부재=None, 부모 디렉토리 자동 생성, 원자
    /// 교체, 낙관적 잠금. (정리 세션 메모가 타는 길.)
    #[test]
    fn explicit_path_store_shares_the_contract() {
        let b = temp_base("at");
        let file = b.join("memo").join("f47ac10b-58cc-4372-a567-0e02b2c3d479.md");
        assert_eq!(load_at(&file).unwrap(), None, "부재는 None");

        let SaveOutcome::Saved { hash } = save_at(&file, "정리 초안", None).unwrap() else {
            panic!("첫 저장은 Saved");
        };
        assert!(file.is_file(), "부모 디렉토리를 만들어야 한다");
        assert_eq!(load_at(&file).unwrap().as_deref(), Some("정리 초안"));

        // stale base는 거부되고 본문은 그대로 (프로젝트 메모와 동일 규칙).
        assert!(matches!(
            save_at(&file, "덮어쓸 뻔한 것", None).unwrap(),
            SaveOutcome::Conflict { .. }
        ));
        assert_eq!(load_at(&file).unwrap().as_deref(), Some("정리 초안"));
        assert!(matches!(
            save_at(&file, "이어쓰기", Some(&hash)).unwrap(),
            SaveOutcome::Saved { .. }
        ));
        assert!(temps(file.parent().unwrap()).is_empty());
    }

    #[test]
    fn same_content_hashes_equal_across_calls() {
        assert_eq!(content_hash("같은 글"), content_hash("같은 글"));
        assert_ne!(content_hash("가"), content_hash("나"));
        // 길이 접두사 덕에 길이가 다르면 해시도 반드시 다르다.
        assert_ne!(content_hash(""), content_hash("a"));
    }
}
