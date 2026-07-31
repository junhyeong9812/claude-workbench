//! 로컬 hook 수신기 (hook-status task 02).
//!
//! 워크벤치가 스폰한 claude 세션에 `--settings`로 주입된 hook 커맨드(curl)가
//! 상태 이벤트를 POST하면, 검증 후 `claude-hook-status` 이벤트로 웹뷰에
//! 중계한다. 보안 경계(spec §2): 127.0.0.1 바인드 전용 + 요청 헤더 토큰
//! 검증 + 이벤트 화이트리스트 + 바디 크기 상한. 토큰·포트는 argv가 아닌
//! 세션 env로 전달된다(`/proc/<pid>/cmdline`은 타 사용자에게도 노출).
//!
//! 서버 기동 실패는 기능 저하일 뿐 세션을 막지 않는다 — hook 미주입 세션은
//! 프론트가 기존 화면 스캔 폴백으로 처리한다(spec §2 hook 우선/스캔 폴백).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 허용 이벤트 (spec §0: 필수 3종). URL 경로 조각과 1:1.
const ALLOWED_EVENTS: [&str; 3] = ["Stop", "Notification", "UserPromptSubmit"];

/// 요청 바디 상한 — hook stdin JSON은 수백 바이트 수준이라 여유 있게 잡되
/// 무제한 적재는 막는다.
const MAX_BODY: usize = 64 * 1024;

/// 프론트로 중계하는 payload.
#[derive(Clone, Serialize)]
pub struct HookStatusEvent {
    pub uuid: String,
    pub event: String,
}

pub struct HookServer {
    pub port: u16,
    pub token: String,
}

static SERVER: OnceLock<Option<HookServer>> = OnceLock::new();

/// 커널 난수 UUID — 토큰 소스 (claude.rs new_session_uuid와 같은 경로).
fn random_token() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .ok()
        .map(|s| s.trim().to_string())
}

/// 요청 검증·해석 (순수 — 단위 테스트 대상). `head`는 요청줄+헤더 원문,
/// `body`는 바디 바이트. Ok = (이벤트, 세션 uuid) / Err = HTTP 상태코드.
pub fn parse_hook_request(head: &str, body: &[u8], expected_token: &str) -> Result<(String, String), u16> {
    let mut lines = head.lines();
    let request = lines.next().ok_or(400u16)?;
    // "POST /hook/<Event> HTTP/1.1"
    let mut parts = request.split_whitespace();
    if parts.next() != Some("POST") {
        return Err(405);
    }
    let path = parts.next().ok_or(400u16)?;
    let event = path.strip_prefix("/hook/").ok_or(404u16)?;
    if !ALLOWED_EVENTS.contains(&event) {
        return Err(404);
    }
    // 헤더에서 토큰 (case-insensitive) — 상수 비교라 타이밍 부채널은 로컬
    // 단일 사용자 위협모델에서 비대상.
    let mut token: Option<&str> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        if k.trim().eq_ignore_ascii_case("x-workbench-token") {
            token = Some(v.trim());
        }
    }
    if token != Some(expected_token) {
        return Err(403);
    }
    // 바디 = hook stdin JSON — session_id만 뽑는다.
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| 400u16)?;
    let uuid = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(400u16)?;
    Ok((event.to_string(), uuid.to_string()))
}

fn respond(stream: &mut TcpStream, code: u16) {
    let line = match code {
        204 => "HTTP/1.1 204 No Content\r\n\r\n",
        403 => "HTTP/1.1 403 Forbidden\r\n\r\n",
        404 => "HTTP/1.1 404 Not Found\r\n\r\n",
        405 => "HTTP/1.1 405 Method Not Allowed\r\n\r\n",
        _ => "HTTP/1.1 400 Bad Request\r\n\r\n",
    };
    let _ = stream.write_all(line.as_bytes());
}

/// 연결 하나 처리 — 헤더/바디 읽기(상한 적용) 후 검증·중계.
fn handle(app: &AppHandle, token: &str, stream: &mut TcpStream) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    // 헤더 끝(\r\n\r\n)까지 읽기.
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_BODY {
            respond(stream, 400);
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                respond(stream, 400);
                return;
            }
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    // content-length만큼 바디 마저 읽기 (상한 초과 거부).
    let content_length = head
        .lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        respond(stream, 400);
        return;
    }
    let mut body: Vec<u8> = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    }
    match parse_hook_request(&head, &body, token) {
        Ok((event, uuid)) => {
            let _ = app.emit("claude-hook-status", HookStatusEvent { uuid, event });
            respond(stream, 204);
        }
        Err(code) => respond(stream, code),
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// 수신기를 (최초 1회) 기동하고 핸들을 돌려준다. 실패 시 None — 호출자는
/// hook 주입을 생략하고 진행한다(스캔 폴백).
pub fn ensure_started(app: &AppHandle) -> Option<&'static HookServer> {
    SERVER
        .get_or_init(|| {
            let token = random_token()?;
            let listener = TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            let app = app.clone();
            let accept_token = token.clone();
            thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(mut stream) = conn else { continue };
                    // hook 커맨드는 순차·저빈도(턴 경계) — 커넥션당 스레드는
                    // 과설계라 순차 처리, read timeout이 지연 상한.
                    handle(&app, &accept_token, &mut stream);
                }
            });
            Some(HookServer { port, token })
        })
        .as_ref()
}

/// 세션에 주입할 `--settings` JSON — 3이벤트 각각이 stdin(JSON)을 수신기로
/// 그대로 POST한다. 토큰/포트는 env 참조($ 확장은 hook 실행 셸이 수행 —
/// task 01 스모크로 셸 경유 실증). serde_json 직렬화라 이스케이프 안전.
pub fn hook_settings_json() -> String {
    let cmd = |event: &str| {
        format!(
            "curl -s -m 3 -X POST -H \"X-Workbench-Token: $WORKBENCH_HOOK_TOKEN\" --data-binary @- \"http://127.0.0.1:$WORKBENCH_HOOK_PORT/hook/{event}\" >/dev/null 2>&1 || true"
        )
    };
    let hooks: serde_json::Value = serde_json::json!({
        "hooks": ALLOWED_EVENTS
            .iter()
            .map(|ev| {
                (
                    ev.to_string(),
                    serde_json::json!([{ "hooks": [{ "type": "command", "command": cmd(ev) }] }]),
                )
            })
            .collect::<serde_json::Map<String, serde_json::Value>>()
    });
    hooks.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tok-1";

    fn head(path: &str, token: Option<&str>) -> String {
        let mut h = format!("POST {path} HTTP/1.1\r\nHost: x\r\n");
        if let Some(t) = token {
            h.push_str(&format!("X-Workbench-Token: {t}\r\n"));
        }
        h
    }

    #[test]
    fn accepts_valid_request() {
        let body = br#"{"session_id":"u-1","cwd":"/x"}"#;
        let r = parse_hook_request(&head("/hook/Stop", Some(TOKEN)), body, TOKEN);
        assert_eq!(r, Ok(("Stop".into(), "u-1".into())));
    }

    #[test]
    fn rejects_bad_token_and_missing_token() {
        let body = br#"{"session_id":"u"}"#;
        assert_eq!(parse_hook_request(&head("/hook/Stop", Some("wrong")), body, TOKEN), Err(403));
        assert_eq!(parse_hook_request(&head("/hook/Stop", None), body, TOKEN), Err(403));
    }

    #[test]
    fn rejects_unknown_event_and_path() {
        let body = br#"{"session_id":"u"}"#;
        assert_eq!(parse_hook_request(&head("/hook/PreToolUse", Some(TOKEN)), body, TOKEN), Err(404));
        assert_eq!(parse_hook_request(&head("/other", Some(TOKEN)), body, TOKEN), Err(404));
    }

    #[test]
    fn rejects_non_post_and_bad_body() {
        let body = br#"{"session_id":"u"}"#;
        let get = "GET /hook/Stop HTTP/1.1\r\nX-Workbench-Token: tok-1\r\n";
        assert_eq!(parse_hook_request(get, body, TOKEN), Err(405));
        assert_eq!(parse_hook_request(&head("/hook/Stop", Some(TOKEN)), b"not-json", TOKEN), Err(400));
        assert_eq!(
            parse_hook_request(&head("/hook/Stop", Some(TOKEN)), br#"{"session_id":""}"#, TOKEN),
            Err(400)
        );
        assert_eq!(parse_hook_request(&head("/hook/Stop", Some(TOKEN)), br#"{}"#, TOKEN), Err(400));
    }

    #[test]
    fn settings_json_has_three_events_and_env_refs() {
        let s = hook_settings_json();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        for ev in ALLOWED_EVENTS {
            let arr = v["hooks"][ev].as_array().unwrap();
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(&format!("/hook/{ev}")));
            assert!(cmd.contains("$WORKBENCH_HOOK_TOKEN"));
            assert!(cmd.contains("$WORKBENCH_HOOK_PORT"));
            assert_eq!(arr[0]["hooks"][0]["type"], "command");
        }
    }
}
