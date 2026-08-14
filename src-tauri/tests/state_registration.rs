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

/// The code on one line — a `State<…>` written inside a comment is prose, not a
/// signature, and reading it as one would make this test fail on its own docs.
fn code_only(line: &str) -> &str {
    match line.find("//") {
        Some(i) => &line[..i],
        None => line,
    }
}

/// Every state type named on one line of code, whichever way it is written.
///
/// `State<T>` is one type spelled several ways: the lifetime may be elided
/// (`State<RemoteState>`), anonymous (`State<'_, T>`) or named (`State<'a, T>`),
/// and the path may be qualified (`tauri::State<…>`). Tauri looks all of them up
/// by the same `TypeId`, so a scan that reads only one of them is a scan that
/// passes while the mismatch it exists to catch sits in the next line down.
fn state_types_in(line: &str) -> Vec<String> {
    const NEEDLE: &str = "State<";
    let line = code_only(line);
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = line[from..].find(NEEDLE) {
        let at = from + rel;
        from = at + NEEDLE.len();
        // A whole word: `RemoteState<…>` and `SshState<…>` are other types, and
        // `tauri::State<…>` is this one.
        if line[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let after = &line[from..];
        // An optional lifetime, then the type. `State<'a, T>` and `State<T>`
        // name the same thing to Tauri.
        let ty = after.trim_start();
        let ty = match ty.strip_prefix('\'') {
            Some(rest) => match rest.split_once(',') {
                Some((_lifetime, tail)) => tail,
                // `State<'a>` is not a type this app writes; nothing to read.
                None => continue,
            },
            None => ty,
        };
        // Balance the angle brackets: `State<'_, Arc<SessionManager>>` must not
        // be cut at the first `>`.
        let mut depth = 0usize;
        let mut end = ty.len();
        for (j, c) in ty.char_indices() {
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
        let ty = ty[..end].trim();
        if !ty.is_empty() {
            out.push(normalize(ty));
        }
        from = at + NEEDLE.len() + (ty.len().min(after.len()));
    }
    out
}

/// Every `#[tauri::command]` signature in the tree, as `(file, line number, the
/// code on that line)` — from the `fn` to the line where its parameter list
/// closes again.
///
/// **Both scans below read exactly these lines**, and that is the point. While
/// the type scan read the whole tree and the word count read only command
/// signatures, the first was a *superset* of the second: two helper functions
/// take a `State` too, so the type scan could miss up to two command parameters
/// and still clear a `>=` floor. A floor a mistake can sink into is not a floor.
/// Over one and the same region the two counts must come out **equal**, and any
/// notation the type scan cannot read makes them differ.
fn command_signatures() -> (usize, Vec<(PathBuf, usize, String)>) {
    let mut files = Vec::new();
    rust_files(&src(), &mut files);
    files.sort();
    let (mut commands, mut out) = (0usize, Vec::new());
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read");
        let lines: Vec<&str> = text.lines().map(code_only).collect();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            commands += 1;
            // The signature: from `fn …(` until the parens balance again.
            let Some(start) = lines[i..].iter().position(|l| l.contains("fn ")) else {
                continue;
            };
            let mut depth = 0usize;
            let mut seen_paren = false;
            for (j, line) in lines[i + start..].iter().enumerate() {
                for c in line.chars() {
                    match c {
                        '(' => {
                            depth += 1;
                            seen_paren = true;
                        }
                        ')' => depth = depth.saturating_sub(1),
                        _ => {}
                    }
                }
                out.push((file.clone(), i + start + j + 1, (*line).to_string()));
                if seen_paren && depth == 0 {
                    break;
                }
            }
        }
    }
    (commands, out)
}

/// Every `State<…>` a **command** asks for, with the file and the line it was
/// written on, so a failure names the place to fix.
///
/// Commands and nothing else: Tauri resolves `State<T>` by `TypeId` when it
/// dispatches an invoke, so a plain helper that takes a `State` was handed one
/// by the command that called it and has no lookup of its own to get wrong.
/// Reading those too made this list a superset of the count that holds it up —
/// see [`command_signatures`].
fn requested(signatures: &[(PathBuf, usize, String)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (file, line_no, line) in signatures {
        for ty in state_types_in(line) {
            out.push((ty, format!("{}:{}", file.display(), line_no)));
        }
    }
    out
}

/// How many command signatures name `State`, counted by a **different rule**:
/// the bare word inside a `#[tauri::command]` function's parameter list, with no
/// angle brackets involved at all.
///
/// This is what the parse above is held to. `requested.len() >= 20` only ever
/// proved the scan had found *something*: a notation it could not read dropped
/// silently out of both the list and the check, which is precisely the fail-open
/// this file exists to prevent — in the file that exists to prevent it. Two
/// counts derived from unrelated rules over the same lines cannot fail that way
/// together.
fn state_words_in(signatures: &[(PathBuf, usize, String)]) -> usize {
    signatures
        .iter()
        .map(|(_, _, line)| {
            line.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .filter(|w| *w == "State")
                .count()
        })
        .sum()
}

/// **The scan must read every way a state parameter is written.**
///
/// It read `State<'_,` and nothing else, so `State<RemoteState>` — the elided
/// form, which is ordinary Rust — and `State<'a, T>` were invisible: a command
/// asking for state nobody managed would sail through the check written to stop
/// exactly that, and the failure would be discovered where it was discovered
/// last time, in the running app.
#[test]
fn the_scan_reads_every_way_a_state_parameter_is_written() {
    let one = |line: &str| state_types_in(line);
    assert_eq!(one("    mgr: State<'_, core_lib::SessionManager>,"), ["SessionManager"]);
    assert_eq!(one("    remote: State<RemoteState>,"), ["RemoteState"], "an elided lifetime");
    assert_eq!(one("fn f<'a>(s: State<'a, Arc<SessionManager>>) {"), ["Arc<SessionManager>"]);
    assert_eq!(
        one("s: tauri::State<'_, ScrollbackState>, t: State<CodexState>"),
        ["ScrollbackState", "CodexState"],
        "two on one line, one of them path-qualified"
    );
    // A type that merely *ends* in `State` is a different type.
    assert!(one("x: RemoteState<T>,").is_empty());
    // …and prose about `State<'_, Arc<SessionManager>>` is not a signature: this
    // very file, and the comments in `commands/remote.rs`, are full of it.
    assert!(one("// State<'_, Arc<SessionManager>> is a different key").is_empty());
    assert!(one("/// `State<Arc<SessionManager>>` against a bare one").is_empty());
}

#[test]
fn every_state_a_command_asks_for_is_one_that_was_managed() {
    let managed = managed();
    let (commands, signatures) = command_signatures();
    let requested = requested(&signatures);
    let state_params = state_words_in(&signatures);
    assert!(
        commands >= 50,
        "only {commands} `#[tauri::command]` were found — the scan is reading the wrong thing"
    );
    assert!(
        state_params >= 20,
        "only {state_params} command parameters name `State` — the scan is reading the wrong thing"
    );
    // The check that has teeth: every `State` a command declares must have been
    // *read* by the parse above — no more and no fewer. A notation the parse
    // cannot handle drops out of `requested` while this count, made by an
    // unrelated rule over the same lines, does not move. `>=` left slack for
    // exactly that mistake, because the parse used to read the whole tree
    // (helpers included) and so ran ahead of the count it was measured against.
    assert_eq!(
        requested.len(),
        state_params,
        "the scan read {} state parameters but command signatures declare {state_params} — one \
         of the two rules is skipping something, so this test would pass over exactly the \
         mismatch it exists to catch:\n  read: {requested:#?}",
        requested.len()
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
