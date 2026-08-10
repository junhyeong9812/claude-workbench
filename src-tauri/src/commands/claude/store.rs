//! 저장 스냅샷·원문 detail·세션 CRUD 커맨드 — P5 B-c 분할. 절단은 IPC 반환
//! 경계만(P1 계약 — cap_content는 timeline 소유).

use core_lib::TimelineItem;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{io_message, AppError};

/// P1: 절단된 아이템의 원문 상세 — 전문 스냅샷 우선, 부재 시 원본 JSONL
/// (+서브에이전트 transcript)에서 재추출(read-only, mapper 결정적 — spec
/// 가정②). 뷰어가 `content_truncated` 아이템 선택 시 lazy 호출.
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

/// 메모리 1단계 B: 완료 서브에이전트의 아이템 본문 — 펼칠 때만 조회한다.
///
/// 폴 payload는 완료 에이전트의 메타(진행도·상태)만 싣는다(`SubagentFrame`).
/// 본문의 정본은 `<uuid>/subagents/agent-<id>.jsonl`이므로 여기서 그때그때
/// 재파싱한다 — `claude_item_detail`과 같은 lazy 패턴이고, 절단도 같은 IPC
/// 경계 규칙(`cap_content`)을 따른다.
#[tauri::command]
pub async fn claude_subagent_items(
    project: String,
    uuid: String,
    agent_id: String,
) -> Result<Vec<TimelineItem>, AppError> {
    // uuid·agent_id 둘 다 경로 조각이 된다 — 커맨드 경계에서 형식을 못박는다
    // (`claude_item_detail`과 동일한 방어선).
    if !core_lib::snapshot::is_safe_uuid(&uuid) || !core_lib::snapshot::is_safe_uuid(&agent_id) {
        return Err(AppError::new("Invalid session id"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = core_lib::jsonl::claude_projects_root()
            .ok_or_else(|| AppError::new("Cannot locate the Claude projects root"))?;
        let jsonl = core_lib::jsonl::find_session_jsonl(&root, &uuid)
            .map_err(|e| AppError::new(io_message("Locate transcript", &e)))?
            .ok_or_else(|| AppError::new("Session transcript not found"))?;
        // 폴 루프와 동일한 규칙: <jsonl stem>/subagents/agent-<id>.jsonl.
        let path = jsonl
            .with_extension("")
            .join("subagents")
            .join(format!("agent-{agent_id}.jsonl"));
        if !path.is_file() {
            return Err(AppError::new("Subagent transcript not found"));
        }
        let mut st = core_lib::jsonl::SessionTail::new(project, agent_id, path);
        st.poll().map_err(|e| AppError::new(io_message("Read subagent transcript", &e)))?;
        let mut items = st.timeline().items().to_vec();
        super::timeline::cap_content(&mut items);
        Ok(items)
    })
    .await
    .map_err(|_| AppError::new("Subagent lookup task failed"))?
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

/// Sessions of `project` that exist as CLI transcripts but have **no snapshot**
/// here — i.e. started from a terminal, outside the app. The picker offers them
/// for adoption (`--resume`).
///
/// Difference-only: adopting one makes the poll thread write a snapshot, which
/// removes it from this list on the next call. Nothing is persisted about the
/// adoption itself (`core::external`).
///
/// The one thing that *is* persisted is the user's dismissals: sessions deleted
/// through [`claude_delete`] come back in the `hidden` bucket instead of the
/// visible list (`core::hidden`), because deleting the snapshot is precisely
/// what puts a session back into the difference.
///
/// Runs off the UI thread — it stats every transcript in the projects root and
/// walks `/proc` for the liveness verdict (~0.2 s on a 340-transcript corpus).
#[tauri::command]
pub async fn claude_external_sessions(
    app: AppHandle,
    project: String,
) -> core_lib::external::ExternalListing {
    tauri::async_runtime::spawn_blocking(move || {
        let (Ok(base), Some(projects_root)) =
            (app.path().app_data_dir(), core_lib::jsonl::claude_projects_root())
        else {
            eprintln!("claude_external_sessions: app data dir 또는 Claude projects root를 찾을 수 없어 목록을 비웁니다");
            return core_lib::external::ExternalListing::default();
        };
        core_lib::external::list_external(
            &projects_root,
            &base,
            &project,
            std::path::Path::new("/proc"),
            // Our own pid: the app tails transcripts and spawns `claude` with the
            // uuid on the command line, so counting ourselves would report every
            // session we drive as "busy elsewhere".
            std::process::id(),
        )
    })
    .await
    .unwrap_or_else(|e| {
        // An empty list is indistinguishable from "no external sessions" in the
        // UI, so a panicked/cancelled task must not vanish without a word.
        eprintln!("claude_external_sessions: 조회 태스크 실패 — 빈 목록으로 응답합니다 ({e})");
        core_lib::external::ExternalListing::default()
    })
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
///
/// The transcript is **not** touched — deleting a session has never meant
/// deleting the CLI's own record of it, and it must not start meaning that now.
/// But that leaves the session in the external-sessions difference (transcripts
/// minus snapshots), so it would reappear in the picker one refresh after the
/// user deleted it. The uuid is therefore recorded as dismissed
/// (`core::hidden`); the picker's "숨긴 세션" toggle can still bring it back, and
/// adopting it clears the dismissal.
///
/// Recording the dismissal is best-effort: the delete itself already succeeded,
/// so failing the command afterwards would report a delete that did happen as an
/// error. The cost of the failure is a row coming back, and it is logged.
#[tauri::command]
pub fn claude_delete(app: AppHandle, project: String, uuid: String) -> Result<(), AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))?;
    core_lib::snapshot::delete(&base, &project, &uuid)
        .map_err(|e| AppError::new(io_message("Cannot delete session", &e)))?;
    // The transcripts root is passed so that, if this project's dismissal list is
    // ever at its cap, tombstones (dismissals whose transcript is gone) are what
    // gets evicted rather than a dismissal that is still doing its job.
    let root = core_lib::jsonl::claude_projects_root();
    if let Err(e) = core_lib::hidden::hide(&base, &project, &uuid, root.as_deref()) {
        eprintln!(
            "claude_delete: 숨김 목록 기록 실패 — 이 세션이 '외부 세션'으로 다시 보일 수 있습니다 ({e})"
        );
    }
    Ok(())
}

