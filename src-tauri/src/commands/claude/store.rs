//! 저장 스냅샷·원문 detail·세션 CRUD 커맨드 — P5 B-c 분할. 절단은 IPC 반환
//! 경계만(P1 계약 — cap_content는 timeline 소유).

use core_lib::TimelineItem;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{io_message, AppError};

/// P1: 절단된 아이템의 원문 상세 payload (detail 커맨드 반환).
#[derive(Serialize)]
pub struct ItemDetail {
    pub content_text: Option<String>,
    pub raw_input: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn claude_item_detail(
    app: AppHandle,
    project: String,
    uuid: String,
    tool_call_id: String,
) -> Result<ItemDetail, AppError> {
    // 커맨드 경계에서 uuid를 명시 검증(#6) — 아래 경로 탐색(find_session_jsonl·
    // 서브에이전트 dir join)에 통제 밖 문자열이 들어가지 않게 한 줄로 막는다.
    if !core_lib::snapshot::is_safe_uuid(&uuid) {
        return Err(AppError::new("Invalid session id"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let detail_of = |it: &TimelineItem| ItemDetail {
            content_text: it.content_text.clone(),
            raw_input: it.raw_input.clone(),
        };
        // 1) 스냅샷 우선(#3·#20) — 디스크 본문은 전문이므로 대부분 여기서 끝난다
        //    (수 MB 파싱 1회, transcript 수십 MB 재파싱 회피). 구버전(절단 저장)
        //    스냅샷의 아이템은 content_truncated가 남아 있으므로 폴백으로 넘긴다.
        if let Ok(base) = app.path().app_data_dir() {
            if let Some(snap) = core_lib::snapshot::load(&base, &project, &uuid) {
                if let Some(it) = snap
                    .items
                    .iter()
                    .find(|i| i.tool_call_id == tool_call_id && !i.content_truncated)
                {
                    return Ok(detail_of(it));
                }
            }
        }
        // 2) 원본 JSONL 폴백 — 스냅샷 부재/미포함(서브에이전트 아이템 등).
        let root = core_lib::jsonl::claude_projects_root()
            .ok_or_else(|| AppError::new("Cannot locate the Claude projects root"))?;
        let jsonl = core_lib::jsonl::find_session_jsonl(&root, &uuid)
            .map_err(|e| AppError::new(io_message("Locate transcript", &e)))?
            .ok_or_else(|| AppError::new("Session transcript not found"))?;
        // 본 세션 transcript 전체 재파싱(온디맨드 1회 — 클릭당 수십~수백 ms).
        let mut t = core_lib::jsonl::SessionTail::new(project.clone(), uuid.clone(), jsonl.clone());
        t.poll().map_err(|e| AppError::new(io_message("Read transcript", &e)))?;
        if let Some(it) = t.timeline().items().iter().find(|i| i.tool_call_id == tool_call_id) {
            return Ok(detail_of(it));
        }
        // 서브에이전트 transcript들 (poll 루프와 동일 규칙: <jsonl stem>/subagents/*.jsonl).
        let sub_dir = jsonl.with_extension("").join("subagents");
        if let Ok(entries) = std::fs::read_dir(&sub_dir) {
            for entry in entries.flatten() {
                let f = entry.path();
                if f.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let aid = f
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.trim_start_matches("agent-").to_string())
                    .unwrap_or_default();
                let mut st = core_lib::jsonl::SessionTail::new(project.clone(), aid, f);
                let _ = st.poll();
                if let Some(it) =
                    st.timeline().items().iter().find(|i| i.tool_call_id == tool_call_id)
                {
                    return Ok(detail_of(it));
                }
            }
        }
        Err(AppError::new("Timeline item not found in the transcript"))
    })
    .await
    .map_err(|_| AppError::new("Detail lookup task failed"))?
}

/// List the saved Claude (A) sessions for `project`, newest first (for the
/// "+ Claude(A)" reopen picker).
#[tauri::command]
pub fn claude_sessions(app: AppHandle, project: String) -> Vec<core_lib::snapshot::SnapshotSummary> {
    let Ok(base) = app.path().app_data_dir() else {
        return vec![];
    };
    core_lib::snapshot::list(&base, &project)
}

/// Load a saved session's full timeline snapshot, to seed the panel on reopen.
#[tauri::command]
pub fn claude_session_snapshot(
    app: AppHandle,
    project: String,
    uuid: String,
) -> Option<core_lib::snapshot::SessionSnapshot> {
    let base = app.path().app_data_dir().ok()?;
    let mut snap = core_lib::snapshot::load(&base, &project, &uuid)?;
    // P1(#3): 절단은 IPC 반환 경계에서만 — 디스크 본문은 전문 유지.
    super::timeline::cap_content(&mut snap.items);
    Some(snap)
}

/// Rename a saved session (persists in its snapshot; the poll thread reads the
/// name back so it isn't clobbered).
#[tauri::command]
pub fn claude_rename(
    app: AppHandle,
    project: String,
    uuid: String,
    name: String,
) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    // Write only the name override file — decoupled from the timeline body the
    // poll thread writes, so neither clobbers the other (codex F1).
    core_lib::snapshot::save_name(&base, &project, &uuid, &name)
        .map_err(|e| AppError::new(io_message("Cannot rename session", &e)))
}

/// Delete a saved session's snapshot (the `삭제` action). The live session, if
/// any, should be closed separately via `claude_close`.
#[tauri::command]
pub fn claude_delete(app: AppHandle, project: String, uuid: String) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    core_lib::snapshot::delete(&base, &project, &uuid)
        .map_err(|e| AppError::new(io_message("Cannot delete session", &e)))
}

