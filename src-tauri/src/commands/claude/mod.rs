// ---- Claude (architecture A: real terminal + session-JSONL tail) ----
//
// Instead of the ACP adapter, we spawn the **real** `claude` CLI in a PTY (so
// xterm renders its full TUI — perfect terminal parity) and tail the session
// JSONL transcript the CLI writes (`~/.claude/projects/<slug>/<uuid>.jsonl`) to
// build the change timeline. `claude_start` does both: it reuses the PTY relay
// (the `terminal-output` event, exactly like `terminal_create`) and spawns a
// polling thread that drives a `SessionTail` and emits `claude-timeline` events.
//
// P5 B-c: 1586줄 단일 파일을 관심사 4구획으로 순수 분할 —
// runtime(세션 수명·전이) / spawn(PTY 기동) / timeline(tail·폴링) /
// store(스냅샷·detail·CRUD). 소비자(lib.rs generate_handler·manage)는 U3
// 관용대로 서브모듈 경로를 직참조한다(재수출 표면 없음).

pub mod runtime;
mod spawn;
pub mod store;
mod timeline;

