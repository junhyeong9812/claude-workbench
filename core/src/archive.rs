//! Session **archive** pipeline: normalize a finished session's JSONL into a
//! stable JSON document and render a self-contained `book.html` for later
//! reading — the "record & review" model that replaces live-observation task
//! chains.
//!
//! Layout (one folder per archived session, keyed by project + session uuid):
//! ```text
//! <archive_root>/<project_key>/sessions/<date>-<slug>-<uuid8>/
//!   session.jsonl     # verbatim copy of the CLI transcript (source untouched)
//!   normalized.json   # versioned, parsed form (schema_version field)
//!   book.html         # self-contained reader (no external requests)
//! ```
//!
//! Invariants:
//! - The **source** transcript is never touched here — callers pass its bytes;
//!   this module only ever writes under `archive_root`.
//! - Re-archiving the same session is **idempotent**: the previous folder for
//!   that uuid is replaced (found by its `-<uuid8>` suffix, so a changed title
//!   or date can't leave duplicates).
//! - Conversation text reaches `book.html` **only** inside a JSON payload with
//!   every `<` escaped to the JSON escape `\\u003c`, and the embedded renderer builds DOM via
//!   `textContent` only — transcript content can never execute in the viewer.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::history::project_key;
use crate::jsonl::JsonlMapper;
use crate::timeline::{TimelineItem, TokenUsage};

/// Bump when the shape of [`NormalizedSession`] changes, so future readers
/// (viewer, MCP indexer) can branch on it instead of guessing.
pub const SCHEMA_VERSION: u32 = 1;

/// Process-unique suffix counter for temp dirs (same rationale as snapshot.rs:
/// concurrent writers must never race on a shared temp path).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// One conversation turn of the normalized session: the user's prompt, the
/// assistant's answer, and the tool items that ran in between (seq order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedTurn {
    pub turn: u64,
    /// The turn's UTC day (YYYY-MM-DD), if the transcript carried timestamps.
    pub date: Option<String>,
    pub prompt: Option<String>,
    pub answer: Option<String>,
    pub tokens: Option<TokenUsage>,
    pub items: Vec<TimelineItem>,
}

/// The whole archived session in one versioned document — the single input for
/// both `book.html` and any later consumer (viewer pane, MCP index).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedSession {
    pub schema_version: u32,
    pub uuid: String,
    /// The project root (cwd) the session ran in.
    pub project: String,
    /// One-line session title (AI-generated or the display name fallback).
    pub title: String,
    /// Archive date (YYYY-MM-DD).
    pub date: String,
    pub model: Option<String>,
    /// Sum of all turns' token usage.
    pub total_tokens: TokenUsage,
    pub turns: Vec<NormalizedTurn>,
}

/// Where an archive write landed.
#[derive(Debug, Clone)]
pub struct ArchiveOutcome {
    pub dir: PathBuf,
    pub book_path: PathBuf,
    /// Whether a previous archive of the same session was replaced.
    pub replaced: bool,
}

/// Same character policy as the snapshot sidecars, plus a minimum length so the
/// `uuid8` folder suffix is meaningful.
fn is_safe_uuid(uuid: &str) -> bool {
    uuid.len() >= 8
        && uuid.len() <= 128
        && uuid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn uuid8(uuid: &str) -> String {
    uuid.chars().take(8).collect()
}

/// A filesystem-safe folder slug from a session title. Keeps letters/digits in
/// any script (한글 folder names are fine), turns everything else into `-`,
/// collapses runs, and caps the length. Empty input falls back to `"session"`.
pub fn slugify(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut last_dash = true; // suppress a leading dash
    for c in s.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= max_chars {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

/// Parse a whole transcript into a [`NormalizedSession`] by replaying it
/// through the shared [`JsonlMapper`] (read-only over the text — the caller
/// owns the file). Items are grouped under the turn they ran in; turn `0`
/// (pre-prompt items) appears only when it has items.
pub fn normalize(
    project: &str,
    uuid: &str,
    title: &str,
    date: &str,
    jsonl_text: &str,
) -> NormalizedSession {
    let mut mapper = JsonlMapper::new(project, uuid);
    for line in jsonl_text.lines() {
        mapper.apply_line(line);
    }

    let mut items_by_turn: std::collections::BTreeMap<u64, Vec<TimelineItem>> = Default::default();
    for item in mapper.timeline().items() {
        items_by_turn.entry(item.turn).or_default().push(item.clone());
    }

    // A turn exists if it has a prompt, an answer, or items.
    let mut turn_ids: std::collections::BTreeSet<u64> = Default::default();
    turn_ids.extend(mapper.turns().keys().copied());
    turn_ids.extend(mapper.answers().keys().copied());
    turn_ids.extend(items_by_turn.keys().copied());
    turn_ids.remove(&0);

    let mut turns = Vec::new();
    if let Some(pre) = items_by_turn.get(&0) {
        turns.push(NormalizedTurn {
            turn: 0,
            date: None,
            prompt: None,
            answer: None,
            tokens: mapper.tokens().get(&0).copied(),
            items: pre.clone(),
        });
    }
    for t in turn_ids {
        turns.push(NormalizedTurn {
            turn: t,
            date: mapper.dates().get(&t).cloned(),
            prompt: mapper.turns().get(&t).cloned(),
            answer: mapper.answers().get(&t).cloned(),
            tokens: mapper.tokens().get(&t).copied(),
            items: items_by_turn.get(&t).cloned().unwrap_or_default(),
        });
    }

    let mut total_tokens = TokenUsage::default();
    for usage in mapper.tokens().values() {
        total_tokens.add(usage);
    }

    NormalizedSession {
        schema_version: SCHEMA_VERSION,
        uuid: uuid.to_string(),
        project: project.to_string(),
        title: title.to_string(),
        date: date.to_string(),
        model: mapper.model().map(str::to_string),
        total_tokens,
        turns,
    }
}

/// Minimal HTML text escaping for the few template slots (title) that are HTML
/// context. Conversation content never goes through here — it rides in the JSON
/// payload instead (see module docs).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Render the self-contained reader. The session document is embedded as JSON
/// with **every** `<` escaped to the JSON escape `\\u003c` (valid both as JSON and as a JS
/// string escape), so no transcript content can close the `<script>` element or
/// open a tag; the inline renderer only ever assigns `textContent`.
pub fn render_book_html(session: &NormalizedSession) -> String {
    let json = serde_json::to_string(session)
        .unwrap_or_else(|_| "null".to_string())
        .replace('<', "\\u003c");
    BOOK_TEMPLATE
        .replace("__TITLE__", &html_escape(&session.title))
        .replace("__DATA__", &json)
}

/// Write (or replace) the archive folder for `session`: verbatim `session.jsonl`
/// from `jsonl_bytes`, `normalized.json`, and `book.html`. Builds in a temp dir
/// and renames into place, removing any previous folder for the same uuid first
/// (idempotent re-archive; a crash leaves at worst a `.tmp-` dir, never a
/// half-written final folder).
pub fn write_archive(
    archive_root: &Path,
    project: &str,
    session: &NormalizedSession,
    jsonl_bytes: &[u8],
) -> io::Result<ArchiveOutcome> {
    if !is_safe_uuid(&session.uuid) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe session id"));
    }
    let sessions_dir = archive_root.join(project_key(project)).join("sessions");
    fs::create_dir_all(&sessions_dir)?;

    let short = uuid8(&session.uuid);
    let final_name = format!("{}-{}-{}", session.date, slugify(&session.title, 40), short);
    let final_dir = sessions_dir.join(&final_name);

    // Build the new content off to the side first.
    let tmp_dir = sessions_dir.join(format!(
        ".tmp-{short}-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&tmp_dir)?;
    let write_all = (|| -> io::Result<()> {
        fs::write(tmp_dir.join("session.jsonl"), jsonl_bytes)?;
        let json = serde_json::to_string_pretty(session)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(tmp_dir.join("normalized.json"), json)?;
        fs::write(tmp_dir.join("book.html"), render_book_html(session))?;
        Ok(())
    })();
    if let Err(e) = write_all {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    // Drop any previous archive of this session (suffix match, so a changed
    // title/date can't leave a duplicate folder behind).
    let suffix = format!("-{short}");
    let mut replaced = false;
    if let Ok(entries) = fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.path().is_dir() && !name.starts_with(".tmp-") && name.ends_with(&suffix) {
                fs::remove_dir_all(entry.path())?;
                replaced = true;
            }
        }
    }

    if let Err(e) = fs::rename(&tmp_dir, &final_dir) {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }
    Ok(ArchiveOutcome {
        book_path: final_dir.join("book.html"),
        dir: final_dir,
        replaced,
    })
}

/// The self-contained reader page. Placeholders: `__TITLE__` (HTML-escaped) and
/// `__DATA__` (the `<`-escaped JSON document). No external requests, no
/// innerHTML — content is rendered with `textContent` only.
const BOOK_TEMPLATE: &str = r##"<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #14161a; color: #d7dae0; font: 14px/1.6 -apple-system, "Noto Sans KR", sans-serif; }
header { position: sticky; top: 0; background: #1a1d23; border-bottom: 1px solid #2a2e36; padding: 10px 16px; z-index: 2; }
header h1 { font-size: 15px; margin: 0 0 2px; }
header .meta { font-size: 12px; color: #8b93a1; }
main { max-width: 900px; margin: 0 auto; padding: 16px 16px 90px; }
.turn { border: 1px solid #2a2e36; border-radius: 8px; margin: 14px 0; overflow: hidden; }
.turn-head { background: #1a1d23; color: #8b93a1; font-size: 12px; padding: 4px 12px; }
.prompt, .answer, .item { border-top: 1px solid #23262d; }
.prompt { background: #1c2230; }
.answer { background: #19211c; }
.role { font-size: 11px; font-weight: 600; padding: 6px 12px 0; }
.prompt .role { color: #7aa2f7; }
.answer .role { color: #9ece6a; }
pre.text, pre.out { margin: 4px 0 10px; padding: 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
pre.out { font: 12px/1.5 ui-monospace, monospace; color: #9aa3b2; max-height: 320px; overflow: auto; }
details.item summary { cursor: pointer; padding: 6px 12px; font-size: 13px; color: #b6bdc9; list-style: none; }
details.item summary::before { content: "▸ "; color: #565f6e; }
details.item[open] summary::before { content: "▾ "; }
details.item.failed summary { color: #f7768e; }
details.item.canceled summary { color: #7b8496; text-decoration: line-through; }
.diff { margin: 4px 12px 10px; border: 1px solid #2a2e36; border-radius: 6px; overflow: hidden; }
.diff .path { font: 11px ui-monospace, monospace; background: #1a1d23; padding: 3px 8px; color: #8b93a1; }
.diff pre { margin: 0; padding: 6px 8px; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff pre.old { background: #2a1a1e; color: #e0a3ad; }
.diff pre.new { background: #16251b; color: #a8d5b0; }
footer { position: fixed; bottom: 0; left: 0; right: 0; background: #1a1d23; border-top: 1px solid #2a2e36; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 8px; }
footer button { background: #23262d; color: #d7dae0; border: 1px solid #343945; border-radius: 6px; padding: 4px 14px; cursor: pointer; font: inherit; }
footer button:hover { background: #2b303a; }
#pos { font-size: 12px; color: #8b93a1; min-width: 90px; text-align: center; }
.step.hidden { display: none; }
.step.current { outline: 1px solid #7aa2f7; outline-offset: -1px; }
</style>
</head>
<body>
<header><h1 id="t"></h1><div class="meta" id="m"></div></header>
<main id="book"></main>
<footer>
<button id="prev" title="이전 (←)">←</button>
<span id="pos"></span>
<button id="next" title="다음 (→)">→</button>
<button id="mode">단계 보기</button>
</footer>
<script>
"use strict";
const DATA = __DATA__;
const ICON = { read: "📖", edit: "✏️", delete: "🗑", move: "📦", search: "🔎", execute: "▶", think: "💭", fetch: "🌐", question: "❓", plan: "🗺", other: "🔧" };
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function clip(s, max) { return s.length > max ? s.slice(0, max) + "\n… (생략)" : s; }
function fmtTokens(u) { return u ? "in " + (u.input + u.cache_read + u.cache_creation).toLocaleString() + " · out " + u.output.toLocaleString() : ""; }

document.getElementById("t").textContent = DATA.title;
document.title = DATA.title;
document.getElementById("m").textContent =
  [DATA.project, DATA.date, DATA.model, fmtTokens(DATA.total_tokens)].filter(Boolean).join("  ·  ");

const book = document.getElementById("book");
const steps = [];
function addStep(node) { node.classList.add("step"); steps.push(node); }

for (const t of DATA.turns) {
  const sec = el("section", "turn");
  const head = t.turn === 0 ? "시작 전" : "Turn " + t.turn;
  sec.appendChild(el("div", "turn-head", head + (t.date ? " · " + t.date : "") + (t.tokens ? " · " + fmtTokens(t.tokens) : "")));
  if (t.prompt) {
    const p = el("div", "prompt");
    p.appendChild(el("div", "role", "사용자"));
    p.appendChild(el("pre", "text", t.prompt));
    sec.appendChild(p);
    addStep(p);
  }
  for (const it of t.items) {
    const d = el("details", "item " + it.agent_status);
    d.appendChild(el("summary", null, (ICON[it.kind] || ICON.other) + " " + (it.title || it.kind)));
    if (it.content_text) d.appendChild(el("pre", "out", clip(it.content_text, 20000)));
    for (const df of it.diffs) {
      const dv = el("div", "diff");
      dv.appendChild(el("div", "path", df.path));
      if (df.old_text != null) dv.appendChild(el("pre", "old", clip(df.old_text, 20000)));
      dv.appendChild(el("pre", "new", clip(df.new_text, 20000)));
      d.appendChild(dv);
    }
    sec.appendChild(d);
    addStep(d);
  }
  if (t.answer) {
    const a = el("div", "answer");
    a.appendChild(el("div", "role", "Claude"));
    a.appendChild(el("pre", "text", t.answer));
    sec.appendChild(a);
    addStep(a);
  }
  book.appendChild(sec);
}

let cur = 0;
let stepMode = false;
const pos = document.getElementById("pos");
const modeBtn = document.getElementById("mode");
function apply() {
  steps.forEach((n, i) => {
    n.classList.toggle("hidden", stepMode && i > cur);
    n.classList.toggle("current", stepMode && i === cur);
  });
  pos.textContent = stepMode ? (cur + 1) + " / " + steps.length : steps.length + " steps";
  if (stepMode && steps[cur]) steps[cur].scrollIntoView({ block: "center" });
}
function move(d) {
  if (!stepMode) { stepMode = true; modeBtn.textContent = "전체 보기"; cur = d > 0 ? 0 : steps.length - 1; }
  else cur = Math.min(steps.length - 1, Math.max(0, cur + d));
  apply();
}
document.getElementById("prev").addEventListener("click", () => move(-1));
document.getElementById("next").addEventListener("click", () => move(1));
modeBtn.addEventListener("click", () => {
  stepMode = !stepMode;
  modeBtn.textContent = stepMode ? "전체 보기" : "단계 보기";
  if (stepMode) cur = 0;
  apply();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") move(-1);
  else if (e.key === "ArrowRight") move(1);
});
apply();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    const UUID: &str = "abcd1234-5678-90ef-ghij-klmnopqrstuv";

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-archive-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn sample_jsonl(prompt: &str) -> String {
        [
            json!({ "type": "user", "sessionId": UUID, "timestamp": "2026-07-19T08:00:00.000Z",
                "message": { "role": "user", "content": prompt } }),
            json!({ "type": "assistant", "sessionId": UUID,
                "message": { "role": "assistant", "model": "claude-opus-4-8",
                    "usage": { "input_tokens": 10, "output_tokens": 5 },
                    "content": [
                        { "type": "text", "text": "answer text" },
                        { "type": "tool_use", "id": "t1", "name": "Read",
                          "input": { "file_path": "/p/src/main.rs" } }
                    ] } }),
            json!({ "type": "user", "sessionId": UUID,
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "file body" }
                ] } }),
        ]
        .map(|v| v.to_string())
        .join("\n")
    }

    fn sample_session(title: &str) -> NormalizedSession {
        normalize("/p", UUID, title, "2026-07-19", &sample_jsonl("do the thing"))
    }

    #[test]
    fn slugify_keeps_letters_collapses_rest() {
        assert_eq!(slugify("아카이브 구조: 전환!", 40), "아카이브-구조-전환");
        assert_eq!(slugify("Fix Bug #12  (retry)", 40), "fix-bug-12-retry");
        assert_eq!(slugify("///", 40), "session");
        assert_eq!(slugify("", 40), "session");
        assert!(slugify(&"가".repeat(100), 10).chars().count() <= 10);
    }

    #[test]
    fn normalize_groups_turns_items_and_totals() {
        let s = sample_session("내 작업");
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert_eq!(s.uuid, UUID);
        assert_eq!(s.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(s.turns.len(), 1);
        let t = &s.turns[0];
        assert_eq!(t.turn, 1);
        assert_eq!(t.prompt.as_deref(), Some("do the thing"));
        assert_eq!(t.answer.as_deref(), Some("answer text"));
        assert_eq!(t.date.as_deref(), Some("2026-07-19"));
        assert_eq!(t.items.len(), 1);
        assert_eq!(t.items[0].content_text.as_deref(), Some("file body"));
        assert_eq!(s.total_tokens.input, 10);
        assert_eq!(s.total_tokens.output, 5);
    }

    #[test]
    fn book_html_cannot_carry_active_markup_from_transcript() {
        let evil = "</script><script>alert(1)</script><img src=x onerror=alert(2)>";
        let s = normalize("/p", UUID, "t", "2026-07-19", &sample_jsonl(evil));
        assert_eq!(s.turns[0].prompt.as_deref(), Some(evil), "content preserved verbatim");
        let html = render_book_html(&s);
        // No `<` from the transcript survives into markup position.
        assert!(!html.contains("<script>alert"), "script cannot break out");
        assert!(!html.contains("<img src=x"), "no raw tags from content");
        assert!(html.contains("\\u003cscript>alert(1)"), "escaped into the JSON payload");
    }

    #[test]
    fn book_html_title_is_escaped() {
        let mut s = sample_session("t");
        s.title = "<b>제목 & \"인용\"</b>".to_string();
        let html = render_book_html(&s);
        assert!(html.contains("<title>&lt;b&gt;제목 &amp; &quot;인용&quot;&lt;/b&gt;</title>"));
        assert!(!html.contains("<title><b>"));
    }

    #[test]
    fn write_archive_lays_out_files_with_verbatim_jsonl() {
        let root = temp_root("layout");
        let jsonl = sample_jsonl("do the thing");
        let s = sample_session("아카이브 테스트");
        let out = write_archive(&root, "/p", &s, jsonl.as_bytes()).unwrap();
        assert!(!out.replaced);
        assert!(out.dir.file_name().unwrap().to_string_lossy().starts_with("2026-07-19-아카이브-테스트-"));
        assert_eq!(fs::read(out.dir.join("session.jsonl")).unwrap(), jsonl.as_bytes());
        assert!(out.book_path.is_file());
        let norm: NormalizedSession =
            serde_json::from_str(&fs::read_to_string(out.dir.join("normalized.json")).unwrap()).unwrap();
        assert_eq!(norm.uuid, UUID);
        assert_eq!(norm.schema_version, SCHEMA_VERSION);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rearchive_is_idempotent_even_with_new_title() {
        let root = temp_root("idem");
        let jsonl = sample_jsonl("p");
        let s1 = sample_session("첫 제목");
        let out1 = write_archive(&root, "/p", &s1, jsonl.as_bytes()).unwrap();
        assert!(!out1.replaced);
        // Same session again, different title → old folder replaced, not duplicated.
        let s2 = sample_session("다른 제목");
        let out2 = write_archive(&root, "/p", &s2, jsonl.as_bytes()).unwrap();
        assert!(out2.replaced);
        assert!(!out1.dir.exists(), "old folder removed");
        let sessions = out2.dir.parent().unwrap();
        let dirs: Vec<_> = fs::read_dir(sessions).unwrap().flatten().collect();
        assert_eq!(dirs.len(), 1, "exactly one folder per session");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn different_sessions_do_not_collide() {
        let root = temp_root("two");
        let jsonl = sample_jsonl("p");
        let a = sample_session("작업 A");
        let mut b = sample_session("작업 B");
        b.uuid = "ffff9999-1111-2222-3333-444455556666".to_string();
        write_archive(&root, "/p", &a, jsonl.as_bytes()).unwrap();
        let out_b = write_archive(&root, "/p", &b, jsonl.as_bytes()).unwrap();
        assert!(!out_b.replaced, "a different uuid never replaces another session");
        let sessions = out_b.dir.parent().unwrap();
        assert_eq!(fs::read_dir(sessions).unwrap().flatten().count(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unsafe_or_short_uuid_is_rejected() {
        let root = temp_root("unsafe");
        let mut s = sample_session("t");
        s.uuid = "../../evil".to_string();
        assert!(write_archive(&root, "/p", &s, b"{}").is_err());
        s.uuid = "short".to_string();
        assert!(write_archive(&root, "/p", &s, b"{}").is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
