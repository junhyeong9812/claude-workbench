//! One-shot headless `claude -p` invocation — std-only (no tauri), shared by
//! the archive command layer and the backfill CLI.
//!
//! Moved out of `src-tauri/commands` so a plain binary (backfill) can drive the
//! same battle-tested process handling: threaded pipe drains (a full stdout or
//! stderr pipe must never deadlock the child), kill+reap on timeout (no
//! zombie), capped capture, and "exit 0 AND non-empty stdout" as the only
//! success (codex P3 D7 lineage).

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// The cwd for **extraction** invocations. `claude -p` writes a transcript for
/// every run, keyed by its cwd — running extraction inside the target project
/// would create a new "session" in that project which the next backfill scan
/// then archives, spawning another extraction… a runaway feedback loop
/// (2026-07-19 실측: 179→256 세션). A fixed /tmp scratch dir breaks the loop
/// structurally: its transcripts land in a /tmp-slug project the backfill
/// already excludes, and user projects' session lists stay clean.
pub fn extraction_workdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("claude-workbench-extract");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The cwd for the **prompt-refine** session — a second scratch directory with
/// the same rationale as [`extraction_workdir`], kept separate only so the two
/// kinds of throwaway transcript don't share a slug.
///
/// The refine session is a full interactive `claude` PTY, so its transcript is
/// written like any other session's; rooting it here is what keeps it out of the
/// user's projects. The exclusion is not a filter we have to remember to apply —
/// it falls out of the path: the CLI files the transcript under a `-tmp-…` slug,
/// which [`crate::scan::ScanOpts::skip_tmp_slugs`] drops at scan level, and the
/// backfill additionally skips any transcript whose recorded `cwd` is under
/// `/tmp`. Measured 2026-08-05: slug `-tmp-claude-workbench-refine`.
pub fn refine_workdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("claude-workbench-refine");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Is `path` one of our throwaway scratch directories (i.e. under the system
/// temp dir)? Callers use it to skip per-project side effects — writing a
/// `.mcp.json` into a scratch dir would be pure litter.
///
/// Compares canonicalized paths so `/tmp/x` and a symlinked `/private/tmp/x`
/// agree; if either side can't be canonicalized we fall back to the raw path
/// (a non-existent cwd is about to fail the spawn anyway).
pub fn is_scratch_dir(path: &std::path::Path) -> bool {
    let tmp = std::env::temp_dir();
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(path).starts_with(canon(&tmp))
}

/// Model/effort selection for one invocation. `None` = let the CLI use its
/// session default. Values are passed verbatim as `--model` / `--effort`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ClaudeOpts {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Extra directories the run is allowed to read outside its cwd, each passed
    /// as `--add-dir <dir>`. Lets a run keep a fixed `/tmp` cwd (backfill-safe)
    /// while still exploring an absolute project path — `claude -p` otherwise
    /// blocks reads outside cwd. `#[serde(default)]` so opts serialized before
    /// this field existed still deserialize (empty vec).
    #[serde(default)]
    pub add_dirs: Vec<String>,
}

/// The argv tail after the binary name — split out so tests can pin the flag
/// contract without spawning a real process.
pub fn build_args(opts: &ClaudeOpts) -> Vec<String> {
    let mut args: Vec<String> = vec!["-p".into(), "--output-format".into(), "text".into()];
    if let Some(m) = opts.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(e) = opts.effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        args.push("--effort".into());
        args.push(e.to_string());
    }
    for dir in opts.add_dirs.iter().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        args.push("--add-dir".into());
        args.push(dir.to_string());
    }
    args
}

/// Run a one-shot `claude -p --output-format text` in `cwd`, feeding `prompt`
/// on stdin and capturing stdout. Errors are plain user-safe strings (the
/// command layer wraps them in its own error type).
pub fn run_claude_p(
    cwd: &str,
    prompt: &str,
    timeout: Duration,
    opts: &ClaudeOpts,
) -> Result<String, String> {
    const CAP: usize = 256 * 1024;

    let mut child = Command::new("claude")
        .args(build_args(opts))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot start claude".to_string())?;

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
    // could hang if a descendant of `claude` keeps the pipe open past the
    // child's own exit.
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
    // discard it — error text isn't surfaced.
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
            // Collect stdout with a bounded wait (the drain thread finishes as
            // the pipe closed on exit) — never block indefinitely.
            let stdout = orx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
            let text = String::from_utf8_lossy(&stdout).trim().to_string();
            if text.is_empty() {
                Err("Claude returned empty output".to_string())
            } else {
                Ok(text)
            }
        }
        Some(_) => Err("Claude exited with an error".to_string()),
        None => Err("Claude timed out".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_args_default_has_no_model_flags() {
        assert_eq!(
            build_args(&ClaudeOpts::default()),
            vec!["-p", "--output-format", "text"]
        );
    }

    #[test]
    fn build_args_appends_model_and_effort() {
        let opts = ClaudeOpts {
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            ..Default::default()
        };
        assert_eq!(
            build_args(&opts),
            vec!["-p", "--output-format", "text", "--model", "opus", "--effort", "xhigh"]
        );
    }

    #[test]
    fn build_args_ignores_blank_values() {
        let opts = ClaudeOpts {
            model: Some("  ".into()),
            effort: Some("".into()),
            ..Default::default()
        };
        assert_eq!(build_args(&opts), vec!["-p", "--output-format", "text"]);
    }

    #[test]
    fn build_args_appends_add_dir_per_entry_skipping_blanks() {
        let opts = ClaudeOpts {
            add_dirs: vec!["/proj/a".into(), "  ".into(), "".into(), "/proj/b".into()],
            ..Default::default()
        };
        assert_eq!(
            build_args(&opts),
            vec!["-p", "--output-format", "text", "--add-dir", "/proj/a", "--add-dir", "/proj/b"]
        );
    }

    #[test]
    fn opts_json_without_add_dirs_deserializes_to_empty() {
        // Opts serialized before `add_dirs` existed must still parse (serde default).
        let opts: ClaudeOpts =
            serde_json::from_str(r#"{ "model": "opus", "effort": "high" }"#).unwrap();
        assert_eq!(opts.model.as_deref(), Some("opus"));
        assert_eq!(opts.effort.as_deref(), Some("high"));
        assert!(opts.add_dirs.is_empty());
        // And a fully empty object still yields defaults.
        let empty: ClaudeOpts = serde_json::from_str("{}").unwrap();
        assert!(empty.add_dirs.is_empty() && empty.model.is_none());
    }
}
