//! codex TUI PTY 스폰 — **순수 터미널 탭**의 백엔드(작업② G).
//!
//! 이 모듈이 `claude`와 나란히 서지 **않고** `terminal`과 나란히 서는 것이
//! 설계의 요점이다. claude 파이프라인(타임라인 폴·스냅샷·adopt·hook 주입·아카이브)은
//! 전부 "앱이 세션 uuid를 미리 정해 `--session-id`로 넘긴다"는 전제 위에 서 있는데
//! **codex에는 그 플래그가 없다**(`codex --help` 전수 확인 — session은 resume/
//! archive/delete/fork 설명에만 나온다). 그래서 uuid를 못 주고, 전사 파일도
//! `~/.codex/sessions/Y/M/D/rollout-<ts>-<uuid>.jsonl`로 경로·스키마가 전부 다르다.
//! claude 배선을 하나라도 붙이면 "조용히 아무것도 안 하는" 기능이 10군데 생긴다.
//!
//! 그래서 여기서 하는 일은 `terminal_create`와 같다 — PTY를 띄우고 출력을
//! relay한다. 그 이상은 없다(타임라인 폴 스레드 없음·스냅샷 없음·ClaudeRuntime
//! 등록 없음·hook `--settings` 없음). rollout 전사를 읽는 타임라인은 작업③.

use std::path::Path;

use core_lib::SessionManager;
use tauri::{AppHandle, State};

use super::AppError;

/// codex 미설치 시 패널에 그대로 보여줄 안내 — 경로나 argv를 담지 않는다
/// (커맨드 오류 문자열 정책, `codex_cli::run_codex_exec`와 같은 문구).
const NOT_FOUND: &str =
    "codex를 찾을 수 없습니다 — 설치되어 있고 PATH에 있는지 확인하세요 (`npm i -g @openai/codex`).";

/// 한 codex 세션의 argv: `<bin> [-m <model>] [-c model_reasoning_effort=<effort>]`.
///
/// `build_claude_args`와 같은 이유로 순수 함수다 — **미선택 경로가 인자 없는
/// `codex` 실행과 바이트 단위로 같아야** 하고(그때는 `~/.codex/config.toml`이
/// 그대로 적용된다), 그건 테스트로만 고정할 수 있다. `None`과 공백 문자열은
/// 둘 다 "미지정" = 플래그를 아예 안 붙인다.
///
/// claude와 갈리는 지점 하나: 강도에 **전용 플래그가 없다**. codex는 임의의
/// config 키를 `-c key=value`로 덮어쓰게 해 두었고(TOML 파싱, 실패 시 리터럴
/// 문자열), 추론 강도는 그 경로로만 지정된다 — 실측으로 TUI 배너가
/// `gpt-5.6-sol low`로 바뀌는 것을 확인했다.
///
/// 그리고 **오값이 안전하지 않다**(claude의 `--effort`와 결정적 차이): codex는
/// 값을 로컬에서 검증하지 않고 그대로 API에 보내며, 모르는 값은 첫 요청이
/// `400 invalid_enum_value`로 죽는다. 그래서 프론트의 강도 목록은 큐레이션이고
/// (`agentOptions.CODEX_EFFORT_CHOICES`), 자유 입력을 노출하지 않는다.
fn build_codex_args(bin: &str, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
    let mut cmd = vec![bin.to_string()];
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        cmd.push("-m".to_string());
        cmd.push(m.to_string());
    }
    if let Some(e) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        cmd.push("-c".to_string());
        cmd.push(format!("model_reasoning_effort={e}"));
    }
    cmd
}

/// 자식 PTY에 줄 PATH — **해석된 codex의 bin 디렉토리를 맨 앞에** 둔다.
///
/// `find_codex`가 돌려주는 nvm 경로는 `codex.js`로 가는 심링크이고 그 shebang은
/// `#!/usr/bin/env node`다. 즉 우리가 절대경로로 exec해도 실제 실행은 `node`를
/// **자식의 PATH에서 다시 찾아** 이뤄진다. node가 nvm에만 있는 머신(= nvm 폴백이
/// 필요한 바로 그 머신)에서 데스크톱 런처의 최소 PATH로는 그 조회가 실패하고
/// 세션이 즉사한다 — 실측:
///
/// ```text
/// $ env -i HOME=$HOME PATH=<빈dir> ~/.nvm/.../bin/codex --version
///   /usr/bin/env: 'node': No such file or directory      EXIT=127
/// $ env -i HOME=$HOME PATH=~/.nvm/.../v20.19.6/bin:<빈dir> … --version
///   codex-cli 0.144.1                                    EXIT=0
/// ```
///
/// 바이너리를 찾은 그 디렉토리에 `node`도 같이 있으므로(nvm 레이아웃) 한 칸
/// 앞세우면 해소된다. 부수 이득: 우연히 존재하는 시스템 node가 아니라 **codex가
/// 설치된 그 node**가 쓰인다.
///
/// PATH를 **덮지 않고 앞에 붙이는** 이유: 나머지 PATH는 codex가 띄우는 자식들
/// (MCP 서버·훅·git)이 쓰는 것이라 잃으면 안 된다. PATH 위에 정식 설치된 codex를
/// 찾은 경우엔 이미 PATH에 있던 디렉토리라 사실상 무변화다.
fn child_path(bin: &Path, current: Option<&str>) -> Option<String> {
    // 심링크를 따라가면 안 된다 — canonicalize는 `lib/node_modules/@openai/codex/
    // bin`(node가 없는 곳)을 가리킨다. 필요한 건 심링크가 놓인 `.../v20/bin`이다.
    let dir = bin.parent()?.to_string_lossy().to_string();
    match current {
        Some(p) if !p.is_empty() => {
            // 이미 맨 앞이면 그대로 — 재스폰마다 같은 칸이 쌓이지 않게.
            if std::env::split_paths(p)
                .next()
                .map(|f| f == Path::new(&dir))
                .unwrap_or(false)
            {
                Some(p.to_string())
            } else {
                Some(format!("{dir}:{p}"))
            }
        }
        _ => Some(dir),
    }
}

/// codex TUI를 `cwd`에 뿌리내린 PTY로 띄우고 출력 relay를 시작한다. 반환은
/// 세션 id — 프론트는 그 뒤로 일반 터미널과 **똑같이** 다룬다(`terminal_write`
/// ·`terminal_resize`·`terminal_snapshot`·`terminal_close`). 그래서 닫기·창
/// 이동·재부착 경로를 새로 만들지 않는다.
///
/// 바이너리 해석은 `codex_cli::find_codex`를 재사용한다 — 앱은 데스크톱 런처가
/// 띄우므로 로그인 셸을 거치지 않고, nvm 설치는 그 PATH에 없다(스모크 실측:
/// 로그인 셸 밖 PATH에서 `codex` 해석 실패, `~/.nvm/versions/node/*/bin/codex`
/// 로만 발견). 못 찾으면 스폰을 시도하지 않고 안내 문구를 오류로 돌려준다 —
/// 패널이 그걸 터미널 안에 찍는다(빈 검은 화면 대신).
#[tauri::command]
pub fn codex_create(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, AppError> {
    let bin = core_lib::codex_cli::find_codex().ok_or_else(|| AppError::new(NOT_FOUND))?;
    let cmd = build_codex_args(&bin.to_string_lossy(), model.as_deref(), effort.as_deref());
    // shim(`#!/usr/bin/env node`)이 node를 찾을 수 있게 — [`child_path`] 참조.
    let envs: Vec<(String, String)> = child_path(&bin, std::env::var("PATH").ok().as_deref())
        .map(|p| vec![("PATH".to_string(), p)])
        .unwrap_or_default();
    let id = mgr
        .create_with_env(Some(cmd), cwd, cols, rows, envs)
        .map_err(AppError::new)?;
    // 구독 실패 시 고아 PTY를 남기지 않는다 (spawn_claude와 같은 방어선).
    let rx = match mgr.subscribe(id) {
        Ok(rx) => rx,
        Err(e) => {
            let _ = mgr.remove(id);
            return Err(AppError::new(e));
        }
    };
    super::spawn_output_relay(app, id, rx, None);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::{build_codex_args, child_path};
    use std::path::Path;

    const BIN: &str = "/home/u/.nvm/versions/node/v20.19.6/bin/codex";
    const BIN_DIR: &str = "/home/u/.nvm/versions/node/v20.19.6/bin";

    /// 미선택 경로 = 인자 없는 `codex` — `~/.codex/config.toml`의 model/
    /// model_reasoning_effort가 그대로 적용된다(실측 대조군: 배너 `gpt-5.6-sol high`).
    #[test]
    fn no_options_is_a_bare_codex() {
        assert_eq!(build_codex_args(BIN, None, None), vec![BIN]);
    }

    /// 프론트에서 새어 나온 빈/공백 문자열은 "미지정"이지 `-m ""`이 아니다.
    /// codex는 강도 오값을 로컬 검증 없이 API로 보내고 400으로 죽으므로, 빈
    /// 값이 `model_reasoning_effort=`로 실려 나가면 세션이 첫 요청에서 죽는다.
    #[test]
    fn blank_options_are_unset() {
        assert_eq!(build_codex_args(BIN, Some(""), Some("   ")), vec![BIN]);
    }

    /// 강도는 전용 플래그가 아니라 config 덮어쓰기 한 쌍(`-c key=value`)이다.
    #[test]
    fn effort_goes_through_a_config_override() {
        assert_eq!(
            build_codex_args(BIN, Some("gpt-5.6-sol"), Some("low")),
            vec![BIN, "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=low"]
        );
    }

    /// 둘은 독립이다 — 한쪽만 골라도 나머지는 config 기본값이 산다.
    #[test]
    fn each_option_is_independent() {
        assert_eq!(
            build_codex_args(BIN, Some("gpt-5.6-sol"), None),
            vec![BIN, "-m", "gpt-5.6-sol"]
        );
        assert_eq!(
            build_codex_args(BIN, None, Some("xhigh")),
            vec![BIN, "-c", "model_reasoning_effort=xhigh"]
        );
    }

    /// 값은 trim만 한다 — argv 벡터로 스폰하므로 인용·이스케이프가 필요 없고,
    /// `-c`의 값은 `key=value` **한 인자**로 합쳐져야 한다(쪼개면 codex가
    /// 그것을 프롬프트로 오해한다).
    #[test]
    fn values_are_trimmed_and_the_override_stays_one_argument() {
        let argv = build_codex_args(BIN, Some("  gpt-5.6-sol "), Some(" medium "));
        assert_eq!(
            argv,
            vec![BIN, "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium"]
        );
        assert_eq!(argv.len(), 5, "config 덮어쓰기는 -c 와 값 두 인자다");
    }

    /// 해석된 절대경로가 그대로 argv[0]이 된다 — PATH 재탐색에 기대지 않는다
    /// (앱 프로세스의 PATH에 codex가 없는 것이 실측된 기본 상황이다).
    #[test]
    fn the_resolved_binary_path_is_argv0() {
        assert_eq!(build_codex_args(BIN, None, None)[0], BIN);
    }

    /// shim의 `#!/usr/bin/env node`가 node를 찾을 수 있어야 한다 — 바이너리를
    /// 찾은 디렉토리(nvm 레이아웃에서 node가 같이 사는 곳)가 맨 앞에 온다.
    #[test]
    fn child_path_puts_the_binary_dir_first() {
        let p = child_path(Path::new(BIN), Some("/usr/bin:/bin")).unwrap();
        assert_eq!(p, format!("{BIN_DIR}:/usr/bin:/bin"));
    }

    /// 기존 PATH를 덮지 않는다 — codex가 띄우는 자식들(MCP·훅·git)이 그걸 쓴다.
    #[test]
    fn child_path_prepends_rather_than_replaces() {
        let p = child_path(Path::new(BIN), Some("/usr/bin:/bin")).unwrap();
        assert!(p.ends_with(":/usr/bin:/bin"), "기존 PATH가 뒤에 그대로 남아야 한다");
    }

    /// 이미 맨 앞이면 중복해서 쌓지 않는다(탭을 열고 닫기를 반복해도 PATH가
    /// 자라지 않는다).
    #[test]
    fn child_path_is_idempotent() {
        let once = child_path(Path::new(BIN), Some("/usr/bin")).unwrap();
        let twice = child_path(Path::new(BIN), Some(&once)).unwrap();
        assert_eq!(once, twice);
    }

    /// PATH가 없거나 비었으면 그 한 칸만 — 빈 문자열을 이어 붙여 `dir:`(빈 항목
    /// = cwd 취급)를 만들지 않는다.
    #[test]
    fn child_path_without_an_existing_path() {
        assert_eq!(child_path(Path::new(BIN), None).unwrap(), BIN_DIR);
        assert_eq!(child_path(Path::new(BIN), Some("")).unwrap(), BIN_DIR);
    }
}
