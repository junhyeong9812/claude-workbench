//! **The remote bridge invents no frontend event kind.**
//!
//! R2a's fourth requirement was that a remote host reaches the screen through
//! the events a local session has always produced — `claude-timeline`,
//! `claude-session-closed`, `claude-hook-status` — and that state with no
//! existing event becomes a *snapshot command* instead (`remote_hosts`), because
//! an event is a contract two layers have to keep in sync forever while a
//! command is answered on demand and forgotten.
//!
//! R2b broke it quietly: `remote-terminal-ended` was added, with a doc comment
//! arguing why, and no spec sentence lifting the ban. Nothing failed, which is
//! the whole problem — an architectural rule that no test can state is a rule
//! that lasts exactly as long as the person who remembers it.
//!
//! So this states it. A new event kind from the bridge is now a red test, and
//! the way to add one is to change this list on purpose.

use std::path::{Path, PathBuf};

fn remote_rs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/remote.rs")
}

/// Every string literal handed to `.emit(`.
///
/// Whole-text, not line-by-line: `rustfmt` puts the name on the **next** line
/// whenever the payload does not fit, which is how both of the calls this test
/// was written for are formatted. A per-line scan finds neither of them and
/// reports a clean bill — the first version of this file did exactly that.
///
/// Comments are excluded: this file's own prose names the events, and so does
/// the bridge's (`/// → claude-session-closed`), and a scan that read those
/// would be measuring the documentation.
fn emitted_names(text: &str) -> Vec<String> {
    let code: String = text
        .lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = code[from..].find(".emit(") {
        let at = from + rel + ".emit(".len();
        from = at;
        let rest = code[at..].trim_start();
        // `.emit(&format!(…))` — a computed name; nothing to read as a literal.
        let Some(rest) = rest.strip_prefix('"') else { continue };
        let Some(end) = rest.find('"') else { continue };
        out.push(rest[..end].to_string());
    }
    out
}

/// The events a remote host is allowed to reach the frontend on: the ones a
/// **local** session already produced before any of this existed.
const EXISTING: [&str; 3] = ["claude-timeline", "claude-session-closed", "claude-hook-status"];

#[test]
fn the_remote_bridge_emits_only_events_that_already_existed() {
    let text = std::fs::read_to_string(remote_rs()).expect("read commands/remote.rs");
    let emitted = emitted_names(&text);
    assert!(
        !emitted.is_empty(),
        "no `.emit(\"…\")` was found in commands/remote.rs — the scan is reading the wrong thing \
         and would pass no matter which event kinds the bridge invented"
    );
    let invented: Vec<&String> = emitted
        .iter()
        .filter(|name| !EXISTING.contains(&name.as_str()))
        .collect();
    assert!(
        invented.is_empty(),
        "the remote bridge emits event kinds that no local session produces: {invented:?}.\n\
         R2a ④ requires a remote host to arrive on the existing events, and state that has no \
         event to arrive on to be a **snapshot command** instead (that is what `remote_hosts` \
         is). Adding one here is a frontend contract two layers must keep in sync forever — if \
         it is really wanted, it is a spec change, not a line of code."
    );
}

/// The scan must actually be able to see a violation — a guard whose detector is
/// broken passes exactly like a guard that holds.
#[test]
fn the_scan_sees_an_invented_event_and_ignores_prose_about_one() {
    assert_eq!(
        emitted_names(r#"let _ = app.emit("remote-terminal-ended", payload);"#),
        ["remote-terminal-ended"]
    );
    assert_eq!(
        emitted_names(r#"    self.app.emit("claude-timeline", payload);"#),
        ["claude-timeline"]
    );
    // The formatting both real call sites are in: the name is on the next line.
    assert_eq!(
        emitted_names("let _ = handle.emit(\n    \"remote-terminal-ended\",\n    payload,\n);"),
        ["remote-terminal-ended"],
        "a name wrapped onto the next line is the same name"
    );
    assert!(
        emitted_names(r#"    /// → app.emit("remote-terminal-ended") 는 하지 않는다"#).is_empty(),
        "prose about an event is not an event"
    );
}
