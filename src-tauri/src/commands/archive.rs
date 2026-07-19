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
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{io_message, AppError};

/// Sessions with an archive currently in flight. All windows share this process,
/// so an in-process set fully serializes concurrent "아카이브" clicks on the same
/// session (which would otherwise race the knowledge delete→write→INDEX cycle).
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Run a one-shot `claude -p --output-format text` in `cwd`, feeding `prompt` on
/// stdin and capturing stdout. Drains stdout/stderr on threads (so a full pipe
/// can't deadlock the child), enforces `timeout` with kill+wait (no zombie), caps
/// captured output, and treats only `exit 0 && non-empty stdout` as success
/// (codex P3 D7).
fn run_claude_p(cwd: &str, prompt: &str, timeout: Duration) -> Result<String, AppError> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    const CAP: usize = 256 * 1024;

    let mut child = Command::new("claude")
        .args(["-p", "--output-format", "text"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| AppError::new("Cannot start claude for summary"))?;

    // Feed the prompt and close stdin (EOF) on its own thread so a large prompt
    // can't deadlock against an unread stdout pipe.
    if let Some(mut stdin) = child.stdin.take() {
        let p = prompt.to_string();
        thread::spawn(move || {
            let _ = stdin.write_all(p.as_bytes());
            // `stdin` drops here -> EOF.
        });
    }

    // Drain stdout on its own thread, sending the captured (capped) bytes on a
    // channel so we collect with a *timeout* — never an unbounded `join`, which
    // could hang if a descendant of `claude` keeps the pipe open past the child's
    // own exit (codex P3-impl 3).
    let (otx, orx) = std::sync::mpsc::channel::<Vec<u8>>();
    if let Some(mut so) = child.stdout.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = so.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if buf.len() < CAP {
                    let take = n.min(CAP - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
            let _ = otx.send(buf);
        });
    }
    // Drain stderr to a sink (so a full stderr pipe can't block the child) and
    // discard it — error text isn't surfaced to the UI. Detached.
    if let Some(mut se) = child.stderr.take() {
        thread::spawn(move || {
            let mut sink = [0u8; 8192];
            while let Ok(n) = se.read(&mut sink) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    // Wait with a deadline; kill + reap on timeout.
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait(); // reap so we don't leave a zombie
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    match status {
        Some(st) if st.success() => {
            // Collect stdout with a bounded wait (the drain thread finishes as the
            // pipe closed on exit) — never block the command thread indefinitely.
            let stdout = orx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
            let text = String::from_utf8_lossy(&stdout).trim().to_string();
            if text.is_empty() {
                Err(AppError::new("Claude returned an empty summary"))
            } else {
                Ok(text)
            }
        }
        Some(_) => Err(AppError::new("Claude failed to produce a summary")),
        None => Err(AppError::new("Claude summary timed out")),
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
    {
        let mut set = in_flight()
            .lock()
            .map_err(|_| AppError::new("Archive state unavailable"))?;
        if !set.insert(uuid.clone()) {
            return Err(AppError::new("이 세션은 이미 아카이브 진행 중입니다"));
        }
    }
    let key = uuid.clone();
    let result = tauri::async_runtime::spawn_blocking(move || archive_session_blocking(app, cwd, uuid))
        .await
        .map_err(|_| AppError::new("Archive task failed to run"));
    if let Ok(mut set) = in_flight().lock() {
        set.remove(&key);
    }
    result?
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

    // Extraction (title + summary + knowledge) — best-effort, before the write
    // so the folder slug can use the extracted title.
    let mut extraction = None;
    let mut extraction_error = None;
    let rendered = core_lib::knowledge::render_session_for_extraction(&session);
    match run_claude_p(&cwd, &extraction_prompt(&rendered), Duration::from_secs(180)) {
        Ok(raw) => {
            let ex = core_lib::knowledge::parse_extraction(&raw);
            if !ex.title.trim().is_empty() {
                session.title = ex.title.trim().to_string();
            }
            extraction = Some(ex);
        }
        Err(e) => extraction_error = Some(e.message.clone()),
    }

    let root = archive_root(&app)?;
    let out = core_lib::archive::write_archive(&root, &cwd, &session, &jsonl_bytes)
        .map_err(|e| AppError::new(io_message("Cannot write archive", &e)))?;

    // Summary + knowledge land after the core archive; their failures downgrade
    // to reported extraction errors (merged, so neither masks the other), never
    // a failed archive.
    let mut summary_ok = false;
    let mut knowledge_files = 0;
    let mut errors: Vec<String> = extraction_error.into_iter().collect();
    if let Some(ex) = extraction {
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
    let extraction_error = if errors.is_empty() {
        None
    } else {
        Some(errors.join(" / "))
    };

    Ok(ArchiveResult {
        dir: out.dir.to_string_lossy().to_string(),
        book_path: out.book_path.to_string_lossy().to_string(),
        replaced: out.replaced,
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
    // (permissions) must surface, not render as "no archives" (리뷰 K5).
    if root.is_dir() {
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
