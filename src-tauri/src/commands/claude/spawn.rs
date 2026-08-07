//! Claude PTY 스폰(uuid 채번·hook --settings 주입·relay·poll 기동) — P5 B-c.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use core_lib::SessionManager;
use tauri::AppHandle;

use crate::commands::AppError;

/// Generate a fresh session UUID for `--session-id`. Linux-only (the app's
/// platform): reads the kernel's random UUID source.
fn new_session_uuid() -> Result<String, AppError> {
    std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .map(|s| s.trim().to_string())
        .map_err(|_| AppError::new("Cannot generate a session id"))
}

/// The `claude` argv for one session, up to (not including) the hook `--settings`
/// injection: `claude <--session-id|--resume> <uuid> [--model M] [--effort E]`.
///
/// Split out as a pure function so the **no-option path stays byte-identical**
/// under test: `None` (and blank, which is what a stray `""` from the frontend
/// looks like) means the flag is not pushed at all, so every pre-existing caller
/// produces exactly the argv it produced before options existed. Blank-rejection
/// matters asymmetrically: `--model ""` is rejected by the CLI and kills the
/// session outright, while a bad `--effort` only warns and falls back.
fn build_claude_args(
    flag: &str,
    session_uuid: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<String> {
    let mut cmd = vec!["claude".to_string(), flag.to_string(), session_uuid.to_string()];
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        cmd.push("--model".to_string());
        cmd.push(m.to_string());
    }
    if let Some(e) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        cmd.push("--effort".to_string());
        cmd.push(e.to_string());
    }
    cmd
}

/// Spawn the real `claude` CLI in a PTY rooted at `cwd` and start (a) relaying
/// its output to `terminal-output` (xterm) and (b) tailing its session JSONL to
/// emit `claude-timeline` items. Does NOT register into `ClaudeRuntime` — the
/// caller does that under its lock. `resume` continues an existing session by
/// UUID; None starts a fresh `--session-id`. Returns (id, uuid, poll-stop flag).
///
/// `project` and `cwd` are normally the same string, and were a single argument
/// until adoption of external sessions split them: the CLI only finds a session
/// to `--resume` from the directory that session was created in, so the PTY must
/// be rooted at the transcript's own cwd — while the snapshot the poll thread
/// writes must stay keyed by the **app's** project, or the adopted session would
/// be filed under a name nothing else in the app uses.
///
/// `model`/`effort` pin the session's model (`--model <alias>`, e.g.
/// `opus`/`fable`) and reasoning effort (`--effort <level>`). For both,
/// **None/blank = the flag is not passed at all** — see [`build_claude_args`].
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_claude(
    app: &AppHandle,
    mgr: &SessionManager,
    project: String,
    cwd: String,
    resume: Option<String>,
    name: String,
    model: Option<String>,
    effort: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(u64, String, Arc<AtomicBool>), AppError> {
    let session_uuid = match &resume {
        Some(u) => u.clone(),
        None => new_session_uuid()?,
    };
    // Resume only if the transcript already exists; otherwise `--resume` would
    // fork a *different* new session, so create with this exact id via
    // `--session-id` (keeps the id stable across restarts).
    let resuming = resume.is_some()
        && core_lib::jsonl::claude_projects_root()
            .and_then(|root| core_lib::jsonl::find_session_jsonl(&root, &session_uuid).ok().flatten())
            .is_some();
    let flag = if resuming { "--resume" } else { "--session-id" };
    let mut cmd = build_claude_args(flag, &session_uuid, model.as_deref(), effort.as_deref());

    // hook-status: 수신기가 살아 있으면 세션 한정 hook 설정을 주입한다
    // (--settings 인자 — 사용자 ~/.claude 무수정, spec §2). 세션별 토큰은
    // 0600 헤더 파일로 쓰고 경로만 env로 전달 — claude/curl 어느 쪽 argv에도
    // 토큰 값이 실리지 않는다(리뷰 H1·H4). 수신기 기동/등록 실패는 주입
    // 생략 = 프론트 화면 스캔 폴백 (기능 저하, 세션은 정상).
    let mut envs: Vec<(String, String)> = Vec::new();
    if let Some(hook) = crate::commands::hookserver::ensure_started(app) {
        if let Some(hdr_path) = hook.register_session(&session_uuid) {
            cmd.push("--settings".to_string());
            cmd.push(crate::commands::hookserver::hook_settings_json());
            envs.push(("WORKBENCH_HOOK_PORT".to_string(), hook.port.to_string()));
            envs.push(("WORKBENCH_HOOK_HDR".to_string(), hdr_path));
        }
    }

    let id = mgr
        .create_with_env(Some(cmd), Some(cwd), cols, rows, envs)
        .map_err(AppError::new)?;
    // Clean up the orphan PTY if we can't subscribe to it (review P6-impl #4).
    let rx = match mgr.subscribe(id) {
        Ok(rx) => rx,
        Err(e) => {
            let _ = mgr.remove(id);
            return Err(AppError::new(e));
        }
    };
    let stop = Arc::new(AtomicBool::new(false));

    // (a) Relay PTY output -> webview (공용 헬퍼, P4). When the PTY dies the
    // sender drops, the loop ends, and `on_end`가 `stop`을 세워 poll 스레드를
    // 멈춘다.
    {
        let stop = stop.clone();
        crate::commands::spawn_output_relay(
            app.clone(),
            id,
            rx,
            Some(Box::new(move || stop.store(true, Ordering::Relaxed))),
        );
    }
    // (b) Tail the JSONL -> claude-timeline + persist snapshot.
    {
        let app = app.clone();
        let uuid = session_uuid.clone();
        let stop = stop.clone();
        thread::spawn(move || {
            super::timeline::run_timeline_poll(app, id, project, uuid, name, stop)
        });
    }
    Ok((id, session_uuid, stop))
}


#[cfg(test)]
mod tests {
    use super::build_claude_args;

    const UUID: &str = "11111111-2222-3333-4444-555555555555";

    /// The regression that guards every pre-existing spawn surface: with no
    /// options the argv must be exactly what it was before options existed.
    #[test]
    fn no_options_is_byte_identical_to_the_old_argv() {
        assert_eq!(
            build_claude_args("--session-id", UUID, None, None),
            vec!["claude", "--session-id", UUID]
        );
        assert_eq!(
            build_claude_args("--resume", UUID, None, None),
            vec!["claude", "--resume", UUID]
        );
    }

    /// A stray empty/blank string from the frontend must not become `--model ""`
    /// (session-killing) nor `--effort ""`.
    #[test]
    fn blank_options_are_unset() {
        assert_eq!(
            build_claude_args("--session-id", UUID, Some(""), Some("   ")),
            vec!["claude", "--session-id", UUID]
        );
    }

    #[test]
    fn options_are_appended_after_the_session_flag() {
        assert_eq!(
            build_claude_args("--session-id", UUID, Some("opus"), Some("xhigh")),
            vec!["claude", "--session-id", UUID, "--model", "opus", "--effort", "xhigh"]
        );
    }

    /// Either one alone — the two flags are independent.
    #[test]
    fn each_option_is_independent() {
        assert_eq!(
            build_claude_args("--session-id", UUID, Some("fable"), None),
            vec!["claude", "--session-id", UUID, "--model", "fable"]
        );
        assert_eq!(
            build_claude_args("--session-id", UUID, None, Some("max")),
            vec!["claude", "--session-id", UUID, "--effort", "max"]
        );
    }

    /// Values are trimmed, not quoted or escaped — the PTY spawn takes an argv
    /// vector, so a value with spaces stays one argument.
    #[test]
    fn values_are_trimmed() {
        assert_eq!(
            build_claude_args("--session-id", UUID, Some("  opus  "), Some(" low ")),
            vec!["claude", "--session-id", UUID, "--model", "opus", "--effort", "low"]
        );
    }
}
