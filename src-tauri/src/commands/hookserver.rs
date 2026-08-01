//! 로컬 hook 수신기 (hook-status task 02, 듀얼리뷰 반영).
//!
//! 워크벤치가 스폰한 claude 세션에 `--settings`로 주입된 hook 커맨드(curl)가
//! 상태 이벤트를 POST하면, 검증 후 `claude-hook-status` 이벤트로 웹뷰에
//! 중계한다.
//!
//! 보안 경계(spec §2 + 리뷰 H1~H4):
//! - 127.0.0.1 바인드 전용, 이벤트 화이트리스트, 헤더/바디 크기 상한.
//! - **세션별 토큰**: 스폰마다 토큰을 발급해 `token → session uuid`로 등록,
//!   바디의 session_id와 대조한다 — 한 세션(오염 가능 주체)이 다른 세션의
//!   배지를 위조하지 못한다.
//! - 토큰은 argv에 싣지 않는다: 0600 헤더 파일(`X-Workbench-Token: …`)로
//!   쓰고 hook 커맨드는 `curl -H @$WORKBENCH_HOOK_HDR`로 참조 — claude와
//!   curl 어느 쪽 `/proc/<pid>/cmdline`에도 토큰 값이 나타나지 않는다
//!   (cmdline은 타 사용자에게도 world-readable — 리뷰 H1).
//! - HTTP framing 엄격화: content-length는 정확히 1개·숫자만, 초과 수신·
//!   Transfer-Encoding은 400 — 무음 축소 없음(리뷰 H2).
//! - 커넥션당 스레드(동시 상한) + 짧은 read 타임아웃·회수 상한 — 느린 로컬
//!   연결 하나가 전체 hook 처리를 세우지 못한다(slowloris, 리뷰 H3).
//!
//! 서버·등록 실패는 기능 저하일 뿐 세션을 막지 않는다(주입 생략 → 프론트
//! 화면 스캔 폴백). 스레드 스폰 실패도 panic이 아니라 None이다(리뷰 H7).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 허용 이벤트 (spec §0: 필수 3종). URL 경로 조각과 1:1.
const ALLOWED_EVENTS: [&str; 3] = ["Stop", "Notification", "UserPromptSubmit"];

/// 요청 헤더/바디 상한 — hook stdin JSON은 수백 바이트 수준.
const MAX_HEAD: usize = 8 * 1024;
const MAX_BODY: usize = 64 * 1024;
/// 커넥션당 read() 호출 상한 — 타임아웃(500ms)과 함께 slowloris의 절대 상한
/// (커넥션당 최악 ~16s, 동시 8 상한). 동일 UID 악성 프로세스의 고의 점유는
/// 위협모델 밖(그 권한이면 앱 종료·파일 읽기가 이미 가능) — 이 상한은
/// 버그성 슬로우 클라이언트 방어용이다.
const MAX_READS: usize = 32;
/// 동시 처리 커넥션 상한 — 초과분은 즉시 닫는다(hook은 저빈도·재발화 가능).
const MAX_CONNS: usize = 8;

/// 프론트로 중계하는 payload.
#[derive(Clone, Serialize)]
pub struct HookStatusEvent {
    pub uuid: String,
    pub event: String,
}

pub struct HookServer {
    pub port: u16,
    /// token → session uuid (세션별 토큰 — 리뷰 H4).
    registry: Arc<Mutex<HashMap<String, String>>>,
    /// 세션별 토큰 헤더 파일 디렉토리 (0700, 파일 0600).
    hdr_dir: PathBuf,
}

static SERVER: OnceLock<Option<HookServer>> = OnceLock::new();

/// 커널 난수 UUID — 토큰/세션 id 소스.
fn random_token() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .ok()
        .map(|s| s.trim().to_string())
}

/// 파일명에 쓰이는 uuid의 엄격 검증 (감사 신규 P1 — 경로 조작 차단).
/// 커널 UUID 형식(hex + '-')만 허용: `..`·`/`·절대경로가 원천 배제된다.
pub fn is_safe_uuid(uuid: &str) -> bool {
    !uuid.is_empty()
        && uuid.len() <= 64
        && uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

impl HookServer {
    /// 세션 스폰 시 호출: 세션 전용 토큰을 발급·등록하고 0600 헤더 파일
    /// 경로를 돌려준다(env `WORKBENCH_HOOK_HDR`로 전달). 같은 uuid의 재스폰
    /// (resume)은 이전 토큰을 대체한다. 실패 = None(주입 생략).
    pub fn register_session(&self, uuid: &str) -> Option<String> {
        if !is_safe_uuid(uuid) {
            return None; // 경로 조작 가능 문자열 — 주입 생략(감사 P1)
        }
        let token = random_token()?;
        {
            let mut reg = self.registry.lock().ok()?;
            reg.retain(|_, v| v != uuid); // 같은 세션의 옛 토큰 폐기
            reg.insert(token.clone(), uuid.to_string());
        }
        let path = self.hdr_dir.join(format!("{uuid}.hdr"));
        std::fs::write(&path, format!("X-Workbench-Token: {token}\n")).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok()?;
        }
        Some(path.to_string_lossy().to_string())
    }

}

type Registry = Arc<Mutex<HashMap<String, String>>>;

fn uuid_for_token(reg: &Registry, token: &str) -> Option<String> {
    reg.lock().ok()?.get(token).cloned()
}

/// framing (순수 — 리뷰 H8: I/O를 `Read` 제네릭으로 받아 단위 테스트 가능).
/// 헤더(\r\n\r\n까지, MAX_HEAD)와 정확히 content-length만큼의 바디를 읽는다.
/// 엄격 규칙(H2): content-length는 정확히 1개·유효 숫자, Transfer-Encoding
/// 거부, 선언 길이 초과 수신은 400(파이프라이닝 미지원 명시).
pub fn read_request<R: Read>(r: &mut R) -> Result<(String, Vec<u8>), u16> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let mut reads = 0usize;
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEAD || reads >= MAX_READS {
            return Err(400);
        }
        match r.read(&mut chunk) {
            Ok(0) => return Err(400),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => return Err(408),
        }
        reads += 1;
    };
    // 종료 마커가 상한 초과 지점에서 발견돼도 캡은 유효해야 한다 (테스트 실측).
    if header_end > MAX_HEAD {
        return Err(400);
    }
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    // content-length: 정확히 1개, 숫자만 (무음 축소 금지 — H2/H10).
    let mut cl: Option<usize> = None;
    for l in head.lines().skip(1) {
        let Some((k, v)) = l.split_once(':') else { continue };
        let k = k.trim();
        if k.eq_ignore_ascii_case("transfer-encoding") {
            return Err(400);
        }
        if k.eq_ignore_ascii_case("content-length") {
            if cl.is_some() {
                return Err(400); // 중복
            }
            let t = v.trim();
            // 숫자만 — parse::<usize>는 "+1"도 허용한다(감사 H2 부분).
            if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
                return Err(400);
            }
            cl = Some(t.parse::<usize>().map_err(|_| 400u16)?);
        }
    }
    let content_length = cl.ok_or(400u16)?;
    if content_length > MAX_BODY {
        return Err(400);
    }
    let mut body: Vec<u8> = buf[header_end + 4..].to_vec();
    while body.len() < content_length {
        if reads >= MAX_READS {
            return Err(400);
        }
        match r.read(&mut chunk) {
            Ok(0) => return Err(400),
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => return Err(408),
        }
        reads += 1;
    }
    if body.len() > content_length {
        return Err(400); // 초과 수신(파이프라이닝) — 지원하지 않음을 명시 거부
    }
    Ok((head, body))
}

/// 요청 해석 (순수). Ok = (이벤트, 토큰, 바디의 session uuid) / Err = 상태코드.
/// 토큰↔uuid 대조는 호출자(레지스트리 소유)가 한다.
pub fn parse_hook_request(head: &str, body: &[u8]) -> Result<(String, String, String), u16> {
    let mut lines = head.lines();
    let request = lines.next().ok_or(400u16)?;
    let mut parts = request.split_whitespace();
    if parts.next() != Some("POST") {
        return Err(405);
    }
    let path = parts.next().ok_or(400u16)?;
    let event = path.strip_prefix("/hook/").ok_or(404u16)?;
    if !ALLOWED_EVENTS.contains(&event) {
        return Err(404);
    }
    let mut token: Option<&str> = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        let k = k.trim();
        if k.eq_ignore_ascii_case("x-workbench-token") {
            token = Some(v.trim());
        } else if k.eq_ignore_ascii_case("host") {
            // 심층 방어(H13): 호스트부 **정확 일치**만 허용 — starts_with는
            // `localhost.evil`을 통과시킨다(감사 H13 부분).
            let hpart = v.trim().split(':').next().unwrap_or("");
            if hpart != "127.0.0.1" && hpart != "localhost" {
                return Err(400);
            }
        }
    }
    // 일반 비교 — 타이밍 부채널은 이 위협모델(로컬 단일 사용자, 영향=배지
    // 표시) 밖이라 상수시간 비교를 요구하지 않는다 (리뷰 H12 주석 정정).
    let token = token.ok_or(403u16)?;
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| 400u16)?;
    let uuid = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .ok_or(400u16)?;
    Ok((event.to_string(), token.to_string(), uuid.to_string()))
}

fn respond(stream: &mut TcpStream, code: u16) {
    let line = match code {
        204 => "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
        403 => "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
        404 => "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
        405 => "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n",
        408 => "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n",
        _ => "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
    };
    let _ = stream.write_all(line.as_bytes());
}

/// 커넥션 하나 처리 — framing → 해석 → 토큰↔uuid 대조 → 중계.
fn handle(app: &AppHandle, registry: &Registry, stream: &mut TcpStream) {
    // 짧은 per-read 타임아웃 + read 회수 상한(read_request) = 절대 지연 상한.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
    let (head, body) = match read_request(stream) {
        Ok(hb) => hb,
        Err(code) => {
            respond(stream, code);
            return;
        }
    };
    match parse_hook_request(&head, &body) {
        Ok((event, token, uuid)) => {
            // 세션별 토큰 대조(H4): 토큰 소유 세션과 바디 session_id 일치 필수.
            if uuid_for_token(registry, &token).as_deref() != Some(uuid.as_str()) {
                respond(stream, 403);
                return;
            }
            let _ = app.emit("claude-hook-status", HookStatusEvent { uuid, event });
            respond(stream, 204);
        }
        Err(code) => respond(stream, code),
    }
}

/// 수신기를 (최초 1회) 기동. 실패 = None(경고 1회 로그 — H11) — 호출자는
/// hook 주입을 생략하고 진행한다(스캔 폴백).
pub fn ensure_started(app: &AppHandle) -> Option<&'static HookServer> {
    SERVER
        .get_or_init(|| {
            let init = || -> Option<HookServer> {
                // 프로세스별 하위 디렉토리(감사 신규 P2): 전체 remove_dir_all은
                // 두 번째 인스턴스가 첫 인스턴스의 활성 헤더를 지운다 — 자기
                // 디렉토리(`<pid>`)만 만들고, 죽은 pid의 잔여 디렉토리만 청소.
                let base = app.path().app_data_dir().ok()?.join("hook-hdrs");
                std::fs::create_dir_all(&base).ok()?;
                if let Ok(entries) = std::fs::read_dir(&base) {
                    for ent in entries.flatten() {
                        let name = ent.file_name();
                        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
                            continue;
                        };
                        if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                            let _ = std::fs::remove_dir_all(ent.path());
                        }
                    }
                }
                let hdr_dir = base.join(std::process::id().to_string());
                std::fs::create_dir_all(&hdr_dir).ok()?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&hdr_dir, std::fs::Permissions::from_mode(0o700))
                        .ok()?;
                }
                let listener = TcpListener::bind("127.0.0.1:0").ok()?;
                let port = listener.local_addr().ok()?.port();
                let registry: Arc<Mutex<HashMap<String, String>>> =
                    Arc::new(Mutex::new(HashMap::new()));
                let app = app.clone();
                let reg = registry.clone();
                // panic 금지 경로(H7): Builder + Err→None.
                thread::Builder::new()
                    .name("workbench-hook-server".into())
                    .spawn(move || {
                        let active = Arc::new(AtomicUsize::new(0));
                        for conn in listener.incoming() {
                            let Ok(mut stream) = conn else { continue };
                            // 동시 상한(H3): 초과분은 즉시 닫는다 — hook은
                            // 턴 경계 저빈도라 정상 트래픽이 걸릴 일이 없다.
                            if active.load(Ordering::Relaxed) >= MAX_CONNS {
                                respond(&mut stream, 400);
                                continue;
                            }
                            let app = app.clone();
                            let reg = reg.clone();
                            let active2 = active.clone();
                            active.fetch_add(1, Ordering::Relaxed);
                            let spawned = thread::Builder::new()
                                .name("workbench-hook-conn".into())
                                .spawn(move || {
                                    handle(&app, &reg, &mut stream);
                                    active2.fetch_sub(1, Ordering::Relaxed);
                                });
                            if spawned.is_err() {
                                active.fetch_sub(1, Ordering::Relaxed);
                            }
                        }
                    })
                    .ok()?;
                Some(HookServer { port, registry, hdr_dir })
            };
            let r = init();
            if r.is_none() {
                eprintln!(
                    "[hookserver] 기동 실패 — hook 주입을 생략합니다 (배지는 화면 스캔 폴백)"
                );
            }
            r
        })
        .as_ref()
}

/// 세션에 주입할 `--settings` JSON — 3이벤트 각각이 stdin(JSON)을 수신기로
/// 그대로 POST한다. 토큰은 0600 헤더 파일을 `-H @` 로 참조(H1 — argv에
/// 값이 실리지 않는다), 포트/파일 경로는 env 참조($ 확장은 hook 실행 셸이
/// 수행 — task 01 스모크로 셸 경유 실증). serde_json 직렬화라 이스케이프 안전.
pub fn hook_settings_json() -> String {
    let cmd = |event: &str| {
        format!(
            "curl -s -m 3 -X POST -H @\"$WORKBENCH_HOOK_HDR\" --data-binary @- \"http://127.0.0.1:$WORKBENCH_HOOK_PORT/hook/{event}\" >/dev/null 2>&1 || true"
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

    fn req(path: &str, token: Option<&str>, body: &[u8], extra: &str) -> Vec<u8> {
        let mut h = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:9\r\n");
        if let Some(t) = token {
            h.push_str(&format!("X-Workbench-Token: {t}\r\n"));
        }
        h.push_str(&format!("Content-Length: {}\r\n", body.len()));
        h.push_str(extra);
        h.push_str("\r\n");
        let mut out = h.into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// 분할 수신 시뮬레이터 — n바이트씩 흘려보내는 Reader (리뷰 H8).
    struct Chunked<'a> {
        data: &'a [u8],
        pos: usize,
        step: usize,
    }
    impl Read for Chunked<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.step.min(self.data.len() - self.pos).min(buf.len());
            buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    fn framed(raw: &[u8], step: usize) -> Result<(String, Vec<u8>), u16> {
        read_request(&mut Chunked { data: raw, pos: 0, step })
    }

    #[test]
    fn accepts_valid_request_whole_and_split() {
        let body = br#"{"session_id":"u-1","cwd":"/x"}"#;
        let raw = req("/hook/Stop", Some(TOKEN), body, "");
        // step=1(드립)은 MAX_READS에 의도적으로 걸린다 — 정상 클라이언트(curl)는
        // 요청을 1~2회 write로 보내므로 현실 분할 폭만 검증한다.
        for step in [raw.len(), 16, 7] {
            let (head, got) = framed(&raw, step).expect("frame");
            assert_eq!(got, body);
            let (ev, tok, uuid) = parse_hook_request(&head, &got).expect("parse");
            assert_eq!((ev.as_str(), tok.as_str(), uuid.as_str()), ("Stop", TOKEN, "u-1"));
        }
    }

    #[test]
    fn framing_rejects_bad_content_length() {
        let body = br#"{"session_id":"u"}"#;
        // 선언 길이 < 실제 수신(초과분 동봉) — 400
        let mut raw = format!(
            "POST /hook/Stop HTTP/1.1\r\nContent-Length: 1\r\n\r\n"
        )
        .into_bytes();
        raw.extend_from_slice(body);
        assert_eq!(framed(&raw, raw.len()), Err(400));
        // content-length 중복 — 400
        let raw = req("/hook/Stop", Some(TOKEN), body, "Content-Length: 5\r\n");
        assert_eq!(framed(&raw, raw.len()), Err(400));
        // 비숫자·부호 — 400 (parse::<usize>는 "+1"을 허용하므로 digits-only 검사)
        let raw = b"POST /x HTTP/1.1\r\nContent-Length: abc\r\n\r\n".to_vec();
        assert_eq!(framed(&raw, raw.len()), Err(400));
        let raw = b"POST /x HTTP/1.1\r\nContent-Length: +2\r\n\r\n{}".to_vec();
        assert_eq!(framed(&raw, raw.len()), Err(400));
        // content-length 부재 — 400
        let raw = b"POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n{}".to_vec();
        assert_eq!(framed(&raw, raw.len()), Err(400));
        // Transfer-Encoding — 400
        let raw = b"POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}".to_vec();
        assert_eq!(framed(&raw, raw.len()), Err(400));
    }

    #[test]
    fn framing_caps_header_and_body() {
        let huge = "X-Pad: ".to_string() + &"a".repeat(MAX_HEAD + 10) + "\r\n";
        let raw = req("/hook/Stop", Some(TOKEN), b"{}", &huge);
        assert_eq!(framed(&raw, 2048), Err(400));
        let raw = format!("POST /hook/Stop HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1)
            .into_bytes();
        assert_eq!(framed(&raw, raw.len()), Err(400));
    }

    #[test]
    fn parse_rejects_token_event_and_body_errors() {
        let body = br#"{"session_id":"u"}"#;
        let ok = |p: &str, t: Option<&str>, b: &[u8]| {
            let raw = req(p, t, b, "");
            let (h, bb) = framed(&raw, raw.len()).unwrap();
            parse_hook_request(&h, &bb)
        };
        assert_eq!(ok("/hook/Stop", None, body), Err(403)); // 토큰 없음
        assert_eq!(ok("/hook/PreToolUse", Some(TOKEN), body), Err(404)); // 화이트리스트 밖
        assert_eq!(ok("/other", Some(TOKEN), body), Err(404));
        assert_eq!(ok("/hook/Stop", Some(TOKEN), b"not-json"), Err(400));
        assert_eq!(ok("/hook/Stop", Some(TOKEN), br#"{"session_id":""}"#), Err(400));
        // GET — 405
        let raw = b"GET /hook/Stop HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}".to_vec();
        let (h, b) = framed(&raw, raw.len()).unwrap();
        assert_eq!(parse_hook_request(&h, &b), Err(405));
        // 비로컬 Host — 400 (H13, 정확 일치: localhost.evil도 거부)
        for bad in ["Host: evil.test", "Host: localhost.evil", "Host: 127.0.0.1.evil"] {
            let raw = req("/hook/Stop", Some(TOKEN), body, "");
            let s = String::from_utf8(raw).unwrap().replace("Host: 127.0.0.1:9", bad);
            let raw = s.into_bytes();
            let (h, b) = framed(&raw, raw.len()).unwrap();
            assert_eq!(parse_hook_request(&h, &b), Err(400), "{bad}");
        }
    }

    #[test]
    fn safe_uuid_rejects_path_tricks() {
        assert!(is_safe_uuid("73cb4040-741c-4f19-9142-2715b218fb47"));
        assert!(!is_safe_uuid(""));
        assert!(!is_safe_uuid("../../etc/passwd"));
        assert!(!is_safe_uuid("/tmp/x"));
        assert!(!is_safe_uuid("a/b"));
        assert!(!is_safe_uuid(&"a".repeat(65)));
    }

    #[test]
    fn settings_json_has_three_events_and_no_token_in_argv() {
        let s = hook_settings_json();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        for ev in ALLOWED_EVENTS {
            let arr = v["hooks"][ev].as_array().unwrap();
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(&format!("/hook/{ev}")));
            // 토큰 값이 아니라 헤더 파일 참조만 (H1).
            assert!(cmd.contains("-H @\"$WORKBENCH_HOOK_HDR\""));
            assert!(cmd.contains("$WORKBENCH_HOOK_PORT"));
            assert!(!cmd.contains("X-Workbench-Token"));
            assert_eq!(arr[0]["hooks"][0]["type"], "command");
        }
    }
}
