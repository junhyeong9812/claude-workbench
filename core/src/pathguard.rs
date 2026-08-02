//! 경로 봉쇄(containment) 가드 (P4 공통화 — 보안 경계 단일 출처).
//!
//! 세 프리미티브를 제공한다. 호출부마다 **미존재 경로 정책**과 실패 시 사용자
//! 문구가 달라야 하므로(파일 생성은 미존재 허용, 아카이브 열기는 미존재 거부)
//! 에러는 [`ContainErr`] enum으로 돌려주고 문구 매핑은 호출부(도메인)에 남긴다
//! — 하향 통일 금지(spec ②).
//!
//! 전신(문자단위 중복): commands/graph.rs `contained_target` ↔
//! commands/archive.rs `archive_open_path` 인라인, commands/files.rs
//! `ensure_within`, canonical 키 3벌(graph/archive×2 — "canonicalizes
//! identically" 주석으로만 유지되던 계약).

use std::fs;
use std::path::{Path, PathBuf};

/// 봉쇄 검사 실패 원인 — 호출부가 도메인 문구로 매핑한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainErr {
    /// root를 canonicalize할 수 없다(미존재·권한).
    Root,
    /// 대상 경로(또는 그 어떤 조상도)를 해소할 수 없다.
    Path,
    /// 해소는 됐지만 root 밖이다.
    Outside,
}

/// **존재 전제** 봉쇄: 양쪽을 canonicalize(심링크 해소)하고 `path`가 `root`
/// 아래인지 확인, 해소된 경로를 반환한다. 미존재 대상 = 에러(Path) — 열기류
/// (xdg-open 등) 보안 요건.
pub fn contained_existing(root: &Path, path: &str) -> Result<PathBuf, ContainErr> {
    let root_c = fs::canonicalize(root).map_err(|_| ContainErr::Root)?;
    let target = fs::canonicalize(path).map_err(|_| ContainErr::Path)?;
    if target.starts_with(&root_c) {
        Ok(target)
    } else {
        Err(ContainErr::Outside)
    }
}

/// **미존재 허용** 봉쇄: `path` 자체가 아직 없으면 가장 깊은 **존재하는
/// 조상**을 canonicalize해 `root` 아래인지 확인한다 — 새 중첩 파일/폴더
/// 생성을 실제 디스크 위치 기준으로 검증(생성류 보안 요건).
/// 인자 순서·타입은 [`contained_existing`]과 동일(root: &Path 먼저) —
/// &str 2개로 두면 뒤바뀐 호출이 컴파일돼 봉쇄가 무력화된다(리뷰 지적).
pub fn contained_prospective(root: &Path, path: &str) -> Result<(), ContainErr> {
    let root_c = fs::canonicalize(root).map_err(|_| ContainErr::Root)?;
    let mut probe = PathBuf::from(path);
    let resolved = loop {
        match fs::canonicalize(&probe) {
            Ok(c) => break c,
            Err(_) => match probe.parent() {
                Some(parent) if parent != probe => probe = parent.to_path_buf(),
                _ => return Err(ContainErr::Path),
            },
        }
    };
    if resolved.starts_with(&root_c) {
        Ok(())
    } else {
        Err(ContainErr::Outside)
    }
}

// NOTE(P5 B-f descope): "존재 최심 조상" 탐색 3벌(이 파일 prospective 루프 ·
// commands/files.rs effective_path · label.rs canonical_or_self)의 통합을
// 시도했으나, `..` 꼬리 같은 퇴화 입력에서 세 구현의 의미가 3종으로 갈린다
// (prospective=file_name 무관 상승 / effective_path=None / canonical_or_self=
// ancestors+strip_prefix의 비정규 join) — 공통 핵으로 접으면 어느 한쪽의
// 관측 동작이 바뀐다. 정책 상이 계열 통일 금지 원칙(P4)에 따라 유지.

/// 프로젝트 경로의 canonical 키 — `.`/후행 슬래시/심링크 alias가 같은 키로
/// 접히고, 해소 불가(디스크에 없음)면 원문 그대로(폴백 계약 보존).
pub fn canonical_key(p: &str) -> String {
    fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-pathguard-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn existing_inside_ok_outside_and_missing_err() {
        let root = temp_root("ex");
        let inside = root.join("a.txt");
        fs::write(&inside, "x").unwrap();
        assert!(contained_existing(&root, inside.to_str().unwrap()).is_ok());
        // 미존재 대상 = Path 에러(열기류 보안 요건 — 조상 fallback 금지).
        assert_eq!(
            contained_existing(&root, root.join("nope").to_str().unwrap()),
            Err(ContainErr::Path)
        );
        // 밖 = Outside.
        let other = temp_root("ex-out");
        let out = other.join("b.txt");
        fs::write(&out, "y").unwrap();
        assert_eq!(
            contained_existing(&root, out.to_str().unwrap()),
            Err(ContainErr::Outside)
        );
        // root 미존재 = Root.
        assert_eq!(
            contained_existing(&root.join("no-root"), inside.to_str().unwrap()),
            Err(ContainErr::Root)
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn prospective_allows_unborn_nested_path_inside_only() {
        let root = temp_root("pro");
        // 아직 없는 중첩 경로 — 가장 깊은 존재 조상(root)이 안이면 통과.
        let unborn = root.join("sub/dir/new.txt");
        assert!(contained_prospective(&root, unborn.to_str().unwrap()).is_ok());
        // 밖의 미존재 경로 — 존재 조상이 root 밖이면 거부.
        let other = temp_root("pro-out");
        let outside = other.join("new.txt");
        assert_eq!(
            contained_prospective(&root, outside.to_str().unwrap()),
            Err(ContainErr::Outside)
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    /// 심링크로 root를 탈출하는 경로는 canonicalize가 해소해 Outside가 된다.
    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_outside() {
        let root = temp_root("sym");
        let other = temp_root("sym-target");
        fs::write(other.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&other, root.join("link")).unwrap();
        assert_eq!(
            contained_existing(&root, root.join("link/secret.txt").to_str().unwrap()),
            Err(ContainErr::Outside)
        );
        assert_eq!(
            contained_prospective(&root, root.join("link/new.txt").to_str().unwrap()),
            Err(ContainErr::Outside)
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn canonical_key_collapses_aliases_and_falls_back() {
        let root = temp_root("key");
        let with_dot = format!("{}/.", root.display());
        assert_eq!(canonical_key(&with_dot), canonical_key(root.to_str().unwrap()));
        // 미존재 = 원문 폴백(기존 3벌의 unwrap_or_else 계약).
        assert_eq!(canonical_key("/no/such/path-xyz"), "/no/such/path-xyz");
        let _ = fs::remove_dir_all(&root);
    }
}
