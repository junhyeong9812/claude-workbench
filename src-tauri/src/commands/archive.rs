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
use tauri::{AppHandle, Emitter, Manager};

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
/// paths (post-fix P4). Release also broadcasts `mt-archive-finished` to every
/// window (진행중 배지 해제) — in Drop so the dropped-future path clears the
/// badge too, not only normal returns.
struct InFlightGuard {
    key: String,
    cwd: String,
    app: AppHandle,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = in_flight().lock() {
            set.remove(&self.key);
        }
        let _ = self
            .app
            .emit("mt-archive-finished", serde_json::json!({ "project": self.cwd }));
    }
}

/// The archive-extraction model/effort: workspace settings when set, else the
/// app default **opus + xhigh** (사용자 결정 — 추출 품질 우선).
fn extraction_opts(app: &AppHandle) -> ClaudeOpts {
    let ws = super::files::load_state(app.clone());
    ClaudeOpts {
        model: Some(ws.archive_model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "opus".into())),
        effort: Some(ws.archive_effort.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "xhigh".into())),
        ..Default::default()
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
    /// The transcript hasn't changed since the last (complete) archive — the
    /// existing archive was kept as-is and extraction was skipped entirely.
    pub unchanged: bool,
}

/// The effective archive root: the workspace-configured directory when set and
/// non-blank, else `<app_data_dir>/archive`. `pub(super)` so sibling command
/// modules (e.g. the graph viewer) resolve the identical root — single source.
pub(super) fn archive_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let configured = super::files::load_state(app.clone()).archive_root;
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
    let key = core_lib::pathguard::canonical_key(&cwd);
    {
        let mut set = in_flight()
            .lock()
            .map_err(|_| AppError::new("Archive state unavailable"))?;
        if !set.insert(key.clone()) {
            return Err(AppError::new("이 프로젝트는 이미 아카이브 진행 중입니다"));
        }
    }
    let _guard = InFlightGuard {
        key,
        cwd: cwd.clone(),
        app: app.clone(),
    };
    let _ = app.emit("mt-archive-started", serde_json::json!({ "project": cwd }));
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || archive_session_blocking(app2, cwd, uuid))
        .await
        .map_err(|_| AppError::new("Archive task failed to run"))?
}

/// Whether an archive of `project` is currently running — the picker's
/// "아카이브 진행중" badge on open (events cover changes after that).
/// Infallible: any doubt reads as "not in flight" (배지는 정보성).
#[tauri::command]
pub fn archive_in_flight(project: String) -> bool {
    let key = core_lib::pathguard::canonical_key(&project);
    in_flight().lock().map(|s| s.contains(&key)).unwrap_or(false)
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
    // Fallback title until extraction supplies one: the `.title` sidecar, else
    // the display name — the archive folder slug derives from it.
    let fallback_title = core_lib::snapshot::read_title(&base, &cwd, &uuid)
        .or_else(|| core_lib::snapshot::read_name(&base, &cwd, &uuid))
        .unwrap_or_else(|| "Claude".to_string());
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let root = archive_root(&app)?;
    // 서버 바이너리는 앱 실행 파일 옆(knowledge-mcp) — dev(target/…)와 설치본
    // 모두 같은 규약.
    let mcp_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("knowledge-mcp")));

    // 파이프라인 본체는 core::archive 단일 출처 — CLI 백필(archive_backfill)과
    // 같은 코드가 같은 산출물·같은 `.extraction-ok` 계약을 만든다. GUI는 추출
    // 재시도 없이 1회 (사용자가 다시 누르는 것이 재시도).
    let opts = extraction_opts(&app);
    let extract = core_lib::archive::claude_extractor(&opts, Duration::from_secs(300));
    let run = core_lib::archive::run_archive(
        &core_lib::archive::ArchiveRequest {
            archive_root: &root,
            project: &cwd,
            uuid: &uuid,
            fallback_title: &fallback_title,
            date: &date,
            jsonl_bytes: &jsonl_bytes,
            mcp_bin: mcp_bin.as_deref(),
            attempts: 1,
        },
        &extract,
    )
    .map_err(|e| match e {
        core_lib::archive::ArchiveError::NoTurns => AppError::new("아카이브할 대화가 없습니다"),
        core_lib::archive::ArchiveError::Write(e) => {
            AppError::new(io_message("Cannot write archive", &e))
        }
    })?;

    // GUI 보고 표면은 **errors만** — notes(mcp 등록 실패 등 부가 작업)는 CLI
    // 로그 전용이다(리뷰: 성공/부가 note가 '추출 경고'로 오노출되던 것 차단).
    let warnings: Vec<&str> = run.errors.iter().map(String::as_str).collect();
    Ok(ArchiveResult {
        dir: run.dir.to_string_lossy().to_string(),
        book_path: run.book_path.to_string_lossy().to_string(),
        replaced: run.replaced,
        summary_ok: run.summary_ok,
        knowledge_files: run.knowledge_files,
        extraction_error: (!warnings.is_empty()).then(|| warnings.join(" / ")),
        unchanged: run.unchanged,
    })
}

/// One preserved past version of an archived session (browser pane).
#[derive(Serialize)]
pub struct ArchiveHistoryItem {
    pub book_path: String,
    pub archived_at: Option<u64>,
    pub title: String,
    pub turns: usize,
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
    pub archived_at: Option<u64>,
    /// Preserved past versions, newest first.
    pub history: Vec<ArchiveHistoryItem>,
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
                    archived_at: s.meta.archived_at,
                    history: s
                        .history
                        .into_iter()
                        .map(|h| ArchiveHistoryItem {
                            book_path: path_s(h.book_path),
                            archived_at: h.archived_at,
                            title: h.title,
                            turns: h.turns,
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect())
}

/// Ensure the knowledge MCP server is registered in `project`'s `.mcp.json`
/// when that project has archived knowledge — called right before a Claude PTY
/// spawns (the CLI reads `.mcp.json` only at session start, so this is the
/// moment that makes the server "그냥 있음"). Best-effort: any failure (no
/// knowledge, no binary, foreign entry, corrupt file) must never block the
/// session from opening.
pub(super) fn ensure_mcp_registration(app: &AppHandle, project: &str) {
    let Ok(root) = archive_root(app) else { return };
    let kdir = core_lib::knowledge::knowledge_dir(&root, project);
    if !kdir.is_dir() {
        return;
    }
    let proj = std::path::Path::new(project);
    if !proj.is_dir() {
        return;
    }
    let Some(bin) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("knowledge-mcp")))
    else {
        return;
    };
    if !bin.is_file() {
        return;
    }
    let _ = core_lib::mcp::register_in_mcp_json(proj, &bin, &kdir);
}

/// Per-archived-session freshness for one project — the picker groups saved
/// sessions into 아카이브됨(최신)/아카이브 이후 작업/아카이브 없음 with this.
#[derive(Serialize)]
pub struct ArchiveStatusEntry {
    pub uuid: String,
    /// The live transcript matches the archived snapshot (byte length — the
    /// transcript is append-only, so growth is the change mode). A session
    /// whose live transcript no longer exists counts as up-to-date: the
    /// archive holds everything there is.
    pub up_to_date: bool,
    pub archived_at: Option<u64>,
    /// Preserved past versions of this session's archive.
    pub versions: usize,
}

/// The archived sessions of one project + whether each is still current.
/// Lazily backfills pre-upgrade metas first (아카이브된 session.jsonl 파싱 —
/// 멱등, 재추출 없음), so 판별불가 states don't linger. Infallible (empty on
/// any failure); the grouping is informational, never load-bearing. Runs on
/// the blocking pool — the first backfill may parse many stored transcripts.
#[tauri::command]
pub async fn archive_status(app: AppHandle, project: String) -> Vec<ArchiveStatusEntry> {
    let Ok(root) = archive_root(&app) else {
        return vec![];
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (candidates, filled) = core_lib::archive::backfill_meta(&root);
        if filled < candidates {
            // GUI에선 stderr가 최선의 관찰 창구(기존 관습) — 멱등이라 다음
            // 조회가 재시도한다.
            eprintln!("[archive] meta 백필 부분 실패: {filled}/{candidates}");
        }
        let projects_root = core_lib::jsonl::claude_projects_root();
        core_lib::archive::list_archives(&root)
            .into_iter()
            .filter(|p| p.project == project)
            .flat_map(|p| p.sessions)
            .map(|s| {
                let archived = core_lib::archive::archived_stat(&s.dir, &s.meta);
                let live = projects_root
                    .as_deref()
                    .and_then(|pr| core_lib::jsonl::find_session_jsonl(pr, &s.meta.uuid).ok().flatten());
                // spec §2 판별식: 마지막 메시지 uuid 일치 = 최신 — 단, uuid
                // 없는 레코드만 append돼 자란 경우를 놓치지 않도록 바이트
                // 길이도 함께 요구한다(post-fix P1). uuid를 어느 쪽이든 얻지
                // 못한 전사는 바이트 길이만으로 보수 폴백(명시적 fail-soft).
                let up_to_date = match (&archived, &live) {
                    (Some(a), Some(path)) => {
                        let same_len =
                            std::fs::metadata(path).map(|m| m.len()).ok() == Some(a.bytes);
                        match (core_lib::archive::tail_last_uuid(path), &a.last_uuid) {
                            (Some(l), Some(m)) => l == *m && same_len,
                            _ => same_len,
                        }
                    }
                    // 라이브 트랜스크립트 없음(삭제) → 아카이브가 전부.
                    (_, None) => true,
                    // 스냅샷 판독 불가 → 최신을 보장할 수 없음 (재아카이브 유도).
                    (None, Some(_)) => false,
                };
                ArchiveStatusEntry {
                    uuid: s.meta.uuid,
                    up_to_date,
                    archived_at: s.meta.archived_at,
                    versions: s.history.len(),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Open an archived artifact (book.html, a knowledge file, …) with the system
/// handler. Confined to the archive root — canonicalized containment check, so
/// the renderer can't turn this into an arbitrary-file opener.
#[tauri::command]
pub fn archive_open_path(app: AppHandle, path: String) -> Result<(), AppError> {
    let root = archive_root(&app)?;
    // 봉쇄 알고리즘은 core::pathguard 단일 출처(P4 — graph contained_target와
    // 문자단위 동일하던 인라인 제거, 문구는 도메인 소유 유지).
    use core_lib::pathguard::ContainErr;
    let target = core_lib::pathguard::contained_existing(&root, &path).map_err(|e| {
        AppError::new(match e {
            ContainErr::Root => "아카이브 폴더를 확인할 수 없습니다",
            ContainErr::Path => "경로를 확인할 수 없습니다",
            ContainErr::Outside => "아카이브 밖 경로는 열 수 없습니다",
        })
    })?;
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|_| AppError::new("시스템 뷰어를 열 수 없습니다"))
}

