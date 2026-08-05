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
    let dir = extraction_workdir_path();
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
/// backfill additionally skips any transcript whose recorded `cwd` starts with
/// the literal `/tmp/`. Measured 2026-08-05: slug `-tmp-claude-workbench-refine`.
///
/// **`/tmp` is hard-coded on purpose, not `env::temp_dir()`** (review #9): both
/// defenses above are written against the literal `/tmp` — the `-tmp-` slug the
/// CLI derives from the path, and the backfill's `cwd.starts_with("/tmp/")`. If
/// `TMPDIR` pointed elsewhere the workdir would move but the defenses would not
/// follow it, and every refine transcript would silently become an archive
/// candidate. The path and the defense must be the same literal, so the constant
/// is the single source and a test pins it.
pub const REFINE_WORKDIR: &str = "/tmp/claude-workbench-refine";

/// The refine workdir path — no side effects (use [`ensure_refine_workdir`] to
/// actually create it).
pub fn refine_workdir_path() -> std::path::PathBuf {
    std::path::PathBuf::from(REFINE_WORKDIR)
}

/// The extraction workdir path — no side effects.
pub fn extraction_workdir_path() -> std::path::PathBuf {
    std::env::temp_dir().join("claude-workbench-extract")
}

/// Create (or validate) the refine workdir, refusing a symlink.
pub fn ensure_refine_workdir() -> Result<std::path::PathBuf, String> {
    ensure_scratch_dir(&refine_workdir_path())
}

/// A **fresh, single-use** scratch directory `…-refine-<random>`.
///
/// This is the squat-proof-by-construction variant: the name is unpredictable and
/// `create_dir` is atomic, so nothing can be sitting at the path when we win.
/// Used where a per-run directory costs nothing — the codex check, which is a
/// one-shot subprocess. The interactive refine session cannot use it: `claude`
/// re-asks its workspace-trust dialog in every new directory (see
/// [`ensure_scratch_dir`]).
///
/// The caller removes it when done; a leftover is harmless (it is excluded from
/// every scan by its `/tmp` path just like the fixed one).
pub fn create_run_scratch_dir() -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    for _ in 0..8 {
        let dir = std::path::PathBuf::from(format!("{REFINE_WORKDIR}-{}", random_suffix()));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                    .map_err(|_| "작업 디렉토리 권한을 설정할 수 없습니다.".to_string())?;
                return Ok(dir);
            }
            // 이름이 이미 있다 = 충돌이거나 선점 — 다른 이름으로 다시 시도한다.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("작업 디렉토리를 만들 수 없습니다.".to_string()),
        }
    }
    Err("작업 디렉토리를 만들 수 없습니다.".to_string())
}

/// Unpredictable suffix — the kernel's UUID source (the same one session ids come
/// from), with pid+nanos as a fallback so a missing `/proc` degrades to "unique"
/// rather than failing.
fn random_suffix() -> String {
    if let Ok(s) = std::fs::read_to_string("/proc/sys/kernel/random/uuid") {
        let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).take(16).collect();
        if hex.len() == 16 {
            return hex;
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Create `dir` and return it, **never accepting a directory we do not own**.
///
/// The path lives in a world-writable `/tmp`, so any local process can try to win
/// the race to create it first — as a symlink pointing at somewhere else, or as
/// its own directory it can then read. Three checks, in this order, close that:
///
/// 1. **`create_dir`, not `create_dir_all`.** The plain call is atomic and fails
///    with `AlreadyExists` if *anything* is at the path — including a symlink
///    that resolves to a directory, which `create_dir_all` happily accepts. So
///    the success path means "we just made it", full stop.
/// 2. On `AlreadyExists` (the ordinary case — a previous run's directory), the
///    entry is inspected with **`symlink_metadata`**, the only stat that does not
///    follow a link, and rejected unless it is a real directory.
/// 3. **Ownership + mode.** A real directory planted by another local user would
///    pass (2), so it must also be owned by us; and we force `0700` so nothing
///    outside this account can read the drafts or drop files in.
///
/// Why the path stays fixed instead of one directory per run (which would make
/// squatting impossible by construction): measured 2026-08-05 — `claude` shows
/// its workspace-trust dialog on the first interactive run in *any* new
/// directory, and there is no flag to skip it (the CLI's own help offers only
/// non-interactive `-p` or hand-editing `hasTrustDialogAccepted`). With a fresh
/// directory per session the dialog is on screen when the protocol seed is
/// injected, the seed's Enter answers the *dialog*, and the seed itself is lost —
/// `SEED_DELIVERED=false`, no transcript at all. The refine session would start
/// with no instructions every time. Checks (1)–(3) give the same guarantee
/// against other local users, which is the threat the squat is; an attacker
/// already running as this user can read `~/.claude` directly.
pub fn ensure_scratch_dir(dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let md = std::fs::symlink_metadata(dir)
                .map_err(|_| "작업 디렉토리 상태를 확인할 수 없습니다.".to_string())?;
            if md.file_type().is_symlink() {
                return Err(
                    "작업 디렉토리 자리에 심볼릭 링크가 있습니다 — 안전하지 않아 사용하지 않습니다."
                        .to_string(),
                );
            }
            if !md.is_dir() {
                return Err("작업 디렉토리 자리에 디렉토리가 아닌 파일이 있습니다.".to_string());
            }
            // SAFETY: `geteuid` has no preconditions and cannot fail.
            if md.uid() != unsafe { libc::geteuid() } {
                return Err(
                    "작업 디렉토리가 다른 사용자 소유입니다 — 안전하지 않아 사용하지 않습니다."
                        .to_string(),
                );
            }
        }
        Err(_) => return Err("작업 디렉토리를 만들 수 없습니다.".to_string()),
    }
    // 우리 소유임을 확인한 뒤에만 권한을 조인다(남의 디렉토리를 건드리지 않는다).
    // 실패를 삼키지 않는다: 0700을 걸지 못했다면 다른 로컬 사용자가 초안을 읽거나
    // 파일을 떨어뜨릴 수 있는 상태라는 뜻이고, 그건 이 디렉토리를 쓰지 않을 이유다.
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "작업 디렉토리 권한을 설정할 수 없습니다.".to_string())?;
    Ok(dir.to_path_buf())
}

/// Is `path` **exactly** one of our two throwaway scratch directories? Callers
/// use it to skip per-project side effects — writing a `.mcp.json` into a scratch
/// dir would be pure litter.
///
/// Exact match, not "under the temp dir" (review #8): a user can perfectly well
/// keep a real project under `/tmp` (or have `TMPDIR` point at their work tree),
/// and a prefix test would silently stop registering the knowledge MCP server for
/// it. Only the directories this app itself owns get the skip.
pub fn is_scratch_dir(path: &std::path::Path) -> bool {
    let canon = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let target = canon(path);
    if [refine_workdir_path(), extraction_workdir_path()]
        .iter()
        .any(|d| canon(d) == target)
    {
        return true;
    }
    // 실행별 스크래치(`…-refine-<suffix>`)도 우리 것이다 — codex 검증이 매번 새로
    // 만들고 지우는 디렉토리가 여기 걸린다. 접두사가 `refine-`까지 포함하므로
    // /tmp 아래 일반 프로젝트가 잘못 걸리지 않는다(리뷰 #8의 과광 방지 유지).
    target
        .to_str()
        .is_some_and(|s| s.starts_with(&format!("{REFINE_WORKDIR}-")))
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

    /// 격리의 두 방어선은 **리터럴 `/tmp`** 위에 쓰여 있다. 경로가 그 리터럴을
    /// 벗어나는 순간 정리 세션 전사가 조용히 아카이브 후보가 되므로, 경로와
    /// 방어선이 같은 문자열임을 여기서 못박는다(리뷰 #9).
    #[test]
    fn refine_workdir_is_pinned_to_the_literal_tmp_the_defenses_use() {
        assert_eq!(REFINE_WORKDIR, "/tmp/claude-workbench-refine");
        // 방어선 1 — backfill: `cwd.starts_with("/tmp/")`.
        assert!(REFINE_WORKDIR.starts_with("/tmp/"));
        // 방어선 2 — scan: CLI가 이 경로에서 만드는 슬러그가 `-tmp-`로 시작한다
        // (실측 2026-08-05: `-tmp-claude-workbench-refine`). 슬러그 규칙은 경로의
        // `/`를 `-`로 바꾸는 것이므로 리터럴에서 그대로 유도된다.
        let slug: String = REFINE_WORKDIR.replace('/', "-");
        assert!(slug.starts_with("-tmp-"), "슬러그 {slug}가 -tmp- 로 시작해야 한다");
        // env::temp_dir()가 어디를 가리키든 경로는 움직이지 않는다.
        assert_eq!(refine_workdir_path(), std::path::PathBuf::from("/tmp/claude-workbench-refine"));
    }

    /// 스크래치 판정은 **정확히 우리 디렉토리 두 개**만 — /tmp 아래 실프로젝트는
    /// 스킵 대상이 아니다(리뷰 #8).
    #[test]
    fn is_scratch_dir_matches_only_our_two_dirs() {
        assert!(is_scratch_dir(&refine_workdir_path()));
        assert!(is_scratch_dir(&extraction_workdir_path()));
        assert!(!is_scratch_dir(std::path::Path::new("/tmp")));
        assert!(!is_scratch_dir(std::path::Path::new("/tmp/my-real-project")));
        assert!(!is_scratch_dir(std::path::Path::new("/home/u/project")));
    }

    /// 고정 경로 + world-writable = 선점 가능. 심링크는 따라가지 않고 거부하고,
    /// 우리가 만든 디렉토리는 0700으로 조인다.
    #[test]
    fn ensure_scratch_dir_refuses_a_symlink_and_locks_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("cwb-scratch-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();

        // 정상: 없으면 만들고(create_dir — 원자적), 두 번째 호출은 AlreadyExists
        // 경로로 들어가 소유자 검사를 통과해야 한다.
        let fresh = base.join("fresh");
        assert_eq!(ensure_scratch_dir(&fresh).unwrap(), fresh);
        assert_eq!(ensure_scratch_dir(&fresh).unwrap(), fresh);
        let mode = std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "스크래치는 이 계정만 읽을 수 있어야 한다");

        // 심링크가 (디렉토리로 잘 해소되더라도) 자리에 있으면 거부.
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(link.is_dir(), "테스트 전제: 링크는 디렉토리로 해소된다");
        let err = ensure_scratch_dir(&link).unwrap_err();
        assert!(err.contains("심볼릭 링크"), "예상 밖 메시지: {err}");

        // 디렉토리가 아닌 파일도 거부.
        let file = base.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_scratch_dir(&file).is_err());

        std::fs::remove_dir_all(&base).ok();
    }

    /// 일회용 스크래치는 매번 다른 이름으로 새로 만들어지고, 격리 방어선(슬러그
    /// `-tmp-`·cwd `/tmp/`)에 그대로 걸린다.
    #[test]
    fn create_run_scratch_dir_is_unique_and_still_isolated() {
        use std::os::unix::fs::PermissionsExt;
        let a = create_run_scratch_dir().unwrap();
        let b = create_run_scratch_dir().unwrap();
        assert_ne!(a, b, "실행별 디렉토리는 이름이 겹치면 안 된다");
        for d in [&a, &b] {
            assert!(d.is_dir());
            assert!(d.starts_with("/tmp/"), "backfill의 cwd 방어선");
            let slug = d.to_str().unwrap().replace('/', "-");
            assert!(slug.starts_with("-tmp-"), "scan의 슬러그 방어선: {slug}");
            assert!(is_scratch_dir(d), "mcp 등록 스킵 대상이어야 한다");
            assert_eq!(std::fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

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
