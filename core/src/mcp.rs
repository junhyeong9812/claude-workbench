//! Knowledge-base **MCP server** core: a hand-rolled, dependency-free
//! implementation of the Model Context Protocol's stdio transport (JSON-RPC
//! 2.0, one JSON object per line) exposing read-only lookup over a project's
//! archived knowledge (`issues/` · `methods/` · `domain/` · `INDEX.md`).
//!
//! Why hand-rolled: the server needs exactly three read-only tools over local
//! markdown files — an SDK dependency would dwarf the problem. The protocol
//! subset implemented (initialize / notifications / ping / tools/list /
//! tools/call) is what Claude Code drives; unknown methods get a proper
//! JSON-RPC error so future client calls degrade loudly, not silently.
//!
//! Invariants:
//! - **Read-only**: no tool writes anything, anywhere.
//! - **Containment**: `read_knowledge` resolves paths and refuses anything
//!   outside the knowledge root (path traversal via relative segments or
//!   symlinks cannot escape).
//! - Registration (`register_in_mcp_json`) **merges** into the project's
//!   `.mcp.json`: other servers are never touched; a corrupt file is left
//!   unmodified and reported (never clobbered).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Server name — the `.mcp.json` key and MCP serverInfo name.
pub const SERVER_NAME: &str = "workbench-knowledge";

/// One project's knowledge lookup server.
pub struct McpServer {
    knowledge_root: PathBuf,
}

const KIND_DIRS: [&str; 3] = ["issues", "methods", "domain"];

impl McpServer {
    pub fn new(knowledge_root: impl Into<PathBuf>) -> Self {
        Self {
            knowledge_root: knowledge_root.into(),
        }
    }

    /// Handle one incoming line. Returns the response line to write, or `None`
    /// for notifications (which get no response by JSON-RPC rules).
    pub fn handle_line(&self, line: &str) -> Option<String> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return Some(error_response(Value::Null, -32700, "Parse error"));
        };
        // JSON-RPC 2.0: a request is an object with "jsonrpc":"2.0" (arrays /
        // scalars / wrong version are invalid requests, not silence — 리뷰 G8).
        if !msg.is_object() {
            return Some(error_response(Value::Null, -32600, "Invalid request"));
        }
        if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return match msg.get("id").cloned() {
                Some(id) => Some(error_response(id, -32600, "Invalid request (jsonrpc must be \"2.0\")")),
                None => None,
            };
        }
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        // A message without a method: either a (client-side) response — ignore —
        // or an invalid request.
        if method.is_empty() {
            return match id {
                Some(id) if msg.get("result").is_none() && msg.get("error").is_none() => {
                    Some(error_response(id, -32600, "Invalid request"))
                }
                _ => None,
            };
        }
        // Notifications (no id) never get a response.
        let Some(id) = id else {
            return None;
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let out = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(tools_list()),
            "tools/call" => Ok(self.tools_call(&params)),
            _ => Err((-32601, format!("Method not found: {method}"))),
        };
        Some(match out {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
            Err((code, message)) => error_response(id, code, &message),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        // Agree to the client's protocol version only when it's one we know the
        // tools subset is identical in; anything unknown gets our baseline so a
        // future client never mistakes us for supporting a newer contract
        // (리뷰 G7 — 무조건 에코 금지).
        // 2025-03-26은 JSON-RPC batch 수신을 요구하는데 이 서버는 batch를
        // 구현하지 않는다 — 지원 선언에서 제외 (2024-11-05는 batch 이전,
        // 2025-06-18은 batch 제거 후라 봉투 검증과 정합).
        const SUPPORTED: [&str; 2] = ["2024-11-05", "2025-06-18"];
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("2024-11-05");
        let version = if SUPPORTED.contains(&requested) {
            requested
        } else {
            "2024-11-05"
        };
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": env!("CARGO_PKG_VERSION"),
            },
        })
    }

    fn tools_call(&self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        let outcome = match name {
            "search_knowledge" => self.search(&args),
            "read_knowledge" => self.read_entry(&args),
            "list_knowledge" => self.list_index(),
            _ => Err(format!("Unknown tool: {name}")),
        };
        match outcome {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(msg) => json!({
                "content": [{ "type": "text", "text": msg }],
                "isError": true,
            }),
        }
    }

    /// Case-insensitive substring search over every knowledge file's title,
    /// frontmatter, and body. Error strings archived verbatim in issue bodies
    /// are exactly what this is for.
    fn search(&self, args: &Value) -> Result<String, String> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or("query가 필요합니다")?;
        let kind_filter = args.get("kind").and_then(Value::as_str);
        let needle = query.to_lowercase();

        const MAX_FILES: usize = 20;
        const MAX_LINES_PER_FILE: usize = 6;
        let mut out = String::new();
        let mut hits = 0usize;
        for dir_name in KIND_DIRS {
            if let Some(k) = kind_filter {
                // "issue" ↔ "issues" 류 단복수 관용 — 접두 일치로 흡수.
                if !dir_name.starts_with(k.trim_end_matches('s')) {
                    continue;
                }
            }
            let dir = self.knowledge_root.join(dir_name);
            // 카테고리 디렉터리 자체가 루트 밖을 가리키는 심볼릭 링크일 수 있다
            // — canonicalize 후 containment 확인 (post-fix P1).
            let (Ok(root_c), Ok(dir_c)) = (fs::canonicalize(&self.knowledge_root), fs::canonicalize(&dir))
            else {
                continue;
            };
            if !dir_c.starts_with(&root_c) {
                continue;
            }
            let Ok(entries) = fs::read_dir(&dir_c) else { continue };
            let mut names: Vec<PathBuf> = entries
                .flatten()
                // 심볼릭 링크는 루트 밖을 가리킬 수 있다 — read_entry의 containment와
                // 대칭으로, 검색도 실파일만 읽는다 (리뷰 G4).
                .filter(|e| e.file_type().map(|t| !t.is_symlink()).unwrap_or(false))
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
                .collect();
            names.sort();
            for path in names {
                if hits >= MAX_FILES {
                    out.push_str("\n(더 많은 결과 생략 — query를 좁히세요)\n");
                    return Ok(out);
                }
                let Ok(text) = fs::read_to_string(&path) else { continue };
                let matched: Vec<(usize, &str)> = text
                    .lines()
                    .enumerate()
                    .filter(|(_, l)| l.to_lowercase().contains(&needle))
                    .take(MAX_LINES_PER_FILE)
                    .collect();
                if matched.is_empty() {
                    continue;
                }
                hits += 1;
                let rel = format!("{dir_name}/{}", path.file_name().unwrap_or_default().to_string_lossy());
                let title = text
                    .lines()
                    .find(|l| l.starts_with("title:"))
                    .map(|l| l.trim_start_matches("title:").trim().trim_matches('"'))
                    .unwrap_or("(제목 없음)");
                out.push_str(&format!("## {rel} — {title}\n"));
                for (n, l) in matched {
                    out.push_str(&format!("  L{}: {}\n", n + 1, l.trim()));
                }
            }
        }
        if hits == 0 {
            Ok(format!("\"{query}\"에 대한 지식 항목 없음"))
        } else {
            Ok(out)
        }
    }

    /// Read one knowledge file by its root-relative path (e.g.
    /// `issues/2026-07-19-slug.md` or `INDEX.md`), refusing escapes.
    fn read_entry(&self, args: &Value) -> Result<String, String> {
        let rel = args
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or("path가 필요합니다")?;
        let root = fs::canonicalize(&self.knowledge_root)
            .map_err(|_| "지식 폴더가 없습니다".to_string())?;
        let target = fs::canonicalize(root.join(rel))
            .map_err(|_| format!("파일 없음: {rel}"))?;
        if !target.starts_with(&root) {
            return Err("지식 폴더 밖 경로는 읽을 수 없습니다".to_string());
        }
        fs::read_to_string(&target).map_err(|_| format!("읽기 실패: {rel}"))
    }

    fn list_index(&self) -> Result<String, String> {
        // read_entry와 같은 containment 경로를 태워 INDEX.md 심볼릭 링크로도
        // 루트 밖이 노출되지 않게 한다 (리뷰 G4).
        match self.read_entry(&json!({ "path": "INDEX.md" })) {
            Ok(text) => Ok(text),
            Err(_) => Ok("지식 인덱스가 아직 없습니다 (아카이브된 지식 0건).".to_string()),
        }
    }
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
    .to_string()
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "search_knowledge",
                "description": "아카이브된 세션 지식(이슈/방법론/도메인)에서 검색한다. 에러 메시지·원인·해결책이 원문으로 저장돼 있으므로, 에러 코드나 증상 문자열을 그대로 검색하면 과거에 같은 문제를 어떻게 풀었는지 나온다.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "검색어 (에러 코드·증상·키워드, 대소문자 무시)" },
                        "kind": { "type": "string", "enum": ["issue", "method", "domain"], "description": "선택 — 특정 종류만" }
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "read_knowledge",
                "description": "지식 파일 하나의 전체 내용을 읽는다 (search_knowledge 결과의 경로를 넣는다).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "지식 루트 기준 상대 경로 (예: issues/2026-07-19-xxx.md, INDEX.md)" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "list_knowledge",
                "description": "지식 인덱스(INDEX.md — 전체 항목의 한 줄 목록)를 반환한다.",
                "inputSchema": { "type": "object", "properties": {} }
            }
        ]
    })
}

/// Merge this project's knowledge server into `<project>/.mcp.json` (the file
/// Claude Code reads for project-scoped MCP servers).
///
/// - Absent file → created with just our entry.
/// - Existing file → only `mcpServers.workbench-knowledge` is set; every other
///   key/server is preserved byte-for-byte in value terms.
/// - Corrupt JSON → `InvalidData` error, file untouched (불변식: 병합만).
///
/// Returns whether the file changed (already-registered = `false`, idempotent).
pub fn register_in_mcp_json(
    project_dir: &Path,
    server_command: &Path,
    knowledge_dir: &Path,
) -> io::Result<bool> {
    let path = project_dir.join(".mcp.json");
    let mut root: Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                ".mcp.json이 손상돼 있어 병합하지 않았습니다",
            )
        })?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e),
    };
    if !root.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ".mcp.json 최상위가 객체가 아니라 병합하지 않았습니다",
        ));
    }
    let entry = json!({
        "command": server_command.to_string_lossy(),
        "args": ["--knowledge-root", knowledge_dir.to_string_lossy()],
    });
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            ".mcp.json의 mcpServers가 객체가 아니라 병합하지 않았습니다",
        ));
    }
    let servers = servers.as_object_mut().unwrap();
    match servers.get(SERVER_NAME) {
        Some(existing) if existing == &entry => return Ok(false),
        Some(existing) => {
            // 같은 키가 이미 있는데 우리 서버(knowledge-mcp 바이너리)가 아니면
            // 사용자의 다른 등록을 덮어쓰는 것 — 병합 불변식 위반이므로 거부
            // (리뷰 G3). 우리 항목이면 경로/인자 갱신만 허용.
            // 정확한 basename 일치만 우리 것으로 인정 — `contains`는
            // "not-knowledge-mcp-wrapper" 류를 오인한다 (post-fix P1).
            let is_ours = existing
                .get("command")
                .and_then(Value::as_str)
                .and_then(|c| Path::new(c).file_name())
                .map(|f| f == "knowledge-mcp")
                .unwrap_or(false);
            if !is_ours {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "같은 이름의 다른 MCP 서버가 등록돼 있어 덮어쓰지 않았습니다",
                ));
            }
        }
        None => {}
    }
    servers.insert(SERVER_NAME.to_string(), entry);
    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    // Atomic write (tmp + rename) — a crash never leaves a half-written file,
    // and a failed rename never leaves the tmp behind (리뷰 G11).
    let tmp = project_dir.join(format!(".mcp.json.{}.tmp", std::process::id()));
    fs::write(&tmp, text)?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-mcp-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn knowledge_fixture(tag: &str) -> PathBuf {
        let root = temp_dir(tag);
        let issues = root.join("issues");
        fs::create_dir_all(&issues).unwrap();
        fs::write(
            issues.join("2026-07-19-econnrefused.md"),
            "---\ntype: issue\ntitle: \"ECONNREFUSED — ipc 초기화 전 invoke\"\nsession: u1\n---\n\n## 증상\nError: ECONNREFUSED at invoke()\n## 해결\n초기화 후 호출\n",
        )
        .unwrap();
        fs::write(root.join("INDEX.md"), "# Knowledge Index\n\n## issues\n- [ECONNREFUSED](issues/2026-07-19-econnrefused.md)\n").unwrap();
        root
    }

    fn call(server: &McpServer, line: &str) -> Value {
        serde_json::from_str(&server.handle_line(line).expect("response")).unwrap()
    }

    #[test]
    fn initialize_and_tools_list_round_trip() {
        let s = McpServer::new(knowledge_fixture("init"));
        let init = call(
            &s,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        );
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18", "클라이언트 버전 에코");
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        // initialized notification → 응답 없음.
        assert!(s
            .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .is_none());
        let tools = call(&s, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["search_knowledge", "read_knowledge", "list_knowledge"]);
    }

    #[test]
    fn search_finds_verbatim_error_strings() {
        let s = McpServer::new(knowledge_fixture("search"));
        let res = call(
            &s,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"econnrefused at invoke"}}}"#,
        );
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("issues/2026-07-19-econnrefused.md"));
        assert!(text.contains("ECONNREFUSED at invoke()"), "에러 원문 라인이 결과에");
        // 미검색어는 빈 결과 문구.
        let none = call(
            &s,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"zzz-none"}}}"#,
        );
        assert!(none["result"]["content"][0]["text"].as_str().unwrap().contains("없음"));
    }

    #[test]
    fn read_entry_is_contained_to_root() {
        let s = McpServer::new(knowledge_fixture("contain"));
        let ok = call(
            &s,
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_knowledge","arguments":{"path":"INDEX.md"}}}"#,
        );
        assert!(ok["result"]["content"][0]["text"].as_str().unwrap().contains("Knowledge Index"));
        let esc = call(
            &s,
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_knowledge","arguments":{"path":"../../etc/passwd"}}}"#,
        );
        assert_eq!(esc["result"]["isError"], true, "루트 탈출 거부");
    }

    #[test]
    fn protocol_errors_are_proper_jsonrpc() {
        let s = McpServer::new(knowledge_fixture("err"));
        let parse = call(&s, "{not json");
        assert_eq!(parse["error"]["code"], -32700);
        let unknown = call(&s, r#"{"jsonrpc":"2.0","id":9,"method":"resources/list"}"#);
        assert_eq!(unknown["error"]["code"], -32601);
        // id 없는 알 수 없는 메서드(notification) → 무응답.
        assert!(s.handle_line(r#"{"jsonrpc":"2.0","method":"weird/notify"}"#).is_none());
    }

    #[test]
    fn register_merges_preserves_and_is_idempotent() {
        let proj = temp_dir("reg");
        fs::write(
            proj.join(".mcp.json"),
            r#"{ "mcpServers": { "other": { "command": "keepme" } }, "custom": 1 }"#,
        )
        .unwrap();
        let changed =
            register_in_mcp_json(&proj, Path::new("/bin/knowledge-mcp"), Path::new("/kn")).unwrap();
        assert!(changed);
        let v: Value =
            serde_json::from_str(&fs::read_to_string(proj.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "keepme", "기존 서버 보존");
        assert_eq!(v["custom"], 1, "기타 키 보존");
        assert_eq!(v["mcpServers"][SERVER_NAME]["args"][1], "/kn");
        // 재실행 = 무변경.
        let again =
            register_in_mcp_json(&proj, Path::new("/bin/knowledge-mcp"), Path::new("/kn")).unwrap();
        assert!(!again);
    }

    #[test]
    fn register_refuses_foreign_server_with_same_name() {
        let proj = temp_dir("foreign");
        fs::write(
            proj.join(".mcp.json"),
            r#"{ "mcpServers": { "workbench-knowledge": { "command": "/usr/bin/other-tool" } } }"#,
        )
        .unwrap();
        let err = register_in_mcp_json(&proj, Path::new("/b/knowledge-mcp"), Path::new("/k"))
            .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        let v: Value =
            serde_json::from_str(&fs::read_to_string(proj.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(v["mcpServers"][SERVER_NAME]["command"], "/usr/bin/other-tool", "미변경");
        // 우리 바이너리를 가리키는 기존 항목은 경로 갱신 허용.
        fs::write(
            proj.join(".mcp.json"),
            r#"{ "mcpServers": { "workbench-knowledge": { "command": "/old/knowledge-mcp", "args": [] } } }"#,
        )
        .unwrap();
        assert!(register_in_mcp_json(&proj, Path::new("/new/knowledge-mcp"), Path::new("/k")).unwrap());
    }

    #[test]
    fn jsonrpc_envelope_is_validated() {
        let s = McpServer::new(knowledge_fixture("envelope"));
        // 배열/스칼라 → -32600.
        let arr = call(&s, r#"[1,2]"#);
        assert_eq!(arr["error"]["code"], -32600);
        // jsonrpc 필드 누락 + id 있음 → -32600.
        let nover = call(&s, r#"{"id":1,"method":"ping"}"#);
        assert_eq!(nover["error"]["code"], -32600);
        // 미지의 protocolVersion은 에코하지 않고 기준 버전으로 응답.
        let init = call(
            &s,
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#,
        );
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    }

    #[cfg(unix)]
    #[test]
    fn search_skips_symlinks_outside_root() {
        let root = knowledge_fixture("symlink");
        let outside = temp_dir("symlink-outside").join("secret.md");
        fs::write(&outside, "---\ntitle: \"secret\"\n---\nSECRET-NEEDLE").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("issues").join("link.md")).unwrap();
        let s = McpServer::new(&root);
        let res = call(
            &s,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"SECRET-NEEDLE"}}}"#,
        );
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        // 유일한 매칭 파일이 심볼릭 링크 → 히트 0 ("없음" 메시지는 검색어를
        // 인용하므로 needle 포함 검사 대신 히트/경로 부재로 판정한다).
        assert!(text.contains("없음"), "히트 0이어야 함: {text}");
        assert!(!text.contains("link.md"), "심볼릭 링크 파일 미노출");
    }

    // post-fix P1: 카테고리 *디렉터리* 자체가 루트 밖 심볼릭 링크인 경우도 차단.
    #[cfg(unix)]
    #[test]
    fn search_skips_symlinked_category_dir() {
        let root = temp_dir("dirlink-root");
        let outside = temp_dir("dirlink-outside");
        fs::write(outside.join("leak.md"), "---\ntitle: \"leak\"\n---\nDIR-NEEDLE").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("issues")).unwrap();
        let s = McpServer::new(&root);
        let res = call(
            &s,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"DIR-NEEDLE"}}}"#,
        );
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("없음") && !text.contains("leak.md"), "디렉터리 링크 미추적: {text}");
    }

    #[test]
    fn register_ownership_is_exact_basename() {
        let proj = temp_dir("owner-exact");
        fs::write(
            proj.join(".mcp.json"),
            r#"{ "mcpServers": { "workbench-knowledge": { "command": "/usr/bin/not-knowledge-mcp-wrapper" } } }"#,
        )
        .unwrap();
        // basename이 정확히 "knowledge-mcp"가 아니면 타 서버로 간주해 거부.
        assert!(register_in_mcp_json(&proj, Path::new("/b/knowledge-mcp"), Path::new("/k")).is_err());
    }

    #[test]
    fn register_refuses_corrupt_file_untouched() {
        let proj = temp_dir("corrupt");
        fs::write(proj.join(".mcp.json"), "{ broken").unwrap();
        let err = register_in_mcp_json(&proj, Path::new("/b"), Path::new("/k")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_to_string(proj.join(".mcp.json")).unwrap(), "{ broken", "미변경");
    }

    #[test]
    fn register_creates_fresh_file() {
        let proj = temp_dir("fresh");
        let changed =
            register_in_mcp_json(&proj, Path::new("/bin/knowledge-mcp"), Path::new("/kn")).unwrap();
        assert!(changed);
        let v: Value =
            serde_json::from_str(&fs::read_to_string(proj.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(v["mcpServers"][SERVER_NAME]["command"], "/bin/knowledge-mcp");
    }
}
