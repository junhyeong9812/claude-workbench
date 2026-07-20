//! Project **dependency graph** generation: ask a one-shot `claude -p` to explore
//! a project and emit a normalized dependency graph, then persist it under the
//! archive root — the backend half of the "open a project → cached graph → HTML
//! viewer" feature. Rendering (HTML viewer), the tauri command layer, and the
//! frontend live in later tasks; this module is std-only (no tauri).
//!
//! Layout (one file per project, keyed like the session archive):
//! ```text
//! <archive_root>/<project_key>/graph/graph.json
//! ```
//!
//! Invariants:
//! - The Opus call runs with cwd = [`extraction_workdir`] (a fixed `/tmp`
//!   scratch dir), **never** the target project. `claude -p` writes a transcript
//!   keyed by its cwd; running it inside the project would create a session the
//!   backfill scanner then archives, spawning another run — a feedback loop
//!   (see `claude_cli.rs` module docs). A `/tmp` cwd breaks it structurally; the
//!   absolute `project_path` is still explored via the model's own Read/Grep.
//! - Writes only ever land under `archive_root` (canonicalized containment).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::claude_cli::{extraction_workdir, run_claude_p, ClaudeOpts};
use crate::history::project_key;

/// Bump when the shape of [`Graph`] changes so future readers can branch on it.
pub const SCHEMA_VERSION: u32 = 1;

/// Process-unique suffix counter for temp files (same rationale as archive.rs:
/// concurrent writers must never race on a shared temp path).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// One dependency-graph node (a module, file, package, external dep, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub kind: String,
    /// Project-relative path when the node maps to a file/dir; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// One directed dependency edge between two [`Node`] ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// Kind of dependency (import, calls, …) when the model supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// A whole project dependency graph — the single document persisted and later
/// rendered by the viewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    #[serde(default)]
    pub schema_version: u32,
    /// The project root (absolute path) this graph describes — authoritative,
    /// set by [`generate_graph`] rather than trusted from the model output.
    #[serde(default)]
    pub project: String,
    /// UTC ISO-8601 generation timestamp — set by [`generate_graph`].
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

/// The prompt for one graph-generation run. The model is told to explore the
/// **absolute** `project_path` with its own tools (valid even though cwd is a
/// `/tmp` scratch dir) and to emit only the [`Graph`] JSON.
pub fn graph_prompt(project_path: &str) -> String {
    format!(
        "절대경로 `{project_path}` 에 있는 프로젝트를 너의 도구(Read·Grep·Glob·Bash 등)로 직접 \
탐색해 모듈·파일·패키지 간 의존성 그래프를 만들어라.\n\n\
출력은 아래 JSON 스키마를 정확히 따르는 JSON 객체 **하나만** 낼 것 — 코드펜스(```)·설명·머리말·꼬리말 \
전부 금지, 순수 JSON 만:\n\
{{\n\
  \"project\": \"<프로젝트 절대경로>\",\n\
  \"generated_at\": \"\",\n\
  \"nodes\": [ {{ \"id\": \"<고유 id>\", \"label\": \"<표시 이름>\", \"kind\": \"<module|file|package|external 중 하나>\", \"path\": \"<프로젝트 상대경로, 없으면 생략>\" }} ],\n\
  \"edges\": [ {{ \"from\": \"<노드 id>\", \"to\": \"<노드 id>\", \"kind\": \"<의존 종류, 선택>\" }} ]\n\
}}\n\n\
규칙: 노드마다 id 는 고유. edges 의 from/to 는 반드시 nodes 의 id 중 하나여야 한다. \
실제 코드에서 확인한 의존만 넣을 것(추측 금지). generated_at 은 빈 문자열로 두라(호출자가 채운다)."
    )
}

/// Extract the first balanced-looking JSON object substring (`{` … last `}`) —
/// a fallback when the model wraps the object in a code fence or stray prose
/// despite the prompt. Best-effort: assumes a single top-level object.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

/// Parse a graph-generation response into a [`Graph`]. Tries the trimmed text
/// directly, then falls back to the first `{`…`}` object substring (strips code
/// fences / prose). A parse failure returns a user-safe error, never a panic.
pub fn parse_graph_json(raw: &str) -> Result<Graph, String> {
    let trimmed = raw.trim();
    if let Ok(g) = serde_json::from_str::<Graph>(trimmed) {
        return Ok(g);
    }
    let obj = extract_json_object(trimmed)
        .ok_or_else(|| "응답에서 그래프 JSON을 찾을 수 없습니다".to_string())?;
    serde_json::from_str::<Graph>(obj).map_err(|_| "그래프 JSON 파싱에 실패했습니다".to_string())
}

/// Generate a dependency graph for `project_path` via a one-shot `claude -p`.
///
/// cwd is fixed to [`extraction_workdir`] (`/tmp` scratch) to break the backfill
/// feedback loop; `project_path` is granted via `--add-dir` so the model can
/// still read/explore that absolute path (실측 2026-07-20: `claude -p` blocks
/// reads outside cwd, but `--add-dir` allows the absolute path while cwd stays
/// `/tmp`). The `project` and `generated_at` fields are set authoritatively here
/// (never trusted from model output).
pub fn generate_graph(project_path: &str, opts: &ClaudeOpts) -> Result<Graph, String> {
    let workdir = extraction_workdir();
    // Keep the caller's model/effort; add read access to the target project.
    let mut opts = opts.clone();
    opts.add_dirs.push(project_path.to_string());
    let raw = run_claude_p(
        &workdir.to_string_lossy(),
        &graph_prompt(project_path),
        Duration::from_secs(300),
        &opts,
    )?;
    let mut graph = parse_graph_json(&raw)?;
    graph.schema_version = SCHEMA_VERSION;
    graph.project = project_path.to_string();
    graph.generated_at = now_iso8601();
    Ok(graph)
}

/// Reject a target that does not live under `root` (both already canonicalized).
fn ensure_contained(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err("아카이브 밖 경로에는 저장할 수 없습니다".to_string())
    }
}

/// Persist `graph` at `<archive_root>/<project_key>/graph/graph.json`.
///
/// Reuses [`project_key`] for the per-project folder (same key as the session
/// archive). Canonicalizes the archive root and the graph dir and refuses any
/// path that escapes the root (containment — archive.rs pattern). Writes to a
/// temp file and renames into place (atomic; a crash never leaves a half file).
pub fn save_graph(
    archive_root: &Path,
    project_path: &str,
    graph: &Graph,
) -> Result<PathBuf, String> {
    // Root may not exist yet; create it so canonicalize can resolve symlinks.
    fs::create_dir_all(archive_root)
        .map_err(|_| "아카이브 루트를 만들 수 없습니다".to_string())?;
    let root_c =
        fs::canonicalize(archive_root).map_err(|_| "아카이브 루트를 확인할 수 없습니다".to_string())?;

    let dir = root_c.join(project_key(project_path)).join("graph");
    fs::create_dir_all(&dir).map_err(|_| "그래프 폴더를 만들 수 없습니다".to_string())?;
    let dir_c = fs::canonicalize(&dir).map_err(|_| "그래프 폴더를 확인할 수 없습니다".to_string())?;
    ensure_contained(&root_c, &dir_c)?;

    let final_path = dir_c.join("graph.json");
    let json =
        serde_json::to_string_pretty(graph).map_err(|_| "그래프 직렬화에 실패했습니다".to_string())?;

    let tmp = dir_c.join(format!(
        ".graph.json.tmp-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = fs::write(&tmp, &json) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("그래프를 쓸 수 없습니다: {}", e.kind()));
    }
    if let Err(e) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("그래프 저장에 실패했습니다: {}", e.kind()));
    }
    Ok(final_path)
}

/// UTC ISO-8601 (`YYYY-MM-DDThh:mm:ssZ`) for "now". Dependency-free — `core`
/// carries no `chrono`, so the civil date is derived from the Unix epoch.
fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_epoch_utc(secs)
}

/// Format Unix epoch seconds as a UTC ISO-8601 string. Split out so the civil
/// date math is testable without a wall clock.
fn format_epoch_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's `civil_from_days`
/// (public-domain algorithm), valid for the proleptic Gregorian calendar.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-graph-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    const SAMPLE: &str = r#"{
        "project": "/whatever",
        "generated_at": "ignored",
        "nodes": [
            { "id": "a", "label": "A", "kind": "module", "path": "src/a.rs" },
            { "id": "b", "label": "B", "kind": "external" }
        ],
        "edges": [ { "from": "a", "to": "b", "kind": "import" } ]
    }"#;

    #[test]
    fn parse_plain_json() {
        let g = parse_graph_json(SAMPLE).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.nodes[0].id, "a");
        assert_eq!(g.nodes[0].path.as_deref(), Some("src/a.rs"));
        assert_eq!(g.nodes[1].path, None, "path optional");
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].from, "a");
        assert_eq!(g.edges[0].kind.as_deref(), Some("import"));
    }

    #[test]
    fn parse_strips_code_fence() {
        let fenced = format!("```json\n{SAMPLE}\n```");
        let g = parse_graph_json(&fenced).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn parse_falls_back_to_object_amid_prose() {
        let prose = format!("여기 그래프입니다:\n{SAMPLE}\n이상입니다.");
        let g = parse_graph_json(&prose).unwrap();
        assert_eq!(g.nodes.len(), 2);
    }

    #[test]
    fn parse_missing_optional_fields_defaults() {
        // Only nodes/edges arrays with bare ids — label/kind default to empty.
        let minimal = r#"{ "nodes": [ { "id": "x" } ], "edges": [] }"#;
        let g = parse_graph_json(minimal).unwrap();
        assert_eq!(g.nodes[0].id, "x");
        assert_eq!(g.nodes[0].label, "");
        assert_eq!(g.nodes[0].kind, "");
        assert!(g.edges.is_empty());
    }

    #[test]
    fn parse_rejects_non_json() {
        assert!(parse_graph_json("탐색에 실패했습니다. 파일이 없습니다.").is_err());
        assert!(parse_graph_json("").is_err());
    }

    #[test]
    fn parse_rejects_wrong_shape() {
        // Valid JSON but `nodes` is a string, not an array → typed parse fails.
        assert!(parse_graph_json(r#"{ "nodes": "oops" }"#).is_err());
    }

    #[test]
    fn save_writes_under_project_key_and_returns_path() {
        let root = temp_root("save");
        let project = "/home/x/some-proj";
        let g = parse_graph_json(SAMPLE).unwrap();
        let path = save_graph(&root, project, &g).unwrap();

        // Path = <canonical root>/<project_key>/graph/graph.json.
        let key = project_key(project);
        assert!(
            path.ends_with(PathBuf::from(&key).join("graph").join("graph.json")),
            "unexpected path: {}",
            path.display()
        );
        assert!(path.is_file());
        // Round-trips as a Graph.
        let back: Graph =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.nodes.len(), 2);
        assert_eq!(back.edges[0].from, "a");
        // Landed under the canonical root (containment holds).
        let root_c = fs::canonicalize(&root).unwrap();
        assert!(path.starts_with(&root_c));
        // No temp leftovers.
        let graph_dir = path.parent().unwrap();
        let leftovers: Vec<_> = fs::read_dir(graph_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".graph.json.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file not cleaned up");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_is_idempotent_overwrite() {
        let root = temp_root("idem");
        let project = "/home/x/proj";
        let g = parse_graph_json(SAMPLE).unwrap();
        let p1 = save_graph(&root, project, &g).unwrap();
        let p2 = save_graph(&root, project, &g).unwrap();
        assert_eq!(p1, p2, "same project → same path");
        // Exactly one graph.json (temp files renamed away).
        let entries: Vec<_> = fs::read_dir(p2.parent().unwrap()).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_contained_rejects_outside_path() {
        let root = temp_root("contain");
        let root_c = fs::canonicalize(&root).unwrap();
        // A sibling path that shares no prefix with root is rejected.
        let outside = std::env::temp_dir().join("definitely-not-under-root");
        assert!(ensure_contained(&root_c, &outside).is_err());
        // A path inside is accepted.
        let inside = root_c.join("proj-key").join("graph");
        assert!(ensure_contained(&root_c, &inside).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn format_epoch_utc_known_values() {
        assert_eq!(format_epoch_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_epoch_utc(86_400), "1970-01-02T00:00:00Z");
        // The well-known Unix billennium.
        assert_eq!(format_epoch_utc(1_000_000_000), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn now_iso8601_is_well_formed() {
        let now = now_iso8601();
        assert_eq!(now.len(), 20, "YYYY-MM-DDThh:mm:ssZ");
        assert!(now.ends_with('Z'));
        assert!(now.starts_with("20"), "sometime this century: {now}");
    }
}
