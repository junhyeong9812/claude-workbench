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
//! 등록 없음·hook `--settings` 없음).
//!
//! 작업③에서 **읽기 전용 타임라인**이 하나 붙었다([`codex_timeline_snapshot`]).
//! 그것도 claude 경로를 지나지 않는다: 전사는 `core_lib::codex_rollout`이 따로
//! 파싱하고, 스폰↔파일 연결은 여기 [`CodexState`]가 들고 있는 스폰 기록만으로
//! 한다. codex 쪽에서 PTY 동작이 달라지는 것은 하나도 없다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use core_lib::codex_rollout::{
    self, MatchOutcome, RolloutCandidate, RolloutParse, SpawnRef, MATCH_SKEW_MS,
};
use core_lib::SessionManager;
use serde::Serialize;
use tauri::{AppHandle, State};

use super::AppError;

/// codex 미설치 시 패널에 그대로 보여줄 안내 — 경로나 argv를 담지 않는다
/// (커맨드 오류 문자열 정책, `codex_cli::run_codex_exec`와 같은 문구).
const NOT_FOUND: &str =
    "codex를 찾을 수 없습니다 — 설치되어 있고 PATH에 있는지 확인하세요 (`npm i -g @openai/codex`).";

/// 한 codex 세션의 argv:
/// `<bin> [--model=<model>] [--config=model_reasoning_effort=<effort>]`.
///
/// `build_claude_args`와 같은 이유로 순수 함수다 — **미선택 경로가 인자 없는
/// `codex` 실행과 바이트 단위로 같아야** 하고(그때는 `~/.codex/config.toml`이
/// 그대로 적용된다), 그건 테스트로만 고정할 수 있다. `None`과 공백 문자열은
/// 둘 다 "미지정" = 플래그를 아예 안 붙인다.
///
/// claude와 갈리는 지점 하나: 강도에 **전용 플래그가 없다**. codex는 임의의
/// config 키를 `--config <key>=<value>`로 덮어쓰게 해 두었고(TOML 파싱, 실패 시
/// 리터럴 문자열), 추론 강도는 그 경로로만 지정된다 — 실측으로 TUI 배너가
/// `gpt-5.6-sol low`로 바뀌는 것을 확인했다.
///
/// 그리고 **오값이 안전하지 않다**(claude의 `--effort`와 결정적 차이): codex는
/// 값을 로컬에서 검증하지 않고 그대로 API에 보내며, 모르는 값은 첫 요청이
/// `400 invalid_enum_value`로 죽는다. 그래서 프론트의 강도 목록은 큐레이션이고
/// (`agentOptions.CODEX_EFFORT_CHOICES`), 자유 입력을 노출하지 않는다.
/// **여기서 어휘를 다시 검증하지는 않는다** — 어휘의 단일 출처는 프론트 목록이고,
/// 백엔드에 두 번째 목록을 두면 codex가 값을 늘릴 때마다 두 곳이 갈린다.
///
/// 값은 **등호형**(`--model=<v>` / `--config=<k>=<v>`)으로 붙인다. 분리형이면
/// 하이픈으로 시작하는 값이 다음 **옵션으로 재해석**된다 — 실측:
///
/// ```text
/// $ codex -m -x --help
///   error: unexpected argument '-x' found
///   tip: to pass '-x' as a value, use '-- -x'
/// ```
///
/// 지금 프론트 어휘엔 그런 값이 없지만, 등호형은 그 가정에 기대지 않는 형태다.
fn build_codex_args(bin: &str, model: Option<&str>, effort: Option<&str>) -> Vec<String> {
    let mut cmd = vec![bin.to_string()];
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        cmd.push(format!("--model={m}"));
    }
    if let Some(e) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        cmd.push(format!("--config=model_reasoning_effort={e}"));
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
#[allow(clippy::too_many_arguments)]
pub fn codex_create(
    app: AppHandle,
    mgr: State<'_, SessionManager>,
    state: State<'_, CodexState>,
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
    // 전사 매칭의 두 입력(스폰 시각·cwd)을 **스폰 직전에** 잡는다. codex는 기동
    // 0.9초 뒤 세션을 열고 그 시각을 전사 첫 줄에 쓴다(실측) — 여기가 그 창의
    // 시작점이다. cwd는 codex가 `session_meta.cwd`에 적는 것과 같은 형태여야
    // 하므로 canonical로 맞춘다(심링크·`..` 표기 차이로 매칭이 조용히 실패하지
    // 않게).
    let spawned_ms = now_ms();
    let match_cwd = cwd.as_deref().and_then(canonical_str);
    let id = mgr
        .create_with_env(Some(cmd), cwd, cols, rows, envs)
        .map_err(AppError::new)?;
    state.register(id, match_cwd, spawned_ms);
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

// ===========================================================================
// 타임라인 (작업③ H) — 스폰 ↔ rollout 전사 연결 + 읽기 전용 스냅샷
// ===========================================================================

/// 표시 경계에서 자르는 도구 출력 상한. claude 쪽과 같은 32KB지만 **상수를 공유
/// 하지 않는다** — 두 경로를 엮지 않는 것이 이 기능의 불변식이고, 이건 12줄짜리
/// 순수 규칙이다. codex엔 원문 lazy 조회(`claude_item_detail` 상당)가 없으므로
/// 자른 자리에 그 사실을 남긴다(무음 절단 금지).
const CONTENT_CAP: usize = 32 * 1024;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn canonical_str(p: &str) -> Option<String> {
    std::fs::canonicalize(p).ok().map(|c| c.to_string_lossy().to_string())
}

/// 살아 있는 codex 탭 하나의 스폰 기록.
struct CodexSession {
    cwd: Option<String>,
    spawned_ms: i64,
    /// 한 번 확정되면 유지한다(sticky). 나중에 같은 창에 새 전사가 생겨도 이미
    /// 잡은 파일이 흔들리지 않고, 그 파일은 다른 탭의 후보에서도 빠진다.
    resolved: Option<PathBuf>,
    /// 마지막으로 돌려준 (파일 서명, 페이로드) — 폴링이 같은 내용을 반복해서
    /// 직렬화·전송하지 않게.
    cache: Option<(String, RolloutParse)>,
}

/// codex 탭들의 스폰 기록. **매칭의 유일한 출처**다.
#[derive(Default)]
pub struct CodexState(Mutex<HashMap<u64, CodexSession>>);

impl CodexState {
    fn register(&self, id: u64, cwd: Option<String>, spawned_ms: i64) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(id, CodexSession { cwd, spawned_ms, resolved: None, cache: None });
        }
    }
}

/// 뷰가 받는 것. `status`가 `matched`가 아니면 `snapshot`은 없고 `note`가 이유를
/// 사람 말로 담는다 — 빈 화면만 남기지 않는다(spec ②, 무음 금지).
#[derive(Serialize)]
pub struct CodexTimelinePayload {
    /// `matched` | `searching` | `contested` | `ambiguous` | `unavailable`
    status: &'static str,
    note: Option<String>,
    /// 매칭된 전사 파일 경로(표시·디버깅용).
    path: Option<String>,
    /// 파일 서명. 프론트가 다음 폴에 `since`로 되돌려 주면 변화 없을 때
    /// `unchanged`만 돌아온다(전사 전문을 1.5초마다 재전송하지 않게).
    fingerprint: Option<String>,
    unchanged: bool,
    snapshot: Option<RolloutParse>,
}

impl CodexTimelinePayload {
    fn pending(status: &'static str, note: impl Into<String>) -> Self {
        Self {
            status,
            note: Some(note.into()),
            path: None,
            fingerprint: None,
            unchanged: false,
            snapshot: None,
        }
    }
}

/// 파일의 (길이, 수정시각) 서명 — 내용이 바뀌었는지 싸게 판별한다.
fn file_sig(path: &Path) -> Option<String> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(format!("{}:{mtime}", md.len()))
}

/// `~/.codex/sessions` 아래의 전사 후보를 모은다.
///
/// **mtime 선필터**가 비용을 잡는다: 전사 파일은 세션이 열린 뒤에 만들어지므로
/// `mtime >= 스폰시각 - 오차`가 반드시 성립한다(≒ 후보를 몇 개로 줄인다).
/// 첫 줄을 읽는 것은 그 통과분에만 한다.
fn scan_candidates(root: &Path, not_before_ms: i64) -> Vec<RolloutCandidate> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let recent = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64 >= not_before_ms)
                .unwrap_or(false);
            if !recent {
                continue;
            }
            let meta = codex_rollout::read_meta(&p);
            out.push(RolloutCandidate {
                path: p,
                cwd: meta.as_ref().and_then(|m| m.cwd.clone()),
                started_ms: meta.as_ref().and_then(|m| m.started_ms),
            });
        }
    }
    out
}

/// 표시 경계 절단 — 자른 아이템은 자른 사실을 본문에 남긴다.
fn cap_contents(items: &mut [core_lib::TimelineItem]) {
    for it in items.iter_mut() {
        let Some(text) = it.content_text.as_ref() else { continue };
        if text.len() <= CONTENT_CAP {
            continue;
        }
        let mut cut = CONTENT_CAP;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        let full = text.len();
        it.content_text = Some(format!("{}\n\n… (전체 {full}바이트 중 앞부분만)", &text[..cut]));
        it.content_truncated = true;
    }
}

/// 이 codex 탭의 전사 타임라인을 돌려준다. 프론트가 타임라인을 펼친 동안 주기적
/// 으로 부른다.
///
/// **폴링을 고른 이유**: claude 쪽은 세션마다 tail 스레드를 띄우지만(라이브 이벤트
/// 계약이 있어서), codex 전사는 ①스폰 시점에 파일이 아예 없고(첫 메시지 때 생긴다)
/// ②경로를 매 번 다시 찾아야 하며 ③파일이 작다(실전사 평균 48줄). 감시 스레드를
/// 붙이면 "아직 없는 파일을 기다리는 스레드"의 수명·정리 문제가 새로 생기는데,
/// 얻는 것은 1.5초의 지연뿐이다. 대신 (길이,mtime) 서명으로 **변화 없을 때는
/// 전사를 다시 읽지도, 다시 보내지도 않는다**.
#[tauri::command]
pub fn codex_timeline_snapshot(
    mgr: State<'_, SessionManager>,
    state: State<'_, CodexState>,
    id: u64,
    since: Option<String>,
) -> Result<CodexTimelinePayload, AppError> {
    let Some(root) = codex_rollout::codex_sessions_root().filter(|r| r.is_dir()) else {
        return Ok(CodexTimelinePayload::pending(
            "unavailable",
            "codex 전사 디렉토리(~/.codex/sessions)가 없습니다.",
        ));
    };
    let mut guard = self_lock(&state)?;
    // 죽은 탭의 기록은 버린다 — 남아 있으면 그 탭의 창이 다른 탭의 후보를 영원히
    // 가로막는다(Contested 고착).
    guard.retain(|sid, _| mgr.exists(*sid));

    let Some(me) = guard.get(&id) else {
        return Ok(CodexTimelinePayload::pending(
            "unavailable",
            "이 탭의 codex 세션 정보를 앱이 들고 있지 않습니다 (앱 재시작 후 재부착된 탭).",
        ));
    };
    let (spawned_ms, cwd) = (me.spawned_ms, me.cwd.clone());

    // 이미 잡은 파일이 있으면 다시 찾지 않는다(sticky).
    let matched = match me.resolved.clone() {
        Some(p) if p.is_file() => Some(p),
        _ => {
            let target = SpawnRef { id, cwd, spawned_ms };
            // 후보를 다투는 상대 = **아직 자기 전사를 못 잡은** 다른 탭들. 이미
            // 잡은 탭은 새 파일을 가져갈 일이 없으므로 남을 막지 않는다.
            let live: Vec<SpawnRef> = guard
                .iter()
                .filter(|(_, s)| s.resolved.is_none())
                .map(|(sid, s)| SpawnRef {
                    id: *sid,
                    cwd: s.cwd.clone(),
                    spawned_ms: s.spawned_ms,
                })
                .collect();
            let claimed: Vec<PathBuf> = guard.values().filter_map(|s| s.resolved.clone()).collect();
            let cands = scan_candidates(&root, spawned_ms - MATCH_SKEW_MS);
            match codex_rollout::match_rollout(&target, &live, &cands, &claimed) {
                MatchOutcome::Matched(p) => {
                    if let Some(s) = guard.get_mut(&id) {
                        s.resolved = Some(p.clone());
                    }
                    Some(p)
                }
                MatchOutcome::NoCandidate => {
                    return Ok(CodexTimelinePayload::pending(
                        "searching",
                        "전사를 찾지 못했습니다 — codex는 첫 메시지를 보낼 때 전사 파일을 만듭니다.",
                    ))
                }
                MatchOutcome::Contested => {
                    return Ok(CodexTimelinePayload::pending(
                        "contested",
                        "전사를 찾지 못했습니다 — 같은 프로젝트에서 codex 탭이 거의 동시에 열려 어느 전사가 이 탭의 것인지 확정할 수 없습니다.",
                    ))
                }
                MatchOutcome::Multiple => {
                    return Ok(CodexTimelinePayload::pending(
                        "ambiguous",
                        "전사를 찾지 못했습니다 — 같은 시각·같은 폴더에 codex 세션이 둘 이상 열렸습니다.",
                    ))
                }
            }
        }
    };
    let Some(path) = matched else {
        return Ok(CodexTimelinePayload::pending("searching", "전사를 찾지 못했습니다."));
    };

    let sig = file_sig(&path);
    if sig.is_some() && sig == since {
        return Ok(CodexTimelinePayload {
            status: "matched",
            note: None,
            path: Some(path.to_string_lossy().to_string()),
            fingerprint: sig,
            unchanged: true,
            snapshot: None,
        });
    }
    // 서명이 같은 캐시가 있으면 파일을 다시 읽지 않는다(다른 창이 같은 탭을
    // 처음 물었을 때처럼 since가 없는 호출).
    if let (Some(s), Some(entry)) = (sig.as_ref(), guard.get(&id).and_then(|s| s.cache.as_ref())) {
        if &entry.0 == s {
            return Ok(CodexTimelinePayload {
                status: "matched",
                note: None,
                path: Some(path.to_string_lossy().to_string()),
                fingerprint: sig.clone(),
                unchanged: false,
                snapshot: Some(entry.1.clone()),
            });
        }
    }

    let mut parsed = codex_rollout::parse_rollout(&path)
        .map_err(|_| AppError::new("전사 파일을 읽지 못했습니다."))?;
    cap_contents(&mut parsed.items);
    if let (Some(s), Some(slot)) = (sig.clone(), guard.get_mut(&id)) {
        slot.cache = Some((s, parsed.clone()));
    }
    Ok(CodexTimelinePayload {
        status: "matched",
        note: None,
        path: Some(path.to_string_lossy().to_string()),
        fingerprint: sig,
        unchanged: false,
        snapshot: Some(parsed),
    })
}

fn self_lock<'a>(
    state: &'a State<'_, CodexState>,
) -> Result<std::sync::MutexGuard<'a, HashMap<u64, CodexSession>>, AppError> {
    state.0.lock().map_err(|_| AppError::new("codex 세션 상태를 읽지 못했습니다."))
}

#[cfg(test)]
mod tests {
    use super::{build_codex_args, cap_contents, child_path, CONTENT_CAP};
    use std::path::Path;

    const BIN: &str = "/home/u/.nvm/versions/node/v20.19.6/bin/codex";
    const BIN_DIR: &str = "/home/u/.nvm/versions/node/v20.19.6/bin";

    /// 미선택 경로 = 인자 없는 `codex` — `~/.codex/config.toml`의 model/
    /// model_reasoning_effort가 그대로 적용된다(실측 대조군: 배너 `gpt-5.6-sol high`).
    #[test]
    fn no_options_is_a_bare_codex() {
        assert_eq!(build_codex_args(BIN, None, None), vec![BIN]);
    }

    /// 프론트에서 새어 나온 빈/공백 문자열은 "미지정"이지 `--model=`이 아니다.
    /// codex는 강도 오값을 로컬 검증 없이 API로 보내고 400으로 죽으므로, 빈
    /// 값이 `model_reasoning_effort=`로 실려 나가면 세션이 첫 요청에서 죽는다.
    #[test]
    fn blank_options_are_unset() {
        assert_eq!(build_codex_args(BIN, Some(""), Some("   ")), vec![BIN]);
    }

    /// 강도는 전용 플래그가 아니라 config 덮어쓰기(`--config=key=value`)다.
    #[test]
    fn effort_goes_through_a_config_override() {
        assert_eq!(
            build_codex_args(BIN, Some("gpt-5.6-sol"), Some("low")),
            vec![BIN, "--model=gpt-5.6-sol", "--config=model_reasoning_effort=low"]
        );
    }

    /// 둘은 독립이다 — 한쪽만 골라도 나머지는 config 기본값이 산다.
    #[test]
    fn each_option_is_independent() {
        assert_eq!(
            build_codex_args(BIN, Some("gpt-5.6-sol"), None),
            vec![BIN, "--model=gpt-5.6-sol"]
        );
        assert_eq!(
            build_codex_args(BIN, None, Some("xhigh")),
            vec![BIN, "--config=model_reasoning_effort=xhigh"]
        );
    }

    /// 값은 trim만 한다 — argv 벡터로 스폰하므로 인용·이스케이프가 필요 없다.
    /// 등호형이라 옵션과 값이 **한 인자**로 묶인다(쪼개지면 하이픈으로 시작하는
    /// 값이 다음 옵션으로 재해석되거나 프롬프트로 오해된다).
    #[test]
    fn values_are_trimmed_and_the_override_stays_one_argument() {
        let argv = build_codex_args(BIN, Some("  gpt-5.6-sol "), Some(" medium "));
        assert_eq!(
            argv,
            vec![BIN, "--model=gpt-5.6-sol", "--config=model_reasoning_effort=medium"]
        );
        assert_eq!(argv.len(), 3, "등호형이라 옵션 하나가 인자 하나다");
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

    fn item(text: &str) -> core_lib::TimelineItem {
        core_lib::TimelineItem {
            session_id: "s".into(),
            tool_call_id: "c".into(),
            turn: 1,
            seq: 0,
            kind: core_lib::ItemKind::Execute,
            title: "t".into(),
            locations: Vec::new(),
            project_label: None,
            cwd: None,
            diffs: Vec::new(),
            content_text: Some(text.to_string()),
            content_truncated: false,
            raw_input: None,
            agent_status: core_lib::AgentStatus::Completed,
            write_status: core_lib::WriteStatus::None,
            revision: 0,
        }
    }

    /// codex엔 원문 lazy 조회가 없으므로 **자른 사실이 화면에 남아야** 한다 —
    /// 조용히 잘리면 사용자는 도구 출력이 원래 그만큼이라고 읽는다.
    #[test]
    fn capping_marks_the_cut_and_keeps_short_output_untouched() {
        let mut items = vec![item(&"a".repeat(CONTENT_CAP + 10)), item("짧다")];
        cap_contents(&mut items);
        assert!(items[0].content_truncated);
        assert!(items[0].content_text.as_deref().unwrap().contains("앞부분만"));
        assert!(!items[1].content_truncated);
        assert_eq!(items[1].content_text.as_deref(), Some("짧다"));
    }

    /// 멀티바이트 경계에서 잘라도 문자열이 깨지지 않는다(한국어 출력이 기본이다).
    #[test]
    fn capping_respects_char_boundaries() {
        let mut items = vec![item(&"가".repeat(CONTENT_CAP))];
        cap_contents(&mut items);
        assert!(items[0].content_text.is_some(), "패닉 없이 잘려야 한다");
    }
}
