//! Session **knowledge base**: parse the fixed-format extraction a one-shot
//! `claude -p` produces at archive time into typed entries (issue / method /
//! domain), persist them as one-fact-per-file markdown with an English-keyed
//! frontmatter, and keep a one-line-per-entry `INDEX.md` — the shape a future
//! MCP lookup (and Claude itself) reads cheapest: scan the index, open only the
//! matching file, grep verbatim error strings in bodies.
//!
//! Layout (sibling of `sessions/` under the same project archive):
//! ```text
//! <archive_root>/<project_key>/knowledge/
//!   INDEX.md
//!   issues/<date>-<slug>.md
//!   methods/<date>-<slug>.md
//!   domain/<date>-<slug>.md
//! ```
//!
//! Invariants:
//! - Frontmatter **keys are fixed English** (`type`/`title`/`error_code`/`tags`/
//!   `files`/`session`/`status`/`problem`/`applies_when`) — the future MCP
//!   contract; bodies stay Korean prose.
//! - Re-archiving a session is idempotent: entries carrying that session's uuid
//!   are removed before the new ones are written, and `INDEX.md` is rebuilt
//!   from disk (never appended), so stale rows can't accumulate.
//! - Parsing is defensive: a malformed entry block is skipped, never fatal —
//!   the archive itself must not fail because the model drifted off-format.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::archive::{slugify, NormalizedSession};
use crate::history::project_key;

/// The three knowledge categories, each with its own folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnowledgeKind {
    Issue,
    Method,
    Domain,
}

impl KnowledgeKind {
    pub fn dir_name(self) -> &'static str {
        match self {
            KnowledgeKind::Issue => "issues",
            KnowledgeKind::Method => "methods",
            KnowledgeKind::Domain => "domain",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            KnowledgeKind::Issue => "issue",
            KnowledgeKind::Method => "method",
            KnowledgeKind::Domain => "domain",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "issue" => Some(KnowledgeKind::Issue),
            "method" => Some(KnowledgeKind::Method),
            "domain" => Some(KnowledgeKind::Domain),
            _ => None,
        }
    }
}

/// One knowledge fact, parsed from an extraction `===ENTRY===` block.
#[derive(Debug, Clone)]
pub struct KnowledgeEntry {
    pub kind: KnowledgeKind,
    /// For an issue this is the error code / cause (사용자 결정: 제목 = 원인).
    pub title: String,
    pub error_code: Option<String>,
    pub problem: Option<String>,
    pub applies_when: Option<String>,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub files: Vec<String>,
    /// Markdown body (fixed section headings per kind, Korean prose).
    pub body: String,
}

/// Everything one extraction call yields: the session title + summary, and the
/// knowledge entries.
#[derive(Debug, Clone, Default)]
pub struct ExtractedKnowledge {
    pub title: String,
    pub summary: String,
    pub entries: Vec<KnowledgeEntry>,
}

/// Render a normalized session as compact text for the extraction prompt:
/// per turn the prompt/answer (char-capped) plus every **failed** item's error
/// output verbatim (the raw material issue entries grep against later) and the
/// files the turn changed. Bounded like the handoff renderer so a huge session
/// can't blow the prompt.
pub fn render_session_for_extraction(s: &NormalizedSession) -> String {
    use std::fmt::Write as _;
    const MAX_TURNS: usize = 200;
    const MAX_TEXT: usize = 800;
    const MAX_ERR: usize = 1200;
    const MAX_FILES: usize = 40;

    fn cap(s: &str, max: usize) -> String {
        if s.chars().count() <= max {
            return s.to_string();
        }
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }

    let mut out = String::new();
    let _ = writeln!(out, "# 세션 \"{}\" ({})", s.title, s.date);
    let total = s.turns.len();
    let start = total.saturating_sub(MAX_TURNS);
    if start > 0 {
        let _ = writeln!(out, "\n(앞 {start} turn 생략 — 최근 {MAX_TURNS} turn만)");
    }
    for t in s.turns.iter().skip(start) {
        let _ = writeln!(out, "\n## Turn {}", t.turn);
        if let Some(p) = &t.prompt {
            let _ = writeln!(out, "- 사용자: {}", cap(p, MAX_TEXT));
        }
        if let Some(a) = &t.answer {
            let _ = writeln!(out, "- 어시스턴트: {}", cap(a, MAX_TEXT));
        }
        let mut files: Vec<String> = t
            .items
            .iter()
            .flat_map(|it| it.diffs.iter().map(|d| d.path.display().to_string()))
            .collect();
        files.sort();
        files.dedup();
        if !files.is_empty() {
            let shown: Vec<&str> = files.iter().take(MAX_FILES).map(String::as_str).collect();
            let _ = writeln!(out, "- 변경 파일: {}", shown.join(", "));
        }
        for it in &t.items {
            if it.agent_status == crate::timeline::AgentStatus::Failed {
                let err = it.content_text.as_deref().unwrap_or("");
                let _ = writeln!(
                    out,
                    "- 실패한 도구 [{}]: {}",
                    cap(&it.title, 120),
                    cap(err, MAX_ERR)
                );
            }
        }
    }
    out
}

/// Parse the extraction output. Format contract (the prompt pins it):
/// ```text
/// ===SUMMARY===
/// TITLE: <one line>
/// <markdown summary body>
/// ===ENTRY===
/// type: issue | method | domain
/// title: <one line — issue는 에러코드/원인>
/// <optional header lines: error_code / problem / applies_when / status / tags / files>
/// ---
/// <markdown body>
/// ```
/// Every block is best-effort: a malformed entry is skipped; missing markers
/// degrade to "the whole text is the summary".
pub fn parse_extraction(raw: &str) -> ExtractedKnowledge {
    let mut blocks: Vec<(bool, Vec<&str>)> = Vec::new(); // (is_entry, lines)
    let mut current: Option<(bool, Vec<&str>)> = None;
    for line in raw.lines() {
        match line.trim() {
            "===SUMMARY===" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                current = Some((false, Vec::new()));
            }
            "===ENTRY===" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                current = Some((true, Vec::new()));
            }
            _ => match &mut current {
                Some((_, lines)) => lines.push(line),
                // Text before any marker: treat as (the start of) the summary.
                None => current = Some((false, vec![line])),
            },
        }
    }
    if let Some(b) = current.take() {
        blocks.push(b);
    }

    let mut out = ExtractedKnowledge::default();
    for (is_entry, lines) in blocks {
        if is_entry {
            if let Some(entry) = parse_entry(&lines) {
                out.entries.push(entry);
            }
        } else if out.summary.is_empty() {
            let (title, body) = split_title(&lines.join("\n"));
            out.title = title;
            out.summary = body;
        }
    }
    out
}

/// Split a summary block into (TITLE line, body). Without the marker the first
/// non-empty line becomes the title and the whole text stays the body — a
/// drifting model never loses the summary.
fn split_title(text: &str) -> (String, String) {
    let trimmed = text.trim();
    let first = trimmed.lines().next().unwrap_or("").trim();
    for prefix in ["TITLE:", "title:", "Title:"] {
        if let Some(t) = first.strip_prefix(prefix) {
            let body = trimmed
                .split_once('\n')
                .map(|(_, rest)| rest.trim().to_string())
                .unwrap_or_default();
            let title = t.trim().to_string();
            let body = if body.is_empty() { title.clone() } else { body };
            return (title, body);
        }
    }
    let derived = trimmed.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    (derived.to_string(), trimmed.to_string())
}

fn parse_list(v: &str) -> Vec<String> {
    v.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_entry(lines: &[&str]) -> Option<KnowledgeEntry> {
    // Header lines until a `---` divider; the rest is the body.
    let divider = lines.iter().position(|l| l.trim() == "---");
    let (head, body_lines) = match divider {
        Some(i) => (&lines[..i], &lines[i + 1..]),
        None => (lines, &[][..]),
    };
    let mut kind = None;
    let mut title = String::new();
    let mut entry = KnowledgeEntry {
        kind: KnowledgeKind::Issue, // placeholder until `kind` resolves
        title: String::new(),
        error_code: None,
        problem: None,
        applies_when: None,
        status: None,
        tags: Vec::new(),
        files: Vec::new(),
        body: String::new(),
    };
    for line in head {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim().to_ascii_lowercase().as_str() {
            "type" => kind = KnowledgeKind::parse(v),
            "title" => title = v.trim_matches('"').to_string(),
            "error_code" => entry.error_code = Some(v.to_string()),
            "problem" => entry.problem = Some(v.to_string()),
            "applies_when" => entry.applies_when = Some(v.to_string()),
            "status" => entry.status = Some(v.to_string()),
            "tags" => entry.tags = parse_list(v),
            "files" => entry.files = parse_list(v),
            _ => {}
        }
    }
    let kind = kind?;
    if title.is_empty() {
        return None;
    }
    entry.kind = kind;
    entry.title = title;
    entry.body = body_lines.join("\n").trim().to_string();
    Some(entry)
}

fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "'"))
}

fn yaml_list(items: &[String]) -> String {
    let quoted: Vec<String> = items.iter().map(|s| yaml_quote(s)).collect();
    format!("[{}]", quoted.join(", "))
}

/// Serialize one entry as frontmatter + body. Key order is fixed (stable diffs,
/// stable MCP parsing).
fn render_entry(entry: &KnowledgeEntry, session_uuid: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(out, "---");
    let _ = writeln!(out, "type: {}", entry.kind.as_str());
    let _ = writeln!(out, "title: {}", yaml_quote(&entry.title));
    if let Some(v) = &entry.error_code {
        let _ = writeln!(out, "error_code: {}", yaml_quote(v));
    }
    if let Some(v) = &entry.problem {
        let _ = writeln!(out, "problem: {}", yaml_quote(v));
    }
    if let Some(v) = &entry.applies_when {
        let _ = writeln!(out, "applies_when: {}", yaml_quote(v));
    }
    if let Some(v) = &entry.status {
        let _ = writeln!(out, "status: {v}");
    }
    if !entry.tags.is_empty() {
        let _ = writeln!(out, "tags: {}", yaml_list(&entry.tags));
    }
    if !entry.files.is_empty() {
        let _ = writeln!(out, "files: {}", yaml_list(&entry.files));
    }
    let _ = writeln!(out, "session: {session_uuid}");
    let _ = writeln!(out, "---");
    let _ = writeln!(out);
    out.push_str(&entry.body);
    out.push('\n');
    out
}

/// Parse the frontmatter of one of **our** knowledge files back into a flat
/// key→value map (`None` if the file has no leading `---` fence). Values keep
/// their raw form except surrounding quotes on scalars.
fn parse_frontmatter(text: &str) -> Option<BTreeMap<String, String>> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut map = BTreeMap::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(map);
        }
        if let Some((k, v)) = line.split_once(':') {
            map.insert(
                k.trim().to_string(),
                v.trim().trim_matches('"').to_string(),
            );
        }
    }
    None // unterminated fence
}

/// The `knowledge/` directory for a project.
pub fn knowledge_dir(archive_root: &Path, project: &str) -> PathBuf {
    archive_root.join(project_key(project)).join("knowledge")
}

/// Persist a session's extracted entries and rebuild `INDEX.md`.
///
/// Idempotent per session: files whose frontmatter `session:` equals
/// `session_uuid` are removed first, so a re-archive replaces its own entries
/// and never duplicates them. Returns the written file paths.
pub fn write_knowledge(
    archive_root: &Path,
    project: &str,
    session_uuid: &str,
    date: &str,
    entries: &[KnowledgeEntry],
) -> io::Result<Vec<PathBuf>> {
    let root = knowledge_dir(archive_root, project);
    remove_session_entries(&root, session_uuid)?;

    let mut written = Vec::new();
    for entry in entries {
        let dir = root.join(entry.kind.dir_name());
        fs::create_dir_all(&dir)?;
        let stem = format!("{date}-{}", slugify(&entry.title, 50));
        // Distinct facts may slug identically — probe for a free name.
        let mut path = dir.join(format!("{stem}.md"));
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem}-{n}.md"));
            n += 1;
        }
        fs::write(&path, render_entry(entry, session_uuid))?;
        written.push(path);
    }

    rebuild_index(&root)?;
    Ok(written)
}

/// Remove every knowledge file previously written for `session_uuid` (matched
/// by its frontmatter, never by filename guessing).
fn remove_session_entries(root: &Path, session_uuid: &str) -> io::Result<()> {
    for kind in [KnowledgeKind::Issue, KnowledgeKind::Method, KnowledgeKind::Domain] {
        let dir = root.join(kind.dir_name());
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for file in entries.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let is_ours = parse_frontmatter(&text)
                .and_then(|fm| fm.get("session").cloned())
                .is_some_and(|s| s == session_uuid);
            if is_ours {
                fs::remove_file(&path)?;
            }
        }
    }
    Ok(())
}

/// Regenerate `INDEX.md` from the files on disk — one line per entry, grouped
/// by kind, newest first (date-prefixed filenames sort that way). Rebuilt, not
/// appended, so it can never drift from the folder contents.
fn rebuild_index(root: &Path) -> io::Result<()> {
    use std::fmt::Write as _;
    let mut out = String::from("# Knowledge Index\n");
    let mut total = 0usize;
    for (kind, heading) in [
        (KnowledgeKind::Issue, "## issues"),
        (KnowledgeKind::Method, "## methods"),
        (KnowledgeKind::Domain, "## domain"),
    ] {
        let dir = root.join(kind.dir_name());
        let mut rows: Vec<(String, String)> = Vec::new(); // (filename, line)
        if let Ok(entries) = fs::read_dir(&dir) {
            for file in entries.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else { continue };
                let Some(fm) = parse_frontmatter(&text) else { continue };
                let Some(title) = fm.get("title") else { continue };
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let mut line = format!("- [{title}]({}/{name})", kind.dir_name());
                if let Some(tags) = fm.get("tags").filter(|t| !t.is_empty()) {
                    let _ = write!(line, " — {tags}");
                }
                rows.push((name, line));
            }
        }
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0)); // newest date-prefix first
        total += rows.len();
        let _ = write!(out, "\n{heading}\n");
        for (_, line) in rows {
            out.push_str(&line);
            out.push('\n');
        }
    }
    if total == 0 {
        // No entries at all → no index file to mislead a scanner. A missing file
        // is that state already; any other removal error is real (a stale INDEX
        // would keep pointing at deleted entries) and must surface.
        return match fs::remove_file(root.join("INDEX.md")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    fs::create_dir_all(root)?;
    fs::write(root.join("INDEX.md"), out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const UUID: &str = "abcd1234-5678-90ef-aaaa-bbbbccccdddd";

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-knowledge-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    const SAMPLE: &str = "\
===SUMMARY===
TITLE: 아카이브 파이프라인 구축
이 세션은 아카이브 기능을 만들었다.

===ENTRY===
type: issue
title: ECONNREFUSED — ipc 초기화 전 invoke
error_code: ECONNREFUSED
tags: [tauri, ipc]
files: [src/main.tsx]
status: resolved
---
## 증상
Error: ECONNREFUSED at invoke()
## 해결
초기화 후 호출로 이동

===ENTRY===
type: method
title: remount race 3중 가드
problem: 탭 remount 시 중복 실행
applies_when: 마운트 타이밍 의존 초기화
tags: react
---
## 상황
가드 3중으로 방어했다.
";

    #[test]
    fn parse_extraction_reads_summary_and_typed_entries() {
        let ex = parse_extraction(SAMPLE);
        assert_eq!(ex.title, "아카이브 파이프라인 구축");
        assert!(ex.summary.contains("아카이브 기능"));
        assert_eq!(ex.entries.len(), 2);
        let issue = &ex.entries[0];
        assert_eq!(issue.kind, KnowledgeKind::Issue);
        assert_eq!(issue.title, "ECONNREFUSED — ipc 초기화 전 invoke");
        assert_eq!(issue.error_code.as_deref(), Some("ECONNREFUSED"));
        assert_eq!(issue.tags, vec!["tauri", "ipc"]);
        assert_eq!(issue.files, vec!["src/main.tsx"]);
        assert!(issue.body.contains("ECONNREFUSED at invoke()"), "에러 원문 보존");
        let method = &ex.entries[1];
        assert_eq!(method.kind, KnowledgeKind::Method);
        assert_eq!(method.problem.as_deref(), Some("탭 remount 시 중복 실행"));
        assert_eq!(method.tags, vec!["react"], "비대괄호 리스트도 허용");
    }

    #[test]
    fn parse_extraction_skips_malformed_entries_and_survives_no_markers() {
        let raw = "\
===SUMMARY===
TITLE: 제목
본문
===ENTRY===
type: mystery
title: 알 수 없는 타입
---
버려짐
===ENTRY===
title 만 있고 type 없음
---
버려짐
===ENTRY===
type: domain
title: JSONL 스키마
---
살아남음
";
        let ex = parse_extraction(raw);
        assert_eq!(ex.entries.len(), 1);
        assert_eq!(ex.entries[0].kind, KnowledgeKind::Domain);

        // No markers at all → everything is the summary, entries empty.
        let ex2 = parse_extraction("그냥 산문 응답\n둘째 줄");
        assert_eq!(ex2.entries.len(), 0);
        assert_eq!(ex2.title, "그냥 산문 응답");
        assert!(ex2.summary.contains("둘째 줄"));
    }

    #[test]
    fn write_knowledge_lays_out_files_frontmatter_and_index() {
        let root = temp_root("layout");
        let ex = parse_extraction(SAMPLE);
        let written = write_knowledge(&root, "/p", UUID, "2026-07-19", &ex.entries).unwrap();
        assert_eq!(written.len(), 2);
        assert!(written[0].to_string_lossy().contains("issues/2026-07-19-econnrefused"));
        let text = fs::read_to_string(&written[0]).unwrap();
        assert!(text.starts_with("---\ntype: issue\n"));
        assert!(text.contains(&format!("session: {UUID}")));
        assert!(text.contains("error_code: \"ECONNREFUSED\""));
        assert!(text.contains("## 증상"));
        let index = fs::read_to_string(knowledge_dir(&root, "/p").join("INDEX.md")).unwrap();
        assert!(index.contains("## issues"));
        assert!(index.contains("## methods"));
        assert!(index.contains("ECONNREFUSED — ipc 초기화 전 invoke"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rearchive_replaces_own_entries_only() {
        let root = temp_root("idem");
        let ex = parse_extraction(SAMPLE);
        write_knowledge(&root, "/p", UUID, "2026-07-19", &ex.entries).unwrap();
        // Another session's entry must survive.
        let other_uuid = "ffff0000-1111-2222-3333-444455556666";
        let other = KnowledgeEntry {
            kind: KnowledgeKind::Issue,
            title: "다른 세션 이슈".into(),
            error_code: None,
            problem: None,
            applies_when: None,
            status: None,
            tags: vec![],
            files: vec![],
            body: "본문".into(),
        };
        write_knowledge(&root, "/p", other_uuid, "2026-07-18", &[other]).unwrap();
        // Re-archive of the first session with a single (changed) entry.
        let ex2 = parse_extraction(SAMPLE);
        write_knowledge(&root, "/p", UUID, "2026-07-20", &ex2.entries[..1]).unwrap();

        let kroot = knowledge_dir(&root, "/p");
        let issues: Vec<_> = fs::read_dir(kroot.join("issues")).unwrap().flatten().collect();
        // 첫 세션의 재실행분 1 + 다른 세션 1 — 구판(07-19)은 제거됨.
        assert_eq!(issues.len(), 2);
        assert!(!kroot.join("methods").exists() || fs::read_dir(kroot.join("methods")).unwrap().flatten().count() == 0,
            "재실행에서 빠진 method 항목도 제거됨");
        let index = fs::read_to_string(kroot.join("INDEX.md")).unwrap();
        assert!(index.contains("다른 세션 이슈"));
        assert!(index.contains("2026-07-20-econnrefused"));
        assert!(!index.contains("2026-07-19-econnrefused"), "INDEX는 디스크에서 재생성");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn colliding_titles_get_distinct_files() {
        let root = temp_root("collide");
        let mk = |body: &str| KnowledgeEntry {
            kind: KnowledgeKind::Domain,
            title: "같은 제목".into(),
            error_code: None,
            problem: None,
            applies_when: None,
            status: None,
            tags: vec![],
            files: vec![],
            body: body.into(),
        };
        let written =
            write_knowledge(&root, "/p", UUID, "2026-07-19", &[mk("하나"), mk("둘")]).unwrap();
        assert_eq!(written.len(), 2);
        assert_ne!(written[0], written[1]);
        assert!(written[1].to_string_lossy().ends_with("-2.md"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn render_session_for_extraction_includes_failed_tool_errors() {
        use crate::archive::normalize;
        let lines = [
            serde_json::json!({ "type": "user", "sessionId": UUID,
                "message": { "role": "user", "content": "빌드 고쳐줘" } }),
            serde_json::json!({ "type": "assistant", "sessionId": UUID,
                "message": { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash",
                      "input": { "command": "cargo build" } } ] } }),
            serde_json::json!({ "type": "user", "sessionId": UUID,
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "is_error": true,
                      "content": "error[E0308]: mismatched types" } ] } }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let s = normalize("/p", UUID, "t", "2026-07-19", &lines);
        let rendered = render_session_for_extraction(&s);
        assert!(rendered.contains("빌드 고쳐줘"));
        assert!(rendered.contains("error[E0308]: mismatched types"), "에러 원문이 프롬프트에 실림");
        assert!(rendered.contains("cargo build"));
    }
}
