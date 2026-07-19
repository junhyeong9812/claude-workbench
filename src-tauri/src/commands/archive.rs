// ---- Session archive (관찰 → 아카이브 전환) ----
//
// "종료(아카이브)" copies the session's JSONL transcript verbatim, normalizes it
// into a versioned JSON document, and renders a self-contained book.html — all
// under the archive root (workspace-configurable, default <app_data_dir>/archive).
// A one-shot `claude -p` then extracts the session title, a summary, and typed
// knowledge entries (issue/method/domain). Extraction is **best-effort**: its
// failure never fails the archive itself (partial success — the transcript copy,
// normalized.json and book.html always land first). The source transcript under
// ~/.claude/projects is read, never modified.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use core_lib::claude_cli::ClaudeOpts;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{io_message, AppError};

/// Projects with an archive currently in flight. All windows share this process,
/// so an in-process set fully serializes concurrent "아카이브" runs per project —
/// keyed by project (not session), because two sessions of one project share the
/// same knowledge files + INDEX.md rebuild (감사 A9).
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII release of an in-flight key — dropping the command future (window
/// closed mid-await) must release the slot too, not just the normal return
/// paths (post-fix P4).
struct InFlightGuard {
    key: String,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = in_flight().lock() {
            set.remove(&self.key);
        }
    }
}

/// The archive-extraction model/effort: workspace settings when set, else the
/// app default **opus + xhigh** (사용자 결정 — 추출 품질 우선).
fn extraction_opts(app: &AppHandle) -> ClaudeOpts {
    let ws = super::load_state(app.clone());
    ClaudeOpts {
        model: Some(ws.archive_model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "opus".into())),
        effort: Some(ws.archive_effort.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "xhigh".into())),
    }
}

/// Where an archive landed, for the UI to confirm/open.
#[derive(Serialize)]
pub struct ArchiveResult {
    pub dir: String,
    pub book_path: String,
    /// Whether a previous archive of this session was replaced (re-archive).
    pub replaced: bool,
    /// Whether the claude extraction produced a summary.md.
    pub summary_ok: bool,
    /// Knowledge files written (issue/method/domain).
    pub knowledge_files: usize,
    /// Why extraction was skipped/failed, when it was (archive itself still ok).
    pub extraction_error: Option<String>,
}

/// The effective archive root: the workspace-configured directory when set and
/// non-blank, else `<app_data_dir>/archive`.
fn archive_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let configured = super::load_state(app.clone()).archive_root;
    if let Some(root) = configured {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("archive"))
        .map_err(|_| AppError::new("Cannot resolve app data directory"))
}

/// Archive session `uuid` (rooted at `cwd`): read its JSONL fresh, normalize,
/// and write `session.jsonl` + `normalized.json` + `book.html` under the archive
/// root. Blocking work (file IO + full-transcript parse) runs on the blocking
/// pool so the webview stays responsive.
#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<ArchiveResult, AppError> {
    // Canonical project identity, so `.`/trailing-slash/symlink aliases of the
    // same project can't slip past the guard (post-fix P4).
    let key = std::fs::canonicalize(&cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| cwd.clone());
    {
        let mut set = in_flight()
            .lock()
            .map_err(|_| AppError::new("Archive state unavailable"))?;
        if !set.insert(key.clone()) {
            return Err(AppError::new("이 프로젝트는 이미 아카이브 진행 중입니다"));
        }
    }
    let _guard = InFlightGuard { key };
    tauri::async_runtime::spawn_blocking(move || archive_session_blocking(app, cwd, uuid))
        .await
        .map_err(|_| AppError::new("Archive task failed to run"))?
}

fn archive_session_blocking(
    app: AppHandle,
    cwd: String,
    uuid: String,
) -> Result<ArchiveResult, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    let projects_root = core_lib::jsonl::claude_projects_root()
        .ok_or_else(|| AppError::new("Cannot resolve Claude projects root"))?;
    let jsonl_path = core_lib::jsonl::find_session_jsonl(&projects_root, &uuid)
        .ok()
        .flatten()
        .ok_or_else(|| AppError::new("Session transcript not found"))?;
    let jsonl_bytes = std::fs::read(&jsonl_path)
        .map_err(|e| AppError::new(io_message("Cannot read transcript", &e)))?;
    let jsonl_text = String::from_utf8_lossy(&jsonl_bytes);

    // Fallback title until extraction supplies one: the `.title` sidecar, else
    // the display name — the archive folder slug derives from it.
    let fallback_title = core_lib::snapshot::read_title(&base, &cwd, &uuid)
        .or_else(|| core_lib::snapshot::read_name(&base, &cwd, &uuid))
        .unwrap_or_else(|| "Claude".to_string());
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();

    let mut session = core_lib::archive::normalize(&cwd, &uuid, &fallback_title, &date, &jsonl_text);
    if session.turns.is_empty() {
        return Err(AppError::new("아카이브할 대화가 없습니다"));
    }

    let root = archive_root(&app)?;

    // Last-good summary of a previous archive of this session — read BEFORE the
    // first write below displaces that folder (감사 A1: 지식만 남고 요약만
    // 사라지는 비대칭 방지). A read failure is reported, not swallowed.
    let mut errors: Vec<String> = Vec::new();
    let prev_summary = core_lib::archive::list_archives(&root)
        .into_iter()
        .flat_map(|p| p.sessions)
        .find(|s| s.meta.uuid == uuid)
        .and_then(|s| s.summary_path)
        .and_then(|p| match std::fs::read_to_string(&p) {
            Ok(text) => Some(text),
            Err(e) => {
                errors.push(io_message("Cannot read previous summary", &e));
                None
            }
        });

    // 1) The core archive lands FIRST, under the fallback title — an app quit or
    // crash during the (up to 3-minute) extraction below must never cost the
    // transcript copy + book (감사 A11 — "부분 성공은 먼저 남아야 성립").
    let mut out = core_lib::archive::write_archive(&root, &cwd, &session, &jsonl_bytes)
        .map_err(|e| AppError::new(io_message("Cannot write archive", &e)))?;
    let replaced = out.replaced;
    // The last-good summary goes to disk NOW — held only in memory, a crash
    // during extraction would lose it for good (post-fix P3). A fresh summary
    // below simply overwrites it.
    if let Some(prev) = &prev_summary {
        if let Err(e) = std::fs::write(out.dir.join("summary.md"), prev) {
            errors.push(io_message("Cannot keep previous summary", &e));
        }
    }

    // 2) Extraction (title + summary + knowledge) — best-effort. Failures merge
    // into reported errors (neither masks the other), never a failed archive.
    let mut extraction = None;
    let rendered = core_lib::knowledge::render_session_for_extraction(&session);
    let opts = extraction_opts(&app);
    match core_lib::claude_cli::run_claude_p(
        &cwd,
        &extraction_prompt(&rendered),
        Duration::from_secs(300),
        &opts,
    ) {
        Ok(raw) => extraction = Some(core_lib::knowledge::parse_extraction(&raw)),
        Err(e) => errors.push(e),
    }

    let mut summary_ok = false;
    let mut knowledge_files = 0;
    if let Some(ex) = extraction {
        // Extracted title → re-land the archive under it. write_archive is
        // idempotent per uuid, so this just replaces our own fallback folder.
        let new_title = ex.title.trim();
        if !new_title.is_empty() && new_title != session.title {
            session.title = new_title.to_string();
            match core_lib::archive::write_archive(&root, &cwd, &session, &jsonl_bytes) {
                Ok(o) => out = o,
                Err(e) => errors.push(io_message("Cannot retitle archive", &e)),
            }
        }
        if !ex.summary.trim().is_empty() {
            match std::fs::write(out.dir.join("summary.md"), &ex.summary) {
                Ok(()) => summary_ok = true,
                Err(e) => errors.push(io_message("Cannot save summary", &e)),
            }
        }
        match core_lib::knowledge::write_knowledge(&root, &cwd, &uuid, &date, &ex.entries) {
            Ok(paths) => knowledge_files = paths.len(),
            Err(e) => errors.push(io_message("Cannot save knowledge", &e)),
        }
    }
    // 3) No fresh summary → keep the previous archive's (last-good), mirroring
    // how knowledge entries persist when extraction fails. (Re-written here
    // because a retitle re-land above replaced the folder the early copy was
    // in.) A restore failure is reported like any other (post-fix P6).
    if !summary_ok {
        if let Some(prev) = prev_summary {
            match std::fs::write(out.dir.join("summary.md"), prev) {
                Ok(()) => {
                    summary_ok = true;
                    errors.push("요약은 이전 아카이브분을 유지".to_string());
                }
                Err(e) => errors.push(io_message("Cannot keep previous summary", &e)),
            }
        }
    }
    let extraction_error = if errors.is_empty() {
        None
    } else {
        Some(errors.join(" / "))
    };

    Ok(ArchiveResult {
        dir: out.dir.to_string_lossy().to_string(),
        book_path: out.book_path.to_string_lossy().to_string(),
        // The FIRST write's verdict — the retitle re-land always "replaces" the
        // fallback folder it just made, which is not a user-meaningful replace
        // (post-fix P7).
        replaced,
        summary_ok,
        knowledge_files,
        extraction_error,
    })
}

/// One archived session for the browser pane.
#[derive(Serialize)]
pub struct ArchiveListEntry {
    pub dir: String,
    pub book_path: String,
    pub summary_path: Option<String>,
    pub uuid: String,
    pub title: String,
    pub date: String,
    pub turns: usize,
}

/// One project's archived sessions + its knowledge index.
#[derive(Serialize)]
pub struct ArchiveProjectGroup {
    pub project: String,
    pub index_path: Option<String>,
    pub sessions: Vec<ArchiveListEntry>,
}

/// List every archived session, grouped by project (newest first within each).
/// Never fails — an empty archive is an empty list.
#[tauri::command]
pub fn archive_list(app: AppHandle) -> Result<Vec<ArchiveProjectGroup>, AppError> {
    let root = archive_root(&app)?;
    // An absent root is a real empty archive; an *unreadable* existing root
    // (permissions) or a root that isn't a directory (misconfigured setting)
    // must surface, not render as "no archives" (리뷰 K5, post-fix).
    if root.exists() {
        if !root.is_dir() {
            return Err(AppError::new("아카이브 경로가 폴더가 아닙니다"));
        }
        std::fs::read_dir(&root)
            .map_err(|e| AppError::new(io_message("Cannot read archive", &e)))?;
    }
    let path_s = |p: PathBuf| p.to_string_lossy().to_string();
    Ok(core_lib::archive::list_archives(&root)
        .into_iter()
        .map(|proj| ArchiveProjectGroup {
            project: proj.project,
            index_path: proj.index_path.map(path_s),
            sessions: proj
                .sessions
                .into_iter()
                .map(|s| ArchiveListEntry {
                    dir: path_s(s.dir),
                    book_path: path_s(s.book_path),
                    summary_path: s.summary_path.map(path_s),
                    uuid: s.meta.uuid,
                    title: s.meta.title,
                    date: s.meta.date,
                    turns: s.meta.turns,
                })
                .collect(),
        })
        .collect())
}

/// The archived session uuids of one project — the picker marks saved sessions
/// as 아카이브됨/미아카이브 with this set. Infallible (empty on any failure);
/// the badge is informational, never load-bearing.
#[tauri::command]
pub fn archive_uuids(app: AppHandle, project: String) -> Vec<String> {
    let Ok(root) = archive_root(&app) else {
        return vec![];
    };
    core_lib::archive::list_archives(&root)
        .into_iter()
        .filter(|p| p.project == project)
        .flat_map(|p| p.sessions)
        .map(|s| s.meta.uuid)
        .collect()
}

/// Open an archived artifact (book.html, a knowledge file, …) with the system
/// handler. Confined to the archive root — canonicalized containment check, so
/// the renderer can't turn this into an arbitrary-file opener.
#[tauri::command]
pub fn archive_open_path(app: AppHandle, path: String) -> Result<(), AppError> {
    let root = archive_root(&app)?;
    let root_c = std::fs::canonicalize(&root)
        .map_err(|_| AppError::new("아카이브 폴더를 확인할 수 없습니다"))?;
    let target = std::fs::canonicalize(&path)
        .map_err(|_| AppError::new("경로를 확인할 수 없습니다"))?;
    if !target.starts_with(&root_c) {
        return Err(AppError::new("아카이브 밖 경로는 열 수 없습니다"));
    }
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|_| AppError::new("시스템 뷰어를 열 수 없습니다"))
}

/// The fixed extraction contract. Output format is pinned hard (markers + fixed
/// keys) because `core_lib::knowledge::parse_extraction` parses it; entries the
/// model emits off-format are skipped there, never fatal.
fn extraction_prompt(rendered: &str) -> String {
    format!(
        "다음은 끝난 Claude 코딩 세션의 타임라인이다. 이 세션을 아카이브하기 위해 (1) 제목+요약과 \
(2) 지식 항목들을 추출하라.\n\n\
출력 형식 (마커·키를 정확히 지킬 것, 다른 텍스트 금지):\n\
===SUMMARY===\n\
TITLE: <이 세션이 무엇을 했는지 한 줄 (40자 이내)>\n\
<markdown 요약: (1) 목표와 한 일 (2) 핵심 변경 파일과 이유 (3) 미해결/다음 할 일>\n\n\
그 뒤, 추출할 가치가 있는 지식마다 (없으면 생략):\n\
===ENTRY===\n\
type: issue | method | domain\n\
title: <한 줄 — issue는 에러코드/원인을 제목으로>\n\
error_code: <있으면, issue만>\n\
problem: <해결한 문제 한 줄, method만>\n\
applies_when: <재사용 조건 한 줄, method/domain>\n\
status: resolved | open  (issue만)\n\
tags: [소문자, 쉼표, 구분]\n\
files: [관련 파일 경로]\n\
---\n\
<markdown 본문 — issue: ## 증상(에러 원문 그대로) / ## 원인 / ## 해결 / ## 실패한 시도 / ## 재발 방지. \
method: ## 상황 / ## 검토한 선택지 / ## 선택한 방법과 이유 / ## 결과 / ## 재사용 조건. \
domain: ## 개념 / ## 상세 / ## 적용 맥락>\n\n\
규칙: 이 세션에서 실제 발생·확인한 것만. 에러 메시지는 원문 보존(나중에 grep 대상). \
사소한 오타 수정 따위는 항목으로 만들지 말 것. 항목 0개도 정상.\n\n\
{rendered}"
    )
}
