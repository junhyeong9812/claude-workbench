//! 프로젝트 메모장의 백엔드 표면 — 프로젝트당 파일 1개 읽기/쓰기.
//!
//! 저장 규약(경로·원자 교체·상한)의 단일 출처는 `core_lib::memo_store`다. 여기
//! 있는 건 app_data 해소와 사용자에게 보일 오류 문구뿐이다.
//!
//! `write_file`로 우회하지 않는 이유: 프론트가 app_data 절대경로를 짓게 되고
//! (`@tauri-apps/api/path` 사용 선례 0), 부모 디렉토리 생성·상한 정책이 호출부로
//! 새어 나간다.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::{io_message, AppError};

/// 읽어 온 메모. `text`가 비어 있는 것과 **파일이 없는 것**은 다르다 — 후자는
/// 저장할 때 "내가 처음 쓰는 것"이라는 기대를 뜻하므로 프론트가 구분해 들고
/// 있어야 한다(낙관적 잠금의 base).
#[derive(Serialize)]
pub struct MemoDoc {
    text: String,
    /// 디스크 본문의 콘텐츠 해시. 파일이 없으면 `None`.
    hash: Option<String>,
}

fn app_data(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|_| AppError::new("Cannot resolve app data directory"))
}

/// 프로젝트 메모를 읽는다.
///
/// **부재만 빈 메모다** (리뷰 P2-4). 그 밖의 I/O 실패는 오류로 올린다 — 실패를
/// 빈 문자열로 뭉개면 프론트가 빈 에디터를 띄우고, 사용자가 한 글자만 쳐도 그
/// 빈 기반이 멀쩡한 파일을 덮어쓴다.
#[tauri::command]
pub fn memo_read(app: AppHandle, project: String) -> Result<MemoDoc, AppError> {
    if project.trim().is_empty() {
        return Err(AppError::new("메모를 읽을 프로젝트가 지정되지 않았습니다."));
    }
    let base = app_data(&app)?;
    match core_lib::memo_store::load(&base, &project) {
        Ok(Some(text)) => Ok(MemoDoc {
            hash: Some(core_lib::memo_store::content_hash(&text)),
            text,
        }),
        Ok(None) => Ok(MemoDoc {
            text: String::new(),
            hash: None,
        }),
        Err(e) => Err(AppError::new(io_message("Cannot read memo", &e))),
    }
}

/// 프로젝트 메모를 저장한다 (원자 교체). 상한 초과는 **잘라서 저장하지 않고
/// 거부**한다 — 사용자가 쓴 글을 조용히 버리는 쪽이 더 나쁜 실패다.
#[tauri::command]
pub fn memo_write(app: AppHandle, project: String, text: String) -> Result<(), AppError> {
    if project.trim().is_empty() {
        return Err(AppError::new("메모를 저장할 프로젝트가 지정되지 않았습니다."));
    }
    if text.len() > core_lib::memo_store::MEMO_CAP {
        return Err(AppError::new(format!(
            "메모가 너무 큽니다 (최대 {}KB).",
            core_lib::memo_store::MEMO_CAP / 1024
        )));
    }
    let base = app_data(&app)?;
    core_lib::memo_store::save(&base, &project, &text)
        .map_err(|e| AppError::new(io_message("Cannot save memo", &e)))
}
