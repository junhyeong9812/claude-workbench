use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use core_lib::{DirEntry, ProjectType, WorkspaceState};
use tauri::{AppHandle, Manager};

use super::{io_message, AppError};

/// List the immediate children of `path`.
///
/// Thin wrapper over [`core_lib::list_dir`]: maps the I/O error to a user-safe
/// [`AppError`] (kind only — never the offending path). Returns `Err` (never
/// panics) if the path is missing, not a directory, or unreadable.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, AppError> {
    core_lib::list_dir(&path).map_err(|e| AppError::new(io_message("Cannot read directory", &e)))
}

/// Detect every project type present in a folder (badges). Infallible.
#[tauri::command]
pub fn detect_project_types(path: String) -> Vec<ProjectType> {
    core_lib::detect_project_types(path)
}

/// Detect per-tool build/test commands in a project dir (Cargo/npm/Gradle/...),
/// so the UI can offer one-click 빌드/테스트. Infallible.
#[tauri::command]
pub fn detect_run_targets(dir: String) -> Vec<core_lib::RunTarget> {
    core_lib::detect_run_targets(&dir)
}

/// The conventional mirror test-file path for a source file (None if the
/// language isn't supported). Path only — Claude generates the content there.
#[tauri::command]
pub fn mirror_test_path(src: String) -> Option<String> {
    core_lib::mirror_test_path(&src)
}

/// Hard cap on search results sent to the UI, to bound payload + walk time.
const SEARCH_LIMIT: usize = 500;

/// Project-wide file-name search under `root` (gitignore-aware). A query with
/// glob metacharacters (`*?[`) is matched as a glob, else as a case-insensitive
/// substring. Read-only and infallible (a bad query just yields no hits).
#[tauri::command]
pub fn search_files(root: String, query: String) -> Vec<core_lib::FileHit> {
    core_lib::search_files(&root, &query, SEARCH_LIMIT)
}

/// Project-wide content (grep) search under `root`: literal, case-insensitive,
/// gitignore-aware, binary files skipped. Read-only and infallible.
#[tauri::command]
pub fn search_content(root: String, query: String) -> Vec<core_lib::ContentHit> {
    core_lib::search_content(&root, &query, SEARCH_LIMIT)
}

/// Resolve the on-disk path of the workspace state file inside the app's
/// config directory.
fn state_file(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| AppError::new("Cannot resolve application config directory"))?;
    Ok(dir.join("workspace.json"))
}

/// Persist the workspace state to the app config directory.
#[tauri::command]
pub fn save_state(app: AppHandle, state: WorkspaceState) -> Result<(), AppError> {
    let path = state_file(&app)?;
    core_lib::save_state(&state, &path)
        .map_err(|e| AppError::new(io_message("Cannot save workspace state", &e)))
}

/// Load the workspace state. A missing or corrupt file yields the default
/// (empty) state, so this command never fails.
#[tauri::command]
pub fn load_state(app: AppHandle) -> WorkspaceState {
    match state_file(&app) {
        Ok(path) => core_lib::load_state(path),
        Err(_) => WorkspaceState::default(),
    }
}

/// Read a file's text, capped at `max_bytes` (default 5MB for the viewer; the
/// editor passes a smaller limit to decide editability). Refuses oversized files
/// rather than flooding the UI. Used by the timeline detail viewer, the file peek
/// viewer, and the editor.
#[tauri::command]
pub fn acp_read_file(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    const VIEW_MAX: u64 = 5 * 1024 * 1024;
    let max = max_bytes.unwrap_or(VIEW_MAX);
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))?;
    if meta.len() > max {
        return Err(AppError::new(format!("파일이 너무 큽니다 ({}KB 초과)", max / 1024)));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::new(io_message("Cannot read file", &e)))
}

/// Process-unique suffix so two saves never race on a shared temp path.
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Reject empty paths or any `..` parent-dir traversal (defense-in-depth on top
/// of the UI gates — a buggy/compromised renderer must not escape via `..`).
fn reject_unsafe_path(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::new("빈 경로입니다"));
    }
    if std::path::Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::new("'..' 가 포함된 경로는 허용되지 않습니다"));
    }
    Ok(())
}

/// Ensure `path` resolves **inside** `root` (the active project) — a stronger
/// guard than `reject_unsafe_path` so a buggy/compromised renderer can't
/// create/rename/delete outside the project (e.g. `delete_path("/")`). Both are
/// canonicalized (resolving symlinks); for a not-yet-created `path` we check its
/// deepest existing ancestor, so a new nested file still gets validated against
/// its real on-disk location.
fn ensure_within(path: &str, root: &str) -> Result<(), AppError> {
    // 봉쇄 알고리즘은 core::pathguard 단일 출처(P4) — 문구만 도메인 소유.
    use core_lib::pathguard::ContainErr;
    core_lib::pathguard::contained_prospective(std::path::Path::new(root), path).map_err(|e| {
        AppError::new(match e {
            ContainErr::Root => "프로젝트 경로를 확인할 수 없습니다",
            ContainErr::Path => "경로를 확인할 수 없습니다",
            ContainErr::Outside => "프로젝트 밖 경로는 허용되지 않습니다",
        })
    })
}

/// Delete a file/dir under `root`.
///
/// `root`는 **필수**다 — 예전엔 `Option`이라 스터디 트리처럼 생략하는 호출부가
/// containment 없이 삭제를 돌릴 수 있었다. 호출부가 전부 루트를 넘기게 된 지금은
/// 타입으로 강제해, "루트를 안 넘기면 검사도 없다"는 경로 자체를 없앤다.
#[tauri::command]
pub fn delete_path(path: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    ensure_within(&path, &root)?;
    let p = std::path::Path::new(&path);
    let md = std::fs::symlink_metadata(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))?;
    if md.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    } else {
        std::fs::remove_file(p).map_err(|e| AppError::new(io_message("Cannot delete", &e)))
    }
}

/// Write `content` to `path` (editor save), **atomically**: write a temp file in
/// the same directory then `rename` over the target, so a crash / ENOSPC / I/O
/// error never leaves the original truncated or partial (codex P2 E1). Symlinks
/// are resolved first so we edit the link's *target* (like most editors), not
/// replace the link.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err(AppError::new("Cannot write: path is a directory"));
    }
    // Resolve to the real file (follow symlinks); fall back to the given path if
    // it doesn't exist yet (new file).
    let target = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| AppError::new("Cannot save file: no parent directory"))?;
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(
        ".{stem}.mt-save-{}-{}.tmp",
        std::process::id(),
        SAVE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| AppError::new(io_message("Cannot save file", &e)))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup on rename failure
        AppError::new(io_message("Cannot save file", &e))
    })
}

/// Create an empty file at `path` (tree "새 파일"). Parent directories are
/// created as needed (so a typed `sub/Foo.java` works). Errors if the path
/// already exists, so an existing file is never clobbered.
///
/// 단일 경로 API — 구현은 [`create_files`]와 공유한다(생성 규칙 단일 출처).
/// **현재 프론트 호출부는 없다**(트리 "새 파일"은 다중 생성 경로 하나로 통일):
/// 삭제하지 않고 남기는 이유는 ① 단일 생성 계약(문구 포함)을 고정하는 테스트가
/// 이 표면을 통해 돌고 ② 위임이라 구현 중복이 0이기 때문이다. 다시 갈라지면
/// (자체 로직이 생기면) 그때는 지우는 게 맞다.
#[tauri::command]
pub fn create_file(path: String, root: String) -> Result<(), AppError> {
    create_files_impl(&[path], &root)
}

/// 한 번의 "새 파일"로 만들 수 있는 최대 개수. 프론트의 brace 확장 상한
/// (`BRACE_MAX`)과 같은 값 — 프론트를 우회한 호출도 백엔드가 스스로 막는다.
const MAX_CREATE_FILES: usize = 20;

/// 여러 빈 파일을 **전부 아니면 전무**로 만든다 (트리 "새 파일"의 brace 다중 생성).
///
/// 충돌 정책: 하나라도 이미 존재하면 **아무것도 만들지 않고** 충돌 목록을 담은
/// 오류를 돌려준다. 부분 생성은 "무엇이 만들어졌는지 모르는" 상태를 남기고,
/// 사용자가 그걸 되돌리려면 트리에서 하나씩 지워야 한다 — 검사를 먼저 다 하는
/// 비용이 훨씬 싸다.
///
/// 계약은 **관측 가능한 부분 생성 0**이다. 그래서 두 가지를 더 한다:
///  - 중복·충돌 검사를 입력 문자열이 아니라 **정규화된 경로**(존재하는 최심
///    조상을 canonicalize + 나머지 꼬리 — `effective_path`) 기준으로 한다.
///    문자열 비교였을 때 `root/a.ts`와 `root/./a.ts`(또는 심링크 경유 별칭)는
///    서로 다른 항목으로 통과해, 앞의 것을 만들고 뒤의 것에서 `create_new`가
///    실패 = 정확히 막으려던 부분 생성이 됐다.
///  - 검사를 통과한 뒤의 I/O 실패(권한·ENOSPC·부모가 파일이던 경우 등)에는
///    **이번 호출이 만든 것만** 역순으로 지우고(파일 → 그때 새로 만든 빈 부모
///    dir) 오류를 돌려준다. best-effort다: 되돌리기 자체가 실패해도(권한 등)
///    원래 오류를 삼키지 않는다.
///
/// 남는 경합(수용): 검사와 생성 사이에 **다른 프로세스**가 같은 경로를 만들면
/// `create_new`가 최후 방어선이라 덮어쓰지는 않고 오류가 된다. 부모 dir이 그
/// 사이에 심링크로 바뀌는 TOCTOU도 같은 계정의 다른 프로세스만 가능하므로
/// 이 앱의 위협 모델(#71 G4 — 같은 사용자 계정은 신뢰 경계 안) 밖으로 둔다.
#[tauri::command]
pub fn create_files(paths: Vec<String>, root: String) -> Result<(), AppError> {
    create_files_impl(&paths, &root)
}

/// 이번 호출이 만든 것 되돌리기 (best-effort). dir은 **깊은 것부터** 지운다
/// (얕은 것을 먼저 지우려 하면 비어 있지 않아 실패). `remove_dir`(재귀 아님)만
/// 쓰므로, 그 사이에 남의 내용이 들어온 dir은 남는다 — 지우기보다 남기는 쪽이
/// 안전하다.
///
/// 반환 = **정리하지 못하고 남은 것들**의 root 상대 경로. 삼키기만 하면 사용자
/// 화면에는 "실패"라고 떴는데 디스크에는 파일이 남아 있는 상태가 무음이 된다 —
/// 호출부가 이 목록을 원 오류 뒤에 덧붙여 가시화한다.
fn rollback_created(files: &[PathBuf], dirs: &[PathBuf], root_c: &std::path::Path) -> Vec<String> {
    let mut left = Vec::new();
    for f in files.iter().rev() {
        if std::fs::remove_file(f).is_err() && std::fs::symlink_metadata(f).is_ok() {
            left.push(rel_to_root(f, root_c));
        }
    }
    let mut ds: Vec<&PathBuf> = dirs.iter().collect();
    ds.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in ds {
        if std::fs::remove_dir(d).is_err() && d.exists() {
            left.push(rel_to_root(d, root_c));
        }
    }
    left
}

/// 원 오류 + 정리 못 한 잔존물 표시 (잔존이 없으면 원 오류 그대로).
fn create_error(msg: String, leftovers: Vec<String>) -> AppError {
    if leftovers.is_empty() {
        AppError::new(msg)
    } else {
        AppError::new(format!("{msg} (일부 항목 정리 실패: {})", leftovers.join(", ")))
    }
}

/// `root_c` 아래의 `parent`까지 조상을 **바깥→안 순서로 하나씩** 만들고, 이번
/// 호출이 실제로 만든 것만 `made`에 기록한다.
///
/// `create_dir_all` + "미리 계산한 미존재 목록"이 아닌 이유(감사 Y1): 계산과
/// 생성 사이의 창에서 **다른 호출**(같은 앱의 다른 트리/패널도 만든다)이 같은
/// dir을 만들면, 우리는 그것을 우리 소유로 오기록해 롤백 때 남의 dir을 지운다.
/// 반대로 create_dir_all이 중간까지만 만들고 실패하면 그 잔해는 아예 기록되지
/// 않아 롤백에서 빠진다. 한 레벨씩 만들면 창이 사라진다 — 성공 = 우리 것(기록),
/// `AlreadyExists` = 남의 것(미기록), 그 밖의 오류 = 그 시점까지의 기록분으로
/// 롤백. (경로에 파일이 끼어 있으면 그 레벨은 AlreadyExists로 지나가고, 바로
/// 다음 레벨 또는 파일 생성이 NotADirectory로 실패해 결국 오류로 드러난다.)
fn ensure_dirs(
    parent: &std::path::Path,
    root_c: &std::path::Path,
    made: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    let Ok(rel) = parent.strip_prefix(root_c) else {
        // 루트 밖(있을 수 없음 — 봉쇄 통과분만 온다)이면 기록 없이 통짜 생성.
        return std::fs::create_dir_all(parent);
    };
    let mut cur = root_c.to_path_buf();
    for seg in rel.components() {
        cur.push(seg);
        match std::fs::create_dir(&cur) {
            Ok(()) => made.push(cur.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {} // 남의 것 — 기록하지 않는다
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 오류 표시용 root 상대 경로 (밖이면 파일명 폴백) — 절대 경로를 그대로 노출하지
/// 않으면서도 같은 이름이 여러 폴더에 있을 때 어느 것인지 구분된다.
fn rel_to_root(p: &std::path::Path, root_c: &std::path::Path) -> String {
    p.strip_prefix(root_c)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| {
            p.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| p.to_string_lossy().to_string())
        })
}

fn create_files_impl(paths: &[String], root: &str) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::new("생성할 경로가 없습니다"));
    }
    if paths.len() > MAX_CREATE_FILES {
        return Err(AppError::new(format!(
            "한 번에 최대 {MAX_CREATE_FILES}개까지 만들 수 있습니다 (요청 {}개)",
            paths.len()
        )));
    }
    // 1) 경로 검증 — 전부 통과해야 한 개라도 만든다.
    for p in paths {
        reject_unsafe_path(p)?;
        ensure_within(p, root)?;
    }
    let root_c = std::fs::canonicalize(root)
        .map_err(|_| AppError::new("프로젝트 경로를 확인할 수 없습니다"))?;
    // 2) 정규화 — 별칭(`./`·중복 슬래시·심링크 경유)이 같은 키로 접힌다.
    let targets: Vec<PathBuf> = paths
        .iter()
        .map(|p| effective_path(p).ok_or_else(|| AppError::new("경로를 확인할 수 없습니다")))
        .collect::<Result<_, _>>()?;
    // 3) 입력 자체의 중복도 부분 생성의 원인(두 번째가 no-clobber로 실패) — 먼저 막는다.
    for (i, t) in targets.iter().enumerate() {
        if targets[..i].contains(t) {
            return Err(AppError::new(format!(
                "중복된 경로가 있습니다: {}",
                rel_to_root(t, &root_c)
            )));
        }
    }
    // 4) 전수 충돌 검사. `symlink_metadata`(not `exists`)라 깨진 심링크도 점유로 본다.
    let conflicts: Vec<String> = targets
        .iter()
        .filter(|t| std::fs::symlink_metadata(t).is_ok())
        .map(|t| rel_to_root(t, &root_c))
        .collect();
    if !conflicts.is_empty() {
        // 단일 생성의 문구는 그대로 유지(기존 트리 동작 회귀 0).
        return Err(AppError::new(if paths.len() == 1 {
            "이미 존재하는 경로입니다".to_string()
        } else {
            format!("이미 존재하는 경로: {}", conflicts.join(", "))
        }));
    }
    // 5) 생성 — 실패하면 이번 호출이 만든 것만 되돌린다.
    let mut made_files: Vec<PathBuf> = Vec::new();
    let mut made_dirs: Vec<PathBuf> = Vec::new();
    for t in &targets {
        if let Some(parent) = t.parent() {
            if let Err(e) = ensure_dirs(parent, &root_c, &mut made_dirs) {
                let left = rollback_created(&made_files, &made_dirs, &root_c);
                return Err(create_error(io_message("Cannot create file", &e), left));
            }
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(t) {
            Ok(_) => made_files.push(t.clone()),
            Err(e) => {
                let left = rollback_created(&made_files, &made_dirs, &root_c);
                return Err(create_error(io_message("Cannot create file", &e), left));
            }
        }
    }
    Ok(())
}

/// Create a directory at `path` (tree "새 폴더"), including intermediate dirs —
/// so a typed `com/example/foo` (or `.`-separated, mapped to `/` by the UI)
/// makes the whole chain. Idempotent: an existing dir is not an error.
#[tauri::command]
pub fn create_dir(path: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    ensure_within(&path, &root)?;
    std::fs::create_dir_all(&path).map_err(|e| AppError::new(io_message("Cannot create folder", &e)))
}

/// Rename/move `from` to `to` (tree "이름 변경"). Errors if `to` already exists
/// (no overwrite). Parent dirs of `to` are created as needed.
#[tauri::command]
pub fn rename_path(from: String, to: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&from)?;
    reject_unsafe_path(&to)?;
    ensure_within(&from, &root)?;
    ensure_within(&to, &root)?;
    let to_p = std::path::Path::new(&to);
    // `symlink_metadata` (not `exists`) so a dangling symlink at `to` is also
    // treated as occupied — `exists()` reports false for it and would clobber.
    if std::fs::symlink_metadata(to_p).is_ok() {
        return Err(AppError::new("대상 경로가 이미 존재합니다"));
    }
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot rename", &e)))?;
    }
    std::fs::rename(&from, to_p).map_err(|e| AppError::new(io_message("Cannot rename", &e)))
}

/// 재귀 복사 깊이 상한 — 스택 고갈 방지(감사 D6). 실사용 트리는 수십 레벨
/// 이내; 초과는 오류로 드러낸다(무음 절단 아님).
const MAX_COPY_DEPTH: usize = 256;

/// Copy one filesystem node (file / dir tree / symlink) from `from` to `to`.
/// - 디렉토리는 재귀 복사, 심링크는 **링크 그대로** 재생성(대상 내용 복제 X —
///   링크 루프로 인한 무한 재귀·프로젝트 밖 내용 복제 방지).
/// - `to`는 존재하지 않아야 한다(호출측 no-clobber 검사 전제).
fn copy_tree(from: &std::path::Path, to: &std::path::Path, depth: usize) -> std::io::Result<()> {
    if depth > MAX_COPY_DEPTH {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "folder too deep",
        ));
    }
    let md = std::fs::symlink_metadata(from)?;
    if md.file_type().is_symlink() {
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, to)?;
        #[cfg(not(unix))]
        let _ = target; // non-unix: 심링크 복사 미지원 — 조용히 건너뛰지 않도록
        #[cfg(not(unix))]
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "symlink copy"));
    } else if md.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), depth + 1)?;
        }
    } else {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// 존재하지 않을 수 있는 경로의 **실효 경로**: 존재하는 최심 조상을
/// canonicalize하고 나머지 구성요소를 붙인다(조상 해소 규칙은 core::pathguard
/// contained_prospective와 동형 — tail 재부착·Option 반환만 다르다. 통합은
/// P5 후보(resolve_deepest_existing), 리뷰 ledger 기록).
/// root 안 심링크 별칭이 같은 위치를 다른 문자열로 가리키는 것을 정규화해,
/// lexical starts_with만으로는 뚫리는 자기 하위 판정을 막는다 (리뷰 D4).
fn effective_path(path: &str) -> Option<std::path::PathBuf> {
    let mut probe = std::path::PathBuf::from(path);
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&probe) {
            Ok(c) => {
                let mut out = c;
                for seg in tail.iter().rev() {
                    out.push(seg);
                }
                return Some(out);
            }
            Err(_) => match (probe.parent().map(|p| p.to_path_buf()), probe.file_name()) {
                (Some(parent), Some(name)) if parent != probe => {
                    tail.push(name.to_os_string());
                    probe = parent;
                }
                _ => return None,
            },
        }
    }
}

/// symlink는 링크만, 파일/디렉토리는 통째 제거 (temp 정리용 — best-effort).
fn remove_any(p: &std::path::Path) {
    match std::fs::symlink_metadata(p) {
        Ok(md) if md.is_dir() => {
            let _ = std::fs::remove_dir_all(p);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(p);
        }
        Err(_) => {}
    }
}

/// D3(부분 실패 잔해 방지): dest 부모의 temp로 복사한 뒤 rename으로 게시한다 —
/// 중간 실패(권한·ENOSPC)는 temp만 정리되고 최종 위치엔 완전한 결과 아니면
/// 아무것도 남지 않는다(재시도가 no-clobber 오탐에 막히지 않음).
fn copy_via_temp(from: &std::path::Path, to: &std::path::Path) -> Result<(), AppError> {
    let parent = to
        .parent()
        .ok_or_else(|| AppError::new("대상 부모 경로가 없습니다"))?;
    let tmp = parent.join(format!(
        ".mt-copy-{}-{}.tmp",
        std::process::id(),
        SAVE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = copy_tree(from, &tmp, 0) {
        remove_any(&tmp);
        return Err(AppError::new(io_message("Cannot copy", &e)));
    }
    // 게시 직전 재확인(감사 D3): fs::rename은 기존 *파일*을 소리 없이 교체할
    // 수 있다 — 복사 중 대상이 생겼으면 게시하지 않는다. (재확인~rename 사이
    // 미세 창은 단일 사용자 데스크톱 위협모델에서 잔여 리스크로 기록.)
    if std::fs::symlink_metadata(to).is_ok() {
        remove_any(&tmp);
        return Err(AppError::new("대상 경로가 이미 존재합니다"));
    }
    std::fs::rename(&tmp, to).map_err(|e| {
        remove_any(&tmp);
        AppError::new(io_message("Cannot copy", &e))
    })
}

/// Copy `from` to `to` (tree DnD "Ctrl 복사"). Both must live inside `root`;
/// `to` must not exist (덮어쓰기는 UI가 확인 후 삭제→복사 2단계로 수행). A dir
/// cannot be copied into itself/its own subtree — 무한 재귀·자기복제 방지
/// (심링크 별칭 포함 — 실효 경로 기준, 리뷰 D4). Blocking 풀에서 실행 —
/// 대형 폴더 복사가 UI 스레드를 잡지 않는다 (리뷰 D6).
#[tauri::command]
pub async fn copy_path(from: String, to: String, root: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || copy_path_blocking(from, to, root))
        .await
        .map_err(|_| AppError::new("Copy task failed to run"))?
}

fn copy_path_blocking(from: String, to: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&from)?;
    reject_unsafe_path(&to)?;
    ensure_within(&from, &root)?;
    ensure_within(&to, &root)?;
    let from_p = std::path::Path::new(&from);
    let to_p = std::path::Path::new(&to);
    if std::fs::symlink_metadata(from_p).is_err() {
        return Err(AppError::new("원본 경로가 없습니다"));
    }
    let from_c = std::fs::canonicalize(from_p)
        .map_err(|_| AppError::new("원본 경로를 확인할 수 없습니다"))?;
    let to_eff = effective_path(&to).ok_or_else(|| AppError::new("경로를 확인할 수 없습니다"))?;
    if to_eff == from_c || to_eff.starts_with(&from_c) {
        return Err(AppError::new("자기 자신/하위로는 복사할 수 없습니다"));
    }
    if std::fs::symlink_metadata(to_p).is_ok() {
        return Err(AppError::new("대상 경로가 이미 존재합니다"));
    }
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot copy", &e)))?;
    }
    copy_via_temp(from_p, to_p)
}

/// Per-source results of an external import (드롭 존 보조 창): what landed,
/// what needs an overwrite confirm, what failed — 부분 실패를 무음 처리하지
/// 않기 위한 명시적 3분류.
#[derive(serde::Serialize)]
pub struct ImportOutcome {
    pub copied: Vec<String>,
    /// dest에 같은 이름이 이미 있어 건너뛴 소스들 (UI가 확인 후 overwrite 재호출).
    pub conflicts: Vec<String>,
    /// `소스경로: 사유` 형식.
    pub errors: Vec<String>,
}

/// Import external OS paths (드롭 존에 떨어진 파일/폴더) into `dest_dir` by
/// **copy** — 원본은 절대 이동·삭제하지 않는다. `dest_dir`만 containment 검사
/// (소스는 프로젝트 밖 허용 — 읽기 전용). `overwrite=true`면 충돌 대상(확인
/// 받은 것)을 **temp 복사 완료 후** 삭제→게시한다(감사 D3 — 대상 유실 창
/// 최소화). Blocking 풀 실행(리뷰 D6).
#[tauri::command]
pub async fn import_paths(
    sources: Vec<String>,
    dest_dir: String,
    root: String,
    overwrite: bool,
) -> Result<ImportOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        import_paths_blocking(sources, dest_dir, root, overwrite)
    })
    .await
    .map_err(|_| AppError::new("Import task failed to run"))?
}

fn import_paths_blocking(
    sources: Vec<String>,
    dest_dir: String,
    root: String,
    overwrite: bool,
) -> Result<ImportOutcome, AppError> {
    reject_unsafe_path(&dest_dir)?;
    ensure_within(&dest_dir, &root)?;
    let dest_dir_p = std::path::Path::new(&dest_dir);
    if !dest_dir_p.is_dir() {
        return Err(AppError::new("대상 폴더가 없습니다"));
    }
    let dest_dir_c = std::fs::canonicalize(dest_dir_p)
        .map_err(|_| AppError::new("대상 폴더를 확인할 수 없습니다"))?;
    let mut out = ImportOutcome {
        copied: vec![],
        conflicts: vec![],
        errors: vec![],
    };
    for src in sources {
        // D5: 모든 소스가 copied/conflicts/errors 중 하나로 분류된다 — 무음 스킵 없음.
        if src.trim().is_empty() {
            out.errors.push("(빈 경로)".to_string());
            continue;
        }
        let src_p = std::path::Path::new(&src);
        let Some(name) = src_p.file_name() else {
            out.errors.push(format!("{src}: 이름을 알 수 없음"));
            continue;
        };
        if std::fs::symlink_metadata(src_p).is_err() {
            out.errors.push(format!("{src}: 원본 없음"));
            continue;
        }
        // canonical 기준 가드(리뷰 D1·D4 — 심링크 별칭 포함):
        // ①dest_dir가 소스 안 → 자기 자신 안으로의 복제(무한 재귀) 금지
        let Ok(src_c) = std::fs::canonicalize(src_p) else {
            out.errors.push(format!("{src}: 경로 확인 불가"));
            continue;
        };
        if dest_dir_c == src_c || dest_dir_c.starts_with(&src_c) {
            out.errors.push(format!("{src}: 자기 자신 안으로는 가져올 수 없습니다"));
            continue;
        }
        let dest = dest_dir_c.join(name);
        if std::fs::symlink_metadata(&dest).is_ok() {
            // ②대상이 원본과 같은 실체이거나 원본을 담고 있으면 — overwrite
            // 삭제가 원본을 파괴한다(D1 critical). 충돌이 아니라 즉시 오류.
            if let Ok(dest_c) = std::fs::canonicalize(&dest) {
                if dest_c == src_c {
                    out.errors.push(format!("{src}: 원본과 대상이 같습니다"));
                    continue;
                }
                if src_c.starts_with(&dest_c) {
                    out.errors
                        .push(format!("{src}: 원본을 담고 있는 항목은 덮어쓸 수 없습니다"));
                    continue;
                }
            }
            if !overwrite {
                out.conflicts.push(src);
                continue;
            }
            // D3: temp 복사를 먼저 완료 → 기존 대상 삭제 → 게시. 복사 실패
            // 시 기존 대상은 그대로 남는다.
            let tmp = dest_dir_c.join(format!(
                ".mt-import-{}-{}.tmp",
                std::process::id(),
                SAVE_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            if let Err(e) = copy_tree(src_p, &tmp, 0) {
                remove_any(&tmp);
                out.errors.push(format!("{src}: {}", io_message("Cannot import", &e)));
                continue;
            }
            // 재확인 기반 삭제 — 그 사이 사라졌으면 삭제 불필요(unwrap panic
            // 금지, post-fix P3).
            let removed = match std::fs::symlink_metadata(&dest) {
                Ok(md) if md.is_dir() => std::fs::remove_dir_all(&dest),
                Ok(_) => std::fs::remove_file(&dest),
                Err(_) => Ok(()),
            };
            if let Err(e) = removed {
                remove_any(&tmp);
                out.errors.push(format!("{src}: {}", io_message("Cannot overwrite", &e)));
                continue;
            }
            match std::fs::rename(&tmp, &dest) {
                Ok(()) => out.copied.push(src),
                Err(e) => {
                    // 대상은 이미 삭제됐고 temp에 완전한 복사본이 있다 — 지우면
                    // 양쪽 다 잃는다. temp를 남기고 경로를 알린다(post-fix P2).
                    out.errors.push(format!(
                        "{src}: {} (복사본은 {} 에 남아 있음)",
                        io_message("Cannot import", &e),
                        tmp.to_string_lossy()
                    ));
                }
            }
            continue;
        }
        match copy_via_temp(src_p, &dest) {
            Ok(()) => out.copied.push(src),
            Err(e) => out.errors.push(format!("{src}: {}", e.message)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_within_blocks_outside_root() {
        let root = std::env::temp_dir().join(format!("mt_within_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root_s = root.to_string_lossy().to_string();

        // Nested create inside the project root succeeds.
        let inside = format!("{root_s}/a/b/c");
        assert!(create_dir(inside.clone(), root_s.clone()).is_ok());
        assert!(std::path::Path::new(&inside).is_dir());

        // An absolute path outside the root is rejected (renderer can't escape).
        assert!(create_dir("/etc/mt_should_not_exist".into(), root_s.clone()).is_err());
        assert!(create_file("/etc/mt_should_not_exist_file".into(), root_s).is_err());
    }

    #[test]
    fn create_file_no_clobber_and_within() {
        let root = std::env::temp_dir().join(format!("mt_cf_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root_s = root.to_string_lossy().to_string();
        let f = format!("{root_s}/x.txt");
        assert!(create_file(f.clone(), root_s.clone()).is_ok());
        // Second create on the same path fails (no clobber).
        assert!(create_file(f, root_s).is_err());
    }

    // 다중 생성(brace)의 핵심 계약: 충돌이 하나라도 있으면 **아무것도** 만들지
    // 않는다 (부분 생성 금지).
    #[test]
    fn create_files_all_or_nothing() {
        let root = std::env::temp_dir().join(format!("mt_cfs_{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root_s = root.to_string_lossy().to_string();
        let a = format!("{root_s}/a.ts");
        let b = format!("{root_s}/b.ts");
        let c = format!("{root_s}/sub/c.ts");

        // 정상: 중첩 경로 포함 전부 생성.
        assert!(create_files(vec![a.clone(), c.clone()], root_s.clone()).is_ok());
        assert!(std::path::Path::new(&a).is_file());
        assert!(std::path::Path::new(&c).is_file());

        // 신규(b) + 충돌(a) — **충돌 항목을 뒤에 둔다**: 검사를 다 하기 전에
        // 만들기 시작하면 b가 생겨 버리므로, 이 순서라야 "전수 검사 후 생성"을
        // 실제로 판별한다(앞에 두면 순차 구현도 통과).
        let e = create_files(vec![b.clone(), a.clone()], root_s.clone()).unwrap_err();
        assert!(e.message.contains("a.ts"), "충돌 목록: {}", e.message);
        assert!(!std::path::Path::new(&b).exists(), "충돌 시 부분 생성 없음");

        // 중복 입력도 생성 전에 거부.
        assert!(create_files(vec![b.clone(), b.clone()], root_s.clone()).is_err());
        assert!(!std::path::Path::new(&b).exists());

        // 별칭(`./`)은 문자열로는 다르지만 같은 파일 — 정규화 기준 중복이라
        // 거부하고 아무것도 만들지 않는다(문자열 비교 시절엔 b가 만들어졌다).
        let alias = format!("{root_s}/./b.ts");
        let e = create_files(vec![b.clone(), alias.clone()], root_s.clone()).unwrap_err();
        assert!(e.message.contains("중복"), "{}", e.message);
        assert!(!std::path::Path::new(&b).exists(), "별칭 중복도 부분 생성 0");

        // 별칭이 **기존 파일**을 가리키는 경우도 충돌로 잡힌다(a는 이미 있다).
        let alias_a = format!("{root_s}/./a.ts");
        let e = create_files(vec![b.clone(), alias_a], root_s.clone()).unwrap_err();
        assert!(e.message.contains("a.ts"), "{}", e.message);
        assert!(!std::path::Path::new(&b).exists());

        // 심링크 경유 별칭 — `.` 정규화만으로는 접히지 않고 canonicalize라야
        // 같은 키가 된다(정규화 기준 검사의 진짜 이유).
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let via_real = format!("{root_s}/real/x.ts");
        let via_link = format!("{root_s}/link/x.ts");
        let e = create_files(vec![via_real.clone(), via_link], root_s.clone()).unwrap_err();
        assert!(e.message.contains("중복"), "{}", e.message);
        assert!(!std::path::Path::new(&via_real).exists(), "심링크 별칭도 부분 생성 0");

        // 상한 초과 거부.
        let many: Vec<String> = (0..21).map(|i| format!("{root_s}/m{i}.ts")).collect();
        assert!(create_files(many, root_s.clone()).is_err());
        assert!(!std::path::Path::new(&format!("{root_s}/m0.ts")).exists());

        // containment: 하나라도 루트 밖이면 전부 거부.
        assert!(create_files(
            vec![b.clone(), "/etc/mt_should_not_exist_multi".into()],
            root_s.clone()
        )
        .is_err());
        assert!(!std::path::Path::new(&b).exists());

        // 빈 목록.
        assert!(create_files(vec![], root_s).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    // 검사를 통과한 뒤의 I/O 실패도 관측 가능한 부분 생성을 남기지 않는다:
    // 두 번째 경로의 부모가 **첫 번째로 만든 파일**이라 create_new가 ENOTDIR로
    // 실패한다 → 이번 호출이 만든 파일·dir이 전부 되돌아가야 한다.
    #[test]
    fn create_files_rolls_back_on_midway_io_failure() {
        let (root, root_s) = temp_root("cfs_rb");
        let file = format!("{root_s}/n1/n2/a.ts");
        let under_file = format!("{root_s}/n1/n2/a.ts/x.ts"); // 부모가 파일 → 실패

        let e = create_files(vec![file.clone(), under_file], root_s.clone()).unwrap_err();
        assert!(!e.message.is_empty());
        assert!(!std::path::Path::new(&file).exists(), "만든 파일 되돌림");
        assert!(!root.join("n1/n2").exists(), "새로 만든 빈 부모 dir 되돌림");
        assert!(!root.join("n1").exists(), "얕은 쪽까지 되돌림");
        assert!(root.exists(), "루트는 건드리지 않는다");

        // 이미 있던 dir은 우리가 만든 게 아니므로 남는다.
        std::fs::create_dir_all(root.join("keep")).unwrap();
        let f2 = format!("{root_s}/keep/b.ts");
        let bad = format!("{root_s}/keep/b.ts/c.ts");
        assert!(create_files(vec![f2.clone(), bad], root_s).is_err());
        assert!(!std::path::Path::new(&f2).exists());
        assert!(root.join("keep").is_dir(), "기존 dir 보존");
        let _ = std::fs::remove_dir_all(&root);
    }

    // dir 소유권(감사 Y1): 이번 호출이 **직접 만든** 레벨만 되돌린다. 한 레벨씩
    // create_dir 하므로 "미리 계산 → create_dir_all" 사이의 창(다른 호출이 그
    // 사이에 만든 dir을 우리 것으로 오기록)이 없다.
    #[test]
    fn create_files_rollback_keeps_foreign_dirs() {
        let (root, root_s) = temp_root("cfs_own");
        // 남의 것(사전 존재) — 깊이 2단계.
        std::fs::create_dir_all(root.join("pre/kept")).unwrap();
        let f = format!("{root_s}/pre/kept/mine/deep/a.ts");
        let bad = format!("{root_s}/pre/kept/mine/deep/a.ts/x.ts"); // 부모가 파일 → 실패
        assert!(create_files(vec![f.clone(), bad], root_s.clone()).is_err());
        assert!(!std::path::Path::new(&f).exists(), "만든 파일 되돌림");
        assert!(!root.join("pre/kept/mine").exists(), "이번 호출이 만든 레벨만 정리");
        assert!(root.join("pre/kept").is_dir(), "사전 존재 dir 보존");
        assert!(root.join("pre").is_dir(), "사전 존재 상위 dir 보존");

        // 사전 존재 dir이 **중간 레벨 실패**를 일으켜도(쓰기 권한 없음) 그 dir은
        // 남고, 그 아래로는 아무것도 안 생긴다. root로 도는 환경에서는 권한이
        // 무시되므로 실제로 막히는지 먼저 확인하고 건너뛴다.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let ro = root.join("ro");
            std::fs::create_dir(&ro).unwrap();
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
            let probe = ro.join(".probe");
            let writable = std::fs::File::create(&probe).is_ok();
            let _ = std::fs::remove_file(&probe);
            if !writable {
                let blocked = format!("{root_s}/ro/sub/b.ts");
                assert!(create_files(vec![blocked], root_s).is_err());
                assert!(ro.is_dir(), "권한 실패에도 남의 dir 보존");
                assert!(!ro.join("sub").exists());
            }
            std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // 경쟁 재현(감사 Y1): "다른 호출이 그 사이에 만들어 둔 레벨"의 **결과 상태**는
    // = 그 레벨이 이미 존재하는 상태다. 그 상태에서 ensure_dirs를 돌려 우리가
    // 만든 레벨만 기록되는지 직접 본다. 옛 구현은 소유권을 생성 **전** 스냅샷
    // (missing_ancestors)으로 정했기 때문에 이 레벨을 우리 것으로 기록했고,
    // 실패 시 남의 dir을 지웠다.
    #[test]
    fn ensure_dirs_records_only_what_it_creates() {
        let (root, _root_s) = temp_root("cfs_ed");
        std::fs::create_dir_all(root.join("a/b")).unwrap(); // 남의 것
        let mut made: Vec<PathBuf> = Vec::new();
        ensure_dirs(&root.join("a/b/c/d"), &root, &mut made).unwrap();
        assert_eq!(
            made,
            vec![root.join("a/b/c"), root.join("a/b/c/d")],
            "우리가 실제로 만든 레벨만 기록"
        );
        assert!(root.join("a/b/c/d").is_dir());

        // 전 구간이 이미 있으면 기록은 비어 있다(= 롤백이 남의 것을 안 건드린다).
        let mut made2: Vec<PathBuf> = Vec::new();
        ensure_dirs(&root.join("a/b"), &root, &mut made2).unwrap();
        assert!(made2.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // dir 체인 **중간 실패**의 잔해도 기록되어 되돌아간다(감사 Y1의 나머지 절반).
    // 옛 구현은 소유권을 create_dir_all **성공 후에만** 기록해서, 통짜 생성이
    // 앞 레벨만 만들고 실패하면 그 잔해가 아예 롤백 목록에 없었다.
    // 재현: 마지막 세그먼트를 파일명 길이 상한(255)보다 길게 → 앞 레벨(deep1)은
    // 만들어지고 그 다음이 ENAMETOOLONG으로 실패한다.
    #[test]
    fn create_files_rolls_back_partial_dir_chain() {
        let (root, root_s) = temp_root("cfs_chain");
        let too_long = "z".repeat(300);
        let target = format!("{root_s}/deep1/{too_long}/f.ts");
        let e = create_files(vec![target], root_s).unwrap_err();
        assert!(!e.message.is_empty());
        assert!(
            !root.join("deep1").exists(),
            "체인 중간까지 만들어진 dir도 되돌린다 (옛 구현은 여기서 잔해가 남았다)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // 되돌리기 실패는 삼키되 **보이게** 한다 (감사 Y2) — 잔존 목록이 원 오류
    // 뒤에 붙는다. (실제 remove 실패는 외부 개입 없이 재현할 수 없어, 가시화
    // 계약 자체를 조립 지점에서 검증한다.)
    #[test]
    fn create_error_surfaces_leftovers() {
        let clean = create_error("Cannot create file: I/O error".into(), vec![]);
        assert_eq!(clean.message, "Cannot create file: I/O error");
        let dirty = create_error(
            "Cannot create file: I/O error".into(),
            vec!["sub/a.ts".into(), "sub".into()],
        );
        assert!(dirty.message.starts_with("Cannot create file: I/O error"));
        assert!(dirty.message.contains("일부 항목 정리 실패: sub/a.ts, sub"), "{}", dirty.message);
    }

    fn temp_root(tag: &str) -> (std::path::PathBuf, String) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt_dnd_{tag}_{}_{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        let root = std::fs::canonicalize(&d).unwrap();
        let s = root.to_string_lossy().to_string();
        (root, s)
    }

    // 명세 load-bearing 가정 2: 디렉토리 이동도 rename_path(fs::rename)로 된다.
    #[test]
    fn rename_path_moves_directory_tree() {
        let (root, root_s) = temp_root("mvdir");
        std::fs::create_dir_all(root.join("a/sub")).unwrap();
        std::fs::write(root.join("a/sub/f.txt"), "F").unwrap();
        std::fs::create_dir_all(root.join("dest")).unwrap();
        assert!(rename_path(
            format!("{root_s}/a"),
            format!("{root_s}/dest/a"),
            root_s.clone()
        )
        .is_ok());
        assert_eq!(std::fs::read_to_string(root.join("dest/a/sub/f.txt")).unwrap(), "F");
        assert!(!root.join("a").exists(), "원본 위치는 비워짐");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_path_recursive_with_symlink_and_guards() {
        let (root, root_s) = temp_root("copy");
        // src/: file + nested dir + symlink
        std::fs::create_dir_all(root.join("src/sub")).unwrap();
        std::fs::write(root.join("src/a.txt"), "A").unwrap();
        std::fs::write(root.join("src/sub/b.txt"), "B").unwrap();
        std::os::unix::fs::symlink("a.txt", root.join("src/link")).unwrap();

        let from = format!("{root_s}/src");
        let to = format!("{root_s}/dst");
        assert!(copy_path_blocking(from.clone(), to.clone(), root_s.clone()).is_ok());
        assert_eq!(std::fs::read_to_string(root.join("dst/a.txt")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(root.join("dst/sub/b.txt")).unwrap(), "B");
        // 심링크는 링크로 복사(내용 복제 아님).
        assert!(std::fs::symlink_metadata(root.join("dst/link")).unwrap().file_type().is_symlink());
        // 원본 보존.
        assert!(root.join("src/a.txt").is_file());

        // no-clobber: 대상 존재 시 거부.
        assert!(copy_path_blocking(from.clone(), to, root_s.clone()).is_err());
        // 자기 하위로 복사 거부.
        assert!(copy_path_blocking(from.clone(), format!("{root_s}/src/sub/x"), root_s.clone()).is_err());
        // 프로젝트 밖 대상 거부.
        assert!(copy_path_blocking(from, "/tmp/mt_outside_dnd".into(), root_s).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_copies_external_conflicts_and_overwrite() {
        let (root, root_s) = temp_root("import");
        // 외부(프로젝트 밖) 소스 폴더.
        let (ext, _) = temp_root("import_ext");
        std::fs::write(ext.join("in.txt"), "external").unwrap();
        std::fs::create_dir_all(ext.join("d")).unwrap();
        std::fs::write(ext.join("d/n.txt"), "N").unwrap();

        let dest = format!("{root_s}");
        let srcs = vec![
            ext.join("in.txt").to_string_lossy().to_string(),
            ext.join("d").to_string_lossy().to_string(),
        ];
        let out = import_paths_blocking(srcs.clone(), dest.clone(), root_s.clone(), false).unwrap();
        assert_eq!(out.copied.len(), 2);
        assert!(out.conflicts.is_empty() && out.errors.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "external");
        assert_eq!(std::fs::read_to_string(root.join("d/n.txt")).unwrap(), "N");
        // 원본 보존(복사만).
        assert!(ext.join("in.txt").is_file());

        // 재반입: 충돌로 분류(무음 덮어쓰기 없음).
        std::fs::write(ext.join("in.txt"), "changed").unwrap();
        let out2 = import_paths_blocking(srcs.clone(), dest.clone(), root_s.clone(), false).unwrap();
        assert_eq!(out2.conflicts.len(), 2);
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "external", "충돌 시 미변경");

        // overwrite=true → 교체.
        let out3 = import_paths_blocking(srcs, dest, root_s.clone(), true).unwrap();
        assert_eq!(out3.copied.len(), 2);
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "changed");

        // dest containment: 프로젝트 밖 dest 거부.
        assert!(import_paths_blocking(vec![], "/tmp".into(), root_s, false).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&ext);
    }

    // 리뷰 D1(critical): 소스==대상(같은 폴더 재반입)은 overwrite여도 원본을
    // 지우지 않는다 — 즉시 오류 분류.
    #[test]
    fn import_same_path_never_deletes_source() {
        let (root, root_s) = temp_root("selfimp");
        std::fs::write(root.join("f.txt"), "KEEP").unwrap();
        let src = root.join("f.txt").to_string_lossy().to_string();
        for ow in [false, true] {
            let out = import_paths_blocking(vec![src.clone()], root_s.clone(), root_s.clone(), ow).unwrap();
            assert!(out.copied.is_empty() && out.conflicts.is_empty());
            assert_eq!(out.errors.len(), 1, "즉시 오류 분류 (overwrite={ow})");
            assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "KEEP");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // 리뷰 D1 확장: 대상이 원본을 담고 있는 조상이면 overwrite 삭제가 원본을
    // 파괴한다 — 거부. 재현: 이름이 "d"인 심링크 소스가 root/d/deep을 가리키면
    // dest(root/d)는 소스 canonical(root/d/deep)의 조상이 된다.
    #[test]
    fn import_ancestor_overwrite_rejected() {
        let (root, root_s) = temp_root("ancimp");
        std::fs::create_dir_all(root.join("d/deep")).unwrap();
        std::fs::write(root.join("d/deep/s.txt"), "S").unwrap();
        let (ext, _) = temp_root("ancimp_ext");
        std::os::unix::fs::symlink(root.join("d/deep"), ext.join("d")).unwrap();
        let src = ext.join("d").to_string_lossy().to_string();
        let out = import_paths_blocking(vec![src], root_s.clone(), root_s.clone(), true).unwrap();
        assert_eq!(out.errors.len(), 1, "조상 덮어쓰기 거부: {:?}", out.errors);
        assert_eq!(
            std::fs::read_to_string(root.join("d/deep/s.txt")).unwrap(),
            "S",
            "원본 트리 보존"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&ext);
    }

    // 리뷰 D4: root 안 심링크 별칭 경유의 자기 하위 복사도 거부된다.
    #[test]
    fn copy_into_own_subtree_via_symlink_alias_rejected() {
        let (root, root_s) = temp_root("alias");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/f.txt"), "F").unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("link")).unwrap();
        // lexical로는 /link/sub ⊄ /src 지만 실효 경로는 /src/sub — 거부돼야 한다.
        let err = copy_path_blocking(
            format!("{root_s}/src"),
            format!("{root_s}/link/sub"),
            root_s.clone(),
        );
        assert!(err.is_err(), "별칭 경유 자기 하위 복사 거부");
        assert!(!root.join("src/sub").exists(), "자기복제 잔해 없음");
        let _ = std::fs::remove_dir_all(&root);
    }

    // 리뷰 D5: 빈 소스도 무음 스킵이 아니라 errors로 분류.
    #[test]
    fn import_empty_source_is_classified() {
        let (root, root_s) = temp_root("empty");
        let out = import_paths_blocking(vec!["  ".into()], root_s.clone(), root_s, false).unwrap();
        assert_eq!(out.errors.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    // 리뷰 D3: 재귀 복사 중간 실패 시 대상 위치에 부분 잔해가 남지 않는다.
    #[test]
    #[cfg(unix)]
    fn copy_partial_failure_leaves_no_debris() {
        use std::os::unix::fs::PermissionsExt;
        let (root, root_s) = temp_root("debris");
        std::fs::create_dir_all(root.join("src/sub")).unwrap();
        std::fs::write(root.join("src/a.txt"), "A").unwrap();
        std::fs::write(root.join("src/sub/locked.txt"), "L").unwrap();
        // 읽기 불가 파일 → fs::copy 실패 유도.
        std::fs::set_permissions(root.join("src/sub/locked.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(root.join("src/sub/locked.txt")).is_ok() {
            return; // root 권한 등으로 실패 유도가 안 되는 환경 — 스킵
        }
        let res = copy_path_blocking(format!("{root_s}/src"), format!("{root_s}/dst"), root_s.clone());
        assert!(res.is_err(), "부분 실패는 오류로 드러남");
        assert!(!root.join("dst").exists(), "최종 위치에 부분 잔해 없음");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".mt-copy-"))
            .collect();
        assert!(leftovers.is_empty(), "temp 잔해도 정리됨");
        let _ = std::fs::set_permissions(root.join("src/sub/locked.txt"), std::fs::Permissions::from_mode(0o644));
        let _ = std::fs::remove_dir_all(&root);
    }
}
