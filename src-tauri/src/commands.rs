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
use tauri::{AppHandle, Manager};

mod claude;
mod files;
mod git;
mod ssh;
mod task;
mod terminal;

pub use claude::*;
pub use files::*;
pub use git::*;
pub use ssh::*;
pub use task::*;
pub use terminal::*;

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

/// One chunk of PTY output, emitted as the `terminal-output` event. `data` is
/// raw bytes (serialized as a JSON byte array); the frontend feeds it to xterm.
#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: u64,
    seq: u64,
    data: Vec<u8>,
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
