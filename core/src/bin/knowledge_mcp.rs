//! `knowledge-mcp` — 아카이브 지식 조회 MCP 서버 (stdio, 읽기 전용).
//!
//! Claude Code가 `.mcp.json` 항목으로 세션 시작 시 자식 프로세스로 띄운다.
//! 프로토콜·툴 로직은 전부 `core::mcp` (단위 테스트 있음) — 여기는 stdin 한
//! 줄 → 응답 한 줄의 펌프뿐.

use std::io::{BufRead, Write};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut root: Option<String> = None;
    while let Some(a) = args.next() {
        if a == "--knowledge-root" {
            root = args.next();
        }
    }
    let Some(root) = root else {
        eprintln!("usage: knowledge-mcp --knowledge-root <dir>");
        std::process::exit(2);
    };
    let server = core_lib::mcp::McpServer::new(root);

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if let Some(resp) = server.handle_line(&line) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{resp}");
            let _ = out.flush();
        }
    }
}
