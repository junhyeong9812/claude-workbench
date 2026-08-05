//! One-shot headless `codex exec` invocation — std-only (no tauri).
//!
//! Sibling of [`crate::claude_cli`], and deliberately the same shape: threaded
//! pipe drains (a full stdout/stderr pipe must never deadlock the child),
//! kill+reap on timeout (no zombie), capped capture, and a single definition of
//! success. Only the *product* differs — codex is a second opinion on a prompt,
//! never a code-changing agent here, so the run is pinned read-only and
//! sandboxed and is given no project directory to work in.
//!
//! Why the final answer comes from a file rather than stdout: `codex exec`
//! streams its whole session (reasoning, tool events, token counts) to stdout,
//! so scraping it would mean parsing a UI. `-o <file>` writes exactly the last
//! agent message, which is the only thing we show.

use std::io::Read;
use std::os::unix::process::CommandExt; // process_group
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Locate the `codex` binary.
///
/// PATH first (a normal install), then the nvm layout — a GUI app launched from
/// a desktop launcher inherits the session's PATH, which on nvm setups usually
/// does **not** include the active node's `bin`, so a codex that works fine in
/// the user's shell would look missing. The glob is sorted and takes the last
/// match, so the newest node version wins deterministically.
///
/// Returns `None` when nothing is found; the caller turns that into a plain
/// "codex is not installed" message rather than a spawn failure.
pub fn find_codex() -> Option<PathBuf> {
    find_codex_in(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("HOME").map(PathBuf::from).as_deref(),
    )
}

/// The lookup itself, with its two environment inputs passed in — so the search
/// order can be tested without mutating process-global `PATH` (which would race
/// every other test in the binary).
pub fn find_codex_in(path_var: Option<&std::ffi::OsStr>, home: Option<&std::path::Path>) -> Option<PathBuf> {
    if let Some(paths) = path_var {
        for dir in std::env::split_paths(paths) {
            let cand = dir.join("codex");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    let versions = home?.join(".nvm/versions/node");
    let mut found: Vec<PathBuf> = std::fs::read_dir(versions)
        .ok()?
        .flatten()
        .map(|e| e.path().join("bin/codex"))
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found.pop()
}

/// Run `codex exec` on `prompt` and return the agent's final message.
///
/// `cwd` is a throwaway scratch directory (the prompt-refine workdir): the run
/// must not read, and cannot write, a real project. `--skip-git-repo-check`
/// exists because that directory is not a git repo; `--sandbox read-only` and
/// `--color never` keep the run harmless and the text clean.
///
/// Errors are plain user-safe strings. **They never include the argv or the
/// prompt** — the caller shows them verbatim in the UI, and echoing a command
/// line back into a panel is how a stray token ends up on screen.
pub fn run_codex_exec(cwd: &std::path::Path, prompt: &str, timeout: Duration) -> Result<String, String> {
    const CAP: usize = 256 * 1024;

    let bin = find_codex().ok_or_else(|| {
        "codex를 찾을 수 없습니다 — 설치되어 있고 PATH에 있는지 확인하세요 \
         (`npm i -g @openai/codex`)."
            .to_string()
    })?;

    // The last agent message lands here. A per-run unique name (pid + nanos) so
    // two checks started at once can't read each other's answer.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out_path = cwd.join(format!(".codex-check-{}-{}.txt", std::process::id(), stamp));
    // A stale file from a crashed run must never be mistaken for this run's
    // answer (we only trust it if the process also exits 0, but be explicit).
    let _ = std::fs::remove_file(&out_path);

    let mut child = Command::new(&bin)
        .arg("exec")
        .arg("--skip-git-repo-check")
        // 세션 파일을 남기지 않는다 — 이건 대화가 아니라 일회성 2차 의견이고,
        // codex의 `resume` 목록에 정리 프롬프트가 쌓일 이유가 없다 (리뷰 #12).
        .arg("--ephemeral")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--color")
        .arg("never")
        .arg("-o")
        .arg(&out_path)
        .arg(prompt)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 자기 자신을 리더로 하는 **프로세스 그룹**에 넣는다(리뷰 #10). codex는
        // 자식(MCP 서버·훅)을 띄우므로 리더만 죽이면 그 자식들이 살아남아 우리
        // 파이프를 붙든 채 고아가 된다. 그룹으로 두면 아래 kill 한 번이 전부를
        // 정리하고, 앱의 시그널(Ctrl+C 등)이 codex에 새어 들어가지도 않는다.
        .process_group(0)
        .spawn()
        .map_err(|_| "codex를 실행하지 못했습니다.".to_string())?;

    // Drain both pipes to sinks — we read the answer from the file, but a full
    // pipe would block the child forever.
    let mut drains = Vec::new();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        drains.push(thread::spawn(move || {
            let mut pipe = pipe;
            let mut sink = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut sink) {
                if n == 0 {
                    break;
                }
            }
        }));
    }

    // The spawned child is its own process-group leader (`process_group(0)`), so
    // its pgid == its pid.
    let pgid = child.id() as i32;
    /// Kill the whole group, then reap the leader. `SIGKILL` (not TERM) because
    /// this only runs on paths where we have already given up on the run.
    fn kill_group(child: &mut std::process::Child, pgid: i32) {
        // SAFETY: `killpg` on a pgid we created ourselves; the only effect is
        // signalling that group. A dead group returns ESRCH, which we ignore.
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
        let _ = child.kill(); // 그룹 신호가 어떤 이유로든 안 닿았을 때의 백스톱
        let _ = child.wait(); // reap — no zombie
    }

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_group(&mut child, pgid);
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            // try_wait 자체가 실패하면 자식의 상태를 더는 알 수 없다 — 그대로
            // 빠져나가면 codex와 그 자식들이 영원히 돈다(리뷰 #10).
            Err(_) => {
                kill_group(&mut child, pgid);
                break None;
            }
        }
    };

    let read_answer = || -> String {
        let Ok(mut f) = std::fs::File::open(&out_path) else { return String::new() };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = f.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if buf.len() >= CAP {
                break;
            }
            let take = n.min(CAP - buf.len());
            buf.extend_from_slice(&chunk[..take]);
        }
        String::from_utf8_lossy(&buf).trim().to_string()
    };

    let result = match status {
        Some(st) if st.success() => {
            let text = read_answer();
            if text.is_empty() {
                Err("codex가 빈 응답을 반환했습니다.".to_string())
            } else {
                Ok(text)
            }
        }
        Some(_) => Err(
            "codex 실행이 실패했습니다 — 로그인(`codex login`)이나 설정을 확인하세요.".to_string(),
        ),
        None => Err("codex 응답이 시간 안에 오지 않았습니다.".to_string()),
    };
    let _ = std::fs::remove_file(&out_path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cwb-codex-{}-{}", name, std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// PATH wins over the nvm fallback.
    #[test]
    fn find_codex_prefers_a_path_entry() {
        let root = scratch("path");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("codex");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        // A home that also has one — PATH must still win.
        let nvm = root.join("home/.nvm/versions/node/v20.0.0/bin");
        std::fs::create_dir_all(&nvm).unwrap();
        std::fs::write(nvm.join("codex"), b"#!/bin/sh\n").unwrap();

        let found = find_codex_in(Some(bin_dir.as_os_str()), Some(&root.join("home")));
        assert_eq!(found.as_deref(), Some(bin.as_path()));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Not on PATH → the nvm layout, newest node version.
    #[test]
    fn find_codex_falls_back_to_newest_nvm_node() {
        let root = scratch("nvm");
        let home = root.join("home");
        for v in ["v18.0.0", "v20.19.6"] {
            let d = home.join(".nvm/versions/node").join(v).join("bin");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("codex"), b"#!/bin/sh\n").unwrap();
        }
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();

        let found = find_codex_in(Some(empty.as_os_str()), Some(&home));
        assert_eq!(
            found,
            Some(home.join(".nvm/versions/node/v20.19.6/bin/codex")),
            "가장 최신 노드 버전이 결정적으로 선택돼야 한다"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// Nothing anywhere = None (the caller renders "설치되어 있는지 확인하세요"),
    /// never a panic and never a bare spawn attempt.
    #[test]
    fn find_codex_missing_is_none() {
        let root = scratch("none");
        assert_eq!(find_codex_in(Some(root.as_os_str()), Some(&root)), None);
        assert_eq!(find_codex_in(None, None), None);
        std::fs::remove_dir_all(&root).ok();
    }
}
