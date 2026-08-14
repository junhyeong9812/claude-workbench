//! **The three lines that make R15 real, none of which any other test can see.**
//!
//! `core::remote::Registry` already owns the whole "떼기 takes the terminals
//! with it" contract, and `core`'s own tests prove it: note a terminal, detach
//! the host, both are closed and forgotten. What those tests cannot prove is
//! that the app ever calls any of it. The registry starts with **no closer
//! installed and nothing noted**, and in that state every one of its tests still
//! passes while the running app closes nothing at all — which is exactly what
//! shipped: the host's card vanished and its terminal kept carrying keystrokes
//! to the remote agent.
//!
//! Three calls close that gap, and each one fails silently on its own:
//!
//! | call | where | what its absence looks like |
//! |------|-------|------------------------------|
//! | `install_terminal_closer` | `lib.rs` setup | nothing is ever closed |
//! | `note_terminal` | `remote_attach` | this terminal is invisible to detach |
//! | `forget_terminal` | `emit_terminal_ended` | a later detach closes an id the manager reused (the R1a class: a detach that `SIGKILL`ed an unrelated session) |
//!
//! ## Why the source, again
//!
//! The same reason `state_registration.rs` gives: these commands take a concrete
//! `AppHandle`, so Tauri's mock runtime cannot host them, and `setup` runs only
//! inside a built app. So this reads the source — and, following the lesson that
//! file learned the hard way, it reads **code only** (every one of these names
//! also appears in prose two lines above its call site) and asserts first that it
//! found the functions at all. A scan that matched nothing must fail here rather
//! than pass everywhere.

use std::path::{Path, PathBuf};

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// The code on one line. Every name below is also written in a doc comment
/// beside the call it documents, so a scan that reads prose passes on the
/// documentation alone — which is the fail-open this file must not have.
fn code_only(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

fn code_of(rel: &str) -> String {
    let text = std::fs::read_to_string(src().join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
    text.lines().map(code_only).collect::<Vec<_>>().join("\n")
}

/// The body of one `fn`, from its signature to the line its braces balance on.
///
/// Returns `None` when the function is not there at all — which the callers turn
/// into a failure rather than a skip, because "the function was renamed" and
/// "the call is missing" have to be different outcomes.
fn body_of(code: &str, signature: &str) -> Option<String> {
    let start = code.lines().position(|l| l.contains(signature))?;
    let mut depth = 0usize;
    let mut seen = false;
    let mut out = String::new();
    for line in code.lines().skip(start) {
        out.push_str(line);
        out.push('\n');
        for c in line.chars() {
            match c {
                '{' => {
                    depth += 1;
                    seen = true;
                }
                '}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        if seen && depth == 0 {
            return Some(out);
        }
    }
    Some(out)
}

/// **Without this, nothing closes.** The registry keeps tracking terminals
/// (deliberately — a missing closer degrades to "nobody closed them", never to
/// "nobody knows they exist"), so the symptom is silent: detach reports success,
/// the card disappears, the terminal lives.
#[test]
fn the_app_installs_the_closer_the_registry_cannot_install_itself() {
    let lib = code_of("lib.rs");
    let register = body_of(&lib, "pub fn register(").expect(
        "`register` is gone from lib.rs — this test is reading the wrong thing and would pass \
         no matter what",
    );
    assert!(
        register.contains("install_terminal_closer"),
        "nothing installs `Registry::on_close_terminal`, so \"떼기\" closes no terminal at all: \
         the host card disappears while its terminal keeps carrying keystrokes to the remote \
         agent.\n{register}"
    );

    let remote = code_of("commands/remote.rs");
    let installer = body_of(&remote, "pub fn install_terminal_closer(")
        .expect("`install_terminal_closer` is gone from commands/remote.rs");
    assert!(
        installer.contains("on_close_terminal"),
        "the installer no longer reaches the registry:\n{installer}"
    );
    assert!(
        installer.contains("remove("),
        "the closer must actually end the session — recording a reason alone leaves the terminal \
         typing into the remote agent:\n{installer}"
    );
    // …and the reason has to be written down **first**. Removing the session
    // tears down the SSH channel, and the status relay then offers the vaguer
    // "연결이 끊어졌습니다" — which, since the store keeps whichever arrives
    // first, would become the sentence the user is shown for their own click.
    let (record, remove) = (
        installer.find(".record(").expect("the closer records the reason"),
        installer.find("remove(").expect("the closer removes the session"),
    );
    assert!(
        record < remove,
        "the reason is recorded after the session is torn down, so the vaguer reason wins the \
         race and the screen explains the effect instead of the cause:\n{installer}"
    );
}

/// A terminal nobody filed is a terminal detach cannot find.
#[test]
fn opening_a_remote_terminal_files_it_under_its_host() {
    let remote = code_of("commands/remote.rs");
    let attach = body_of(&remote, "pub fn remote_attach(")
        .expect("`remote_attach` is gone — this test would then check nothing");
    assert!(
        attach.contains("create_ssh"),
        "the scan found something that is not `remote_attach`:\n{attach}"
    );
    assert!(
        attach.contains("note_terminal"),
        "`remote_attach` opens a terminal onto a host without telling the registry, so a later \
         detach cannot close it — the exact state R15 was filed for:\n{attach}"
    );
}

/// …and one that ended on its own must be **unfiled**, or a later detach closes
/// an id that now belongs to somebody else.
#[test]
fn a_terminal_that_ended_is_forgotten_before_its_id_can_be_reused() {
    let remote = code_of("commands/remote.rs");
    let ended = body_of(&remote, "fn record_terminal_ended(")
        .expect("`record_terminal_ended` is gone — the forget has no home and this test no subject");
    assert!(
        ended.contains("forget_terminal"),
        "a terminal that ended on its own stays filed under its host. The session manager hands \
         ids out from a counter, and a detach that closes a stale one kills whatever holds it \
         now — R1a shipped that and it SIGKILLed an unrelated session:\n{ended}"
    );
}

/// The guard on the guard: `code_only` is what keeps every assertion above from
/// being satisfied by the sentence that documents it.
#[test]
fn the_scan_reads_code_and_not_the_prose_that_describes_it() {
    assert_eq!(code_only("    registry.note_terminal(&h, id);").trim(), "registry.note_terminal(&h, id);");
    assert_eq!(code_only("/// and then `note_terminal` files it").trim(), "");
    assert_eq!(code_only("    let x = 1; // note_terminal is called below").trim(), "let x = 1;");
    // A body really is bounded by its own braces, not by the next function's.
    let code = "fn a() {\n  one();\n}\nfn b() {\n  two();\n}\n";
    let a = body_of(code, "fn a(").unwrap();
    assert!(a.contains("one()") && !a.contains("two()"), "{a}");
    assert!(body_of(code, "fn nope(").is_none(), "a missing function must be None, not an empty pass");
}
