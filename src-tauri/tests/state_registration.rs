//! Every `State<T>` a command asks for must be a `T` that was managed.
//!
//! ## Why this is a test and not a compiler's job
//!
//! Tauri resolves managed state by `TypeId` at **invoke** time.
//! `State<'_, Arc<SessionManager>>` against `.manage(SessionManager::new())` is
//! a lookup for a key nobody inserted — and because `State<T>` is generic, the
//! compiler has nothing to object to. Nor does any ordinary Rust test: those
//! call the command as a plain function and never build the state map. So the
//! mismatch is invisible everywhere except the running app, where it makes the
//! command fail on *every* call with `state not managed`.
//!
//! That shipped once, in `remote_attach` (R2b): the remote terminal button could
//! not have worked on any machine, and 447 + 94 green tests said nothing.
//!
//! ## Why the source, rather than the invoke layer
//!
//! Driving the real IPC entry point would be the better check, and Tauri ships a
//! mock runtime for it — but it hosts commands generic over `Runtime`, and these
//! take a concrete `AppHandle` (i.e. `AppHandle<Wry>`). Making ~130 commands
//! generic to test one pairing is a larger change to the app than the bug is.
//! So this reads the two lists that must agree and compares them, which is the
//! whole of what the invoke layer would have discovered here.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Drop path qualifiers so the two lists are written in the same language:
/// `core_lib::SessionManager` and `SessionManager` are one type, while
/// `Arc<core_lib::SessionManager>` stays visibly a different one.
fn normalize(ty: &str) -> String {
    let mut out = String::new();
    let mut segment = String::new();
    for c in ty.chars() {
        if c.is_alphanumeric() || c == '_' {
            segment.push(c);
        } else if c == ':' {
            // `foo::` — the qualifier, not the name.
            segment.clear();
        } else {
            out.push_str(&segment);
            segment.clear();
            if !c.is_whitespace() {
                out.push(c);
            }
        }
    }
    out.push_str(&segment);
    out
}

/// The types `lib.rs` hands to `.manage(...)`, as written there.
fn managed() -> BTreeSet<String> {
    let lib = std::fs::read_to_string(src().join("lib.rs")).expect("read lib.rs");
    let mut out = BTreeSet::new();
    for line in lib.lines() {
        let Some(rest) = line.trim().strip_prefix(".manage(") else {
            continue;
        };
        let Some(inner) = rest.strip_suffix(")") else { continue };
        // `core_lib::SessionManager::new()` / `commands::ssh::SshState::default()`
        // — the constructor call is not part of the type.
        let ty = inner
            .rsplit_once("::")
            .map(|(head, _ctor)| head)
            .unwrap_or(inner);
        out.insert(normalize(ty));
    }
    assert!(
        out.len() >= 6,
        "the `.manage(...)` list was not found in lib.rs — this test is reading the wrong \
         thing and would pass no matter what: {out:?}"
    );
    out
}

fn rust_files(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            rust_files(&path, into);
        } else if path.extension().is_some_and(|e| e == "rs") {
            into.push(path);
        }
    }
}

/// Every `State<'_, T>` written in a command signature, with the file and the
/// line it was written on, so a failure names the place to fix.
fn requested() -> Vec<(String, String)> {
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read");
        for (i, line) in text.lines().enumerate() {
            let mut rest = line;
            while let Some(at) = rest.find("State<'_,") {
                let after = &rest[at + "State<'_,".len()..];
                // Balance the angle brackets: `State<'_, Arc<SessionManager>>`
                // must not be cut at the first `>`.
                let mut depth = 0usize;
                let mut end = after.len();
                for (j, c) in after.char_indices() {
                    match c {
                        '<' => depth += 1,
                        '>' if depth == 0 => {
                            end = j;
                            break;
                        }
                        '>' => depth -= 1,
                        _ => {}
                    }
                }
                out.push((
                    normalize(after[..end].trim()),
                    format!("{}:{}", file.display(), i + 1),
                ));
                rest = &after[end.min(after.len())..];
            }
        }
    }
    out
}

#[test]
fn every_state_a_command_asks_for_is_one_that_was_managed() {
    let managed = managed();
    let requested = requested();
    assert!(
        requested.len() >= 20,
        "no command state was found to check — the scan is broken: {requested:?}"
    );
    let unmanaged: Vec<_> = requested
        .iter()
        .filter(|(ty, _)| !managed.contains(ty))
        .collect();
    assert!(
        unmanaged.is_empty(),
        "these commands ask Tauri for state that `lib.rs` never managed. Tauri keys its state \
         map by TypeId, so each of these fails at runtime with \"state not managed\" on every \
         call — while compiling cleanly.\n  managed: {managed:?}\n  unmanaged: {unmanaged:#?}"
    );
}

/// The reverse direction is a weaker signal (state may legitimately be managed
/// for a run-loop `state::<T>()` rather than for a command), so it is reported
/// as a fact this test knows rather than asserted as a rule — except that the
/// set must not be empty, which would mean the scan matched nothing.
#[test]
fn the_managed_list_is_the_one_lib_rs_actually_installs() {
    let managed = managed();
    for expected in [
        "SessionManager",
        "ClaudeState",
        "SshState",
        "ScrollbackState",
        "CodexState",
        "RemoteState",
    ] {
        assert!(
            managed.contains(expected),
            "{expected} is no longer managed in lib.rs — if that is deliberate, the commands \
             asking for it must go too. managed: {managed:?}"
        );
    }
}
