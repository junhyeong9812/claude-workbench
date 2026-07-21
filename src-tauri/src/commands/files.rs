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
    let root_c = std::fs::canonicalize(root)
        .map_err(|_| AppError::new("프로젝트 경로를 확인할 수 없습니다"))?;
    let mut probe = std::path::PathBuf::from(path);
    let resolved = loop {
        match std::fs::canonicalize(&probe) {
            Ok(c) => break c,
            Err(_) => match probe.parent() {
                Some(parent) if parent != probe => probe = parent.to_path_buf(),
                _ => return Err(AppError::new("경로를 확인할 수 없습니다")),
            },
        }
    };
    if resolved.starts_with(&root_c) {
        Ok(())
    } else {
        Err(AppError::new("프로젝트 밖 경로는 허용되지 않습니다"))
    }
}

#[tauri::command]
pub fn delete_path(path: String, root: Option<String>) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    // The file-tree caller pins deletes to the project root; legacy callers
    // (study tree) omit it and keep the prior behavior.
    if let Some(r) = root.as_deref() {
        ensure_within(&path, r)?;
    }
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
#[tauri::command]
pub fn create_file(path: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&path)?;
    ensure_within(&path, &root)?;
    let p = std::path::Path::new(&path);
    if std::fs::symlink_metadata(p).is_ok() {
        return Err(AppError::new("이미 존재하는 경로입니다"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot create file", &e)))?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p)
        .map(|_| ())
        .map_err(|e| AppError::new(io_message("Cannot create file", &e)))
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

/// Copy one filesystem node (file / dir tree / symlink) from `from` to `to`.
/// - 디렉토리는 재귀 복사, 심링크는 **링크 그대로** 재생성(대상 내용 복제 X —
///   링크 루프로 인한 무한 재귀·프로젝트 밖 내용 복제 방지).
/// - `to`는 존재하지 않아야 한다(호출측 no-clobber 검사 전제).
fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
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
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// Copy `from` to `to` (tree DnD "Ctrl 복사"). Both must live inside `root`;
/// `to` must not exist (덮어쓰기는 UI가 확인 후 삭제→복사 2단계로 수행). A dir
/// cannot be copied into itself/its own subtree — 무한 재귀·자기복제 방지.
#[tauri::command]
pub fn copy_path(from: String, to: String, root: String) -> Result<(), AppError> {
    reject_unsafe_path(&from)?;
    reject_unsafe_path(&to)?;
    ensure_within(&from, &root)?;
    ensure_within(&to, &root)?;
    let from_p = std::path::Path::new(&from);
    let to_p = std::path::Path::new(&to);
    if std::fs::symlink_metadata(from_p).is_err() {
        return Err(AppError::new("원본 경로가 없습니다"));
    }
    // `..` 없는 절대 경로 전제(위 가드)라 component 단위 starts_with로 충분.
    if to_p.starts_with(from_p) {
        return Err(AppError::new("자기 자신/하위로는 복사할 수 없습니다"));
    }
    if std::fs::symlink_metadata(to_p).is_ok() {
        return Err(AppError::new("대상 경로가 이미 존재합니다"));
    }
    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new(io_message("Cannot copy", &e)))?;
    }
    copy_tree(from_p, to_p).map_err(|e| AppError::new(io_message("Cannot copy", &e)))
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
/// 받은 것)을 삭제 후 복사한다.
#[tauri::command]
pub fn import_paths(
    sources: Vec<String>,
    dest_dir: String,
    root: String,
    overwrite: bool,
) -> Result<ImportOutcome, AppError> {
    reject_unsafe_path(&dest_dir)?;
    ensure_within(&dest_dir, &root)?;
    if !std::path::Path::new(&dest_dir).is_dir() {
        return Err(AppError::new("대상 폴더가 없습니다"));
    }
    let mut out = ImportOutcome {
        copied: vec![],
        conflicts: vec![],
        errors: vec![],
    };
    for src in sources {
        if src.trim().is_empty() {
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
        // dest가 소스 폴더 안이면(프로젝트를 소스 하위로 갖는 폴더를 드롭)
        // 자기 자신 안으로의 복제 — 무한 재귀 방지.
        if std::path::Path::new(&dest_dir).starts_with(src_p) {
            out.errors.push(format!("{src}: 자기 자신 안으로는 가져올 수 없습니다"));
            continue;
        }
        let dest = std::path::Path::new(&dest_dir).join(name);
        if std::fs::symlink_metadata(&dest).is_ok() {
            if overwrite {
                let md = std::fs::symlink_metadata(&dest).unwrap();
                let removed = if md.is_dir() {
                    std::fs::remove_dir_all(&dest)
                } else {
                    std::fs::remove_file(&dest)
                };
                if let Err(e) = removed {
                    out.errors.push(format!("{src}: {}", io_message("Cannot overwrite", &e)));
                    continue;
                }
            } else {
                out.conflicts.push(src);
                continue;
            }
        }
        match copy_tree(src_p, &dest) {
            Ok(()) => out.copied.push(src),
            Err(e) => out.errors.push(format!("{src}: {}", io_message("Cannot import", &e))),
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
        assert!(copy_path(from.clone(), to.clone(), root_s.clone()).is_ok());
        assert_eq!(std::fs::read_to_string(root.join("dst/a.txt")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(root.join("dst/sub/b.txt")).unwrap(), "B");
        // 심링크는 링크로 복사(내용 복제 아님).
        assert!(std::fs::symlink_metadata(root.join("dst/link")).unwrap().file_type().is_symlink());
        // 원본 보존.
        assert!(root.join("src/a.txt").is_file());

        // no-clobber: 대상 존재 시 거부.
        assert!(copy_path(from.clone(), to, root_s.clone()).is_err());
        // 자기 하위로 복사 거부.
        assert!(copy_path(from.clone(), format!("{root_s}/src/sub/x"), root_s.clone()).is_err());
        // 프로젝트 밖 대상 거부.
        assert!(copy_path(from, "/tmp/mt_outside_dnd".into(), root_s).is_err());
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
        let out = import_paths(srcs.clone(), dest.clone(), root_s.clone(), false).unwrap();
        assert_eq!(out.copied.len(), 2);
        assert!(out.conflicts.is_empty() && out.errors.is_empty());
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "external");
        assert_eq!(std::fs::read_to_string(root.join("d/n.txt")).unwrap(), "N");
        // 원본 보존(복사만).
        assert!(ext.join("in.txt").is_file());

        // 재반입: 충돌로 분류(무음 덮어쓰기 없음).
        std::fs::write(ext.join("in.txt"), "changed").unwrap();
        let out2 = import_paths(srcs.clone(), dest.clone(), root_s.clone(), false).unwrap();
        assert_eq!(out2.conflicts.len(), 2);
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "external", "충돌 시 미변경");

        // overwrite=true → 교체.
        let out3 = import_paths(srcs, dest, root_s.clone(), true).unwrap();
        assert_eq!(out3.copied.len(), 2);
        assert_eq!(std::fs::read_to_string(root.join("in.txt")).unwrap(), "changed");

        // dest containment: 프로젝트 밖 dest 거부.
        assert!(import_paths(vec![], "/tmp".into(), root_s, false).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&ext);
    }
}
