//! Tauri commands: thin wrappers over the pure `core_lib` crate.
//!
//! Error policy: every fallible command returns `Result<_, AppError>`. We never
//! panic, and error messages are deliberately generic (an error *kind*, never
//! the offending path or an OS-level message) so internal filesystem details
//! and stack information are not leaked to the UI.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use std::io;

use core_lib::SessionManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub mod archive;
pub mod claude;
pub mod files;
pub mod git;
pub mod graph;
mod hookserver;
pub mod memo;
pub mod refine;
pub mod ssh;
pub mod terminal;

// P4 U3: 글롭 재수출 제거 — 커맨드는 lib.rs generate_handler가 모듈 경로
// (`commands::files::read_dir` 등)로 직접 참조한다(tauri 매크로의 숨은
// `__cmd__*` 항목까지 함께 해소되는 관용형). 평평한 재수출 표면 109개를
// 없애 소유를 모듈 경로로 드러내고 이름 충돌의 조용한 shadow를 차단.

/// A single, consistent error type shared by all commands.
#[derive(Debug, Serialize)]
pub struct AppError {
    message: String,
}

impl AppError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Map an I/O error to a user-safe message based only on its *kind*.
fn io_message(action: &str, err: &io::Error) -> String {
    let reason = match err.kind() {
        io::ErrorKind::NotFound => "path not found",
        io::ErrorKind::PermissionDenied => "permission denied",
        io::ErrorKind::NotADirectory => "not a directory",
        _ => "I/O error",
    };
    format!("{action}: {reason}")
}

/// One chunk of PTY output, emitted as the **session-scoped**
/// `terminal-output-{id}` event (P3 — 전역 단일 이벤트는 모든 패널이 전 세션
/// 청크를 역직렬화하게 만든다). `data` is the raw bytes **base64-encoded**
/// (JSON number[] 직렬화가 3-4배 팽창하던 것을 ~1.33배로); the frontend
/// decodes with `decodePtyData` and feeds xterm.
#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: u64,
    seq: u64,
    data: String,
}

/// P4: PTY 출력 relay 스레드 공용화 — 세 생성 경로(터미널·SSH·Claude)가
/// 문자단위 동일하던 spawn 블록의 단일 출처. `on_end`는 수신 채널이 닫힌 뒤
/// (세션 종료) 1회 호출 — Claude가 타임라인 poll 정지 플래그를 세우는 데 쓴다.
fn spawn_output_relay(
    app: AppHandle,
    session_id: u64,
    rx: std::sync::mpsc::Receiver<core_lib::OutputChunk>,
    on_end: Option<Box<dyn FnOnce() + Send>>,
) {
    thread::spawn(move || {
        while let Ok(chunk) = rx.recv() {
            emit_terminal_output(&app, session_id, chunk.seq, &chunk.bytes);
        }
        if let Some(f) = on_end {
            f();
        }
    });
}

/// Emit one PTY chunk to its session-scoped event. 모든 PTY relay(터미널·SSH·
/// Claude)가 이 헬퍼를 지나므로 이벤트명·인코딩 계약이 한 곳에 있다.
fn emit_terminal_output(app: &AppHandle, session_id: u64, seq: u64, bytes: &[u8]) {
    use base64::Engine as _;
    let _ = app.emit(
        &format!("terminal-output-{session_id}"),
        TerminalOutput {
            session_id,
            seq,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
    );
}

/// Runtime toggle for scrollback disk persistence (opt-in — review F11/P4-R3). A
/// running flusher checks this every tick, so turning persistence OFF stops
/// further writes for *existing* sessions, not just new ones.
#[derive(Default)]
pub struct ScrollbackState {
    enabled: AtomicBool,
}

/// App-data scrollback directory (opt-in persistence — P4).
fn scrollback_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("scrollback"))
}

/// Spawn the flusher for a persisted session. It is the **sole owner** of the
/// session's scrollback file (review P4-R1): it saves at most every ~2s while the
/// output changes *and* persistence is enabled, keeps polling after the session
/// dies (so a dead-but-open tab can be reopened), and — only when the session is
/// finally **removed** (panel closed) — deletes the file and stops. Because no
/// other code touches the file, there is no delete/flush race. Started only when
/// a `persist_key` was given (opt-in).
fn spawn_scrollback_flush(app: AppHandle, id: u64, key: String) {
    thread::spawn(move || {
        let Some(dir) = scrollback_dir(&app) else {
            return;
        };
        let mut last_seq = u64::MAX;
        loop {
            thread::sleep(Duration::from_secs(2));
            match app.state::<SessionManager>().snapshot(id) {
                Ok((bytes, seq)) => {
                    let enabled = app.state::<ScrollbackState>().enabled.load(Ordering::Relaxed);
                    if enabled && seq != last_seq {
                        let _ = core_lib::scrollback_store::save(&dir, &key, &bytes);
                        last_seq = seq;
                    }
                    // Keep polling even when dead-but-not-removed, so we remain the
                    // file's sole owner until the panel is actually closed.
                }
                Err(_) => {
                    // Session removed (panel permanently closed) → discard on disk.
                    let _ = core_lib::scrollback_store::delete(&dir, &key);
                    break;
                }
            }
        }
    });
}
