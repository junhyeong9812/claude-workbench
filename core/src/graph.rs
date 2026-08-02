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
use crate::git::{git_roots, GitRoot};
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
    /// The sub-project (git repo) this node belongs to in a hierarchical graph —
    /// an absolute path or basename, or `"<top>"` for common/top-level nodes.
    /// Absent for a single-project graph (the degenerate case renders exactly as
    /// before). `#[serde(default, skip_serializing_if)]` keeps older graph.json
    /// (no `group`) parsing unchanged and omits the field when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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
    /// Human-readable advisories about this graph's completeness — e.g. a note
    /// that the sub-project list was capped (see [`MAX_GRAPH_ROOTS`]). Set
    /// authoritatively by the generators (never trusted from model output); the
    /// viewer surfaces them in a banner so a truncated graph is never mistaken
    /// for a complete one. `#[serde(default, skip_serializing_if)]` keeps older
    /// graph.json (no `notes`) parsing unchanged and omits the field when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
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

/// Extract the **first balanced** JSON object substring (from the first `{` to
/// the `}` that closes it) — a fallback when the model wraps the object in a code
/// fence or stray prose despite the prompt. Counts brace depth so trailing prose
/// with its own braces (e.g. `{…valid…}\n필드는 {from,to} 형식`) can't extend the
/// range into a second, unparseable object. Braces and quotes *inside* string
/// literals are ignored (tracking `"` open/close and `\` escapes), so a label like
/// `"a{b}c"` doesn't skew the count. Char-boundary safe: the structural bytes
/// (`{}"\`) are all ASCII, and `char_indices` skips over any multibyte chars.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (off, ch) in s[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    // `off` is the byte offset within `s[start..]`; `}` is ASCII,
                    // so `start + off` is a valid inclusive char boundary.
                    return Some(&s[start..=start + off]);
                }
            }
            _ => {}
        }
    }
    None
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
    // Single-project path is never truncated — authoritative empty (don't trust
    // any `notes` the model may have emitted).
    graph.notes = Vec::new();
    Ok(graph)
}

/// Upper bound on sub-project roots fed to one hierarchical prompt. `git_roots`
/// already caps discovery (depth/count), but a large monorepo can still surface
/// dozens of nested repos; listing hundreds would bloat the prompt. Kept generous
/// — hitting it is logged (never silent) and the roots are sorted so the project's
/// own root (shortest path) always survives truncation.
const MAX_GRAPH_ROOTS: usize = 50;

/// Keep only the sub-project roots **at or under** `project_path`, discarding any
/// git root that is an *ancestor* of it. `git_roots` includes the enclosing
/// work-tree root (via `--show-toplevel`), which for a subdirectory points at a
/// parent repo *above* the project — the hierarchical graph is "this project and
/// below", so that parent-direction root is dropped. Pure (no fs) so the filter is
/// unit-testable; `project_path` and each root path should be canonicalized by the
/// caller so the component-wise `starts_with` prefix test is sound.
fn subproject_roots(project_path: &str, roots: Vec<GitRoot>) -> Vec<GitRoot> {
    let base = Path::new(project_path);
    roots
        .into_iter()
        // `starts_with` is component-wise, so it is true for the project itself and
        // for any nested repo, and false for a parent (and never false-matches a
        // sibling like `/foo-bar` against `/foo`).
        .filter(|r| Path::new(&r.path).starts_with(base))
        .collect()
}

/// The prompt for a **hierarchical** graph spanning `project_path` and the listed
/// sub-project git roots. The model is told the exact sub-project paths and must
/// tag every node with a `group` (the owning sub-project's path/basename, or
/// `"<top>"` for common nodes) so the viewer can cluster by sub-project.
pub fn project_graph_prompt(project_path: &str, roots: &[GitRoot], truncated: bool) -> String {
    let list = roots
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let branch = if r.branch.is_empty() { "?" } else { &r.branch };
            format!("  {}. `{}` (branch: {branch})", i + 1, r.path)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let trunc_note = if truncated {
        format!(
            "\n(주의: 하위 저장소가 상한 {MAX_GRAPH_ROOTS}개를 초과해 목록을 잘랐다 — 위에 나열된 것만 다뤄라.)\n"
        )
    } else {
        String::new()
    };
    format!(
        "절대경로 `{project_path}` 아래에는 아래 하위 프로젝트(각각 별도 git 저장소)들이 있다:\n\
{list}\n{trunc_note}\n\
이 하위 프로젝트들을 너의 도구(Read·Grep·Glob·Bash 등)로 직접 탐색해, 전체를 아우르는 **하나의 통합** \
의존성 그래프를 만들어라. 각 노드에는 그 노드가 속한 하위 프로젝트를 가리키는 `group` 을 **반드시** 표기하라 — \
group 값은 위 목록의 하위 프로젝트 절대경로(또는 그 basename)로 통일하고, 특정 하위 프로젝트에 속하지 않는 \
최상위·공통 노드는 group 을 \"<top>\" 으로 둔다.\n\n\
출력은 아래 JSON 스키마를 정확히 따르는 JSON 객체 **하나만** 낼 것 — 코드펜스(```)·설명·머리말·꼬리말 \
전부 금지, 순수 JSON 만:\n\
{{\n\
  \"project\": \"<프로젝트 절대경로>\",\n\
  \"generated_at\": \"\",\n\
  \"nodes\": [ {{ \"id\": \"<고유 id>\", \"label\": \"<표시 이름>\", \"kind\": \"<module|file|package|external 중 하나>\", \"path\": \"<프로젝트 상대경로, 없으면 생략>\", \"group\": \"<소속 하위 프로젝트 경로 또는 basename, 공통이면 <top>>\" }} ],\n\
  \"edges\": [ {{ \"from\": \"<노드 id>\", \"to\": \"<노드 id>\", \"kind\": \"<의존 종류, 선택>\" }} ]\n\
}}\n\n\
규칙: 노드마다 id 는 고유. edges 의 from/to 는 반드시 nodes 의 id 중 하나여야 한다. \
실제 코드에서 확인한 의존만 넣을 것(추측 금지). 하위 프로젝트 경계를 넘는 의존이 있으면 그 엣지도 포함하라. \
generated_at 은 빈 문자열로 두라(호출자가 채운다)."
    )
}

/// Generate a **hierarchical** dependency graph for `project_path`: one graph that
/// unifies the project and every nested git repo under it, each node tagged with
/// its owning sub-project (`Node::group`) so the viewer can cluster them.
///
/// Discovers sub-projects with [`git_roots`] filtered to those at/under the project
/// ([`subproject_roots`] drops the parent-direction root). With ≤1 root (a leaf or
/// single repo, the common case) it degrades to the plain single-project
/// [`generate_graph`] path — no `group`, byte-identical output — so only genuine
/// multi-repo trees pay for grouping. Like `generate_graph`, cwd stays fixed to the
/// `/tmp` scratch dir (backfill-safe); every root is granted via `--add-dir`.
pub fn generate_project_graph(project_path: &str, opts: &ClaudeOpts) -> Result<Graph, String> {
    // Canonicalize so git's canonicalized `--show-toplevel` output and our prefix
    // filter agree; fall back to the raw path if it can't be resolved.
    let canon = crate::pathguard::canonical_key(project_path);
    let mut roots = subproject_roots(&canon, git_roots(&canon));

    // ≤1 root → nothing to cluster: reuse the single-project path verbatim.
    if roots.len() <= 1 {
        return generate_graph(project_path, opts);
    }

    // Cap the prompt's root list (never silently — log the truncation). Roots are
    // sorted lexicographically, so the project's own (shortest) root sorts first
    // and always survives the truncate.
    let total_roots = roots.len();
    let truncated = total_roots > MAX_GRAPH_ROOTS;
    if truncated {
        eprintln!(
            "graph: {total_roots} sub-project roots under {canon}; capping the prompt to {MAX_GRAPH_ROOTS} (truncated)"
        );
        roots.truncate(MAX_GRAPH_ROOTS);
    }

    let workdir = extraction_workdir();
    let mut opts = opts.clone();
    // Grant read access to the project root and every sub-project root.
    opts.add_dirs.push(canon.clone());
    for r in &roots {
        if r.path != canon {
            opts.add_dirs.push(r.path.clone());
        }
    }
    let raw = run_claude_p(
        &workdir.to_string_lossy(),
        &project_graph_prompt(project_path, &roots, truncated),
        Duration::from_secs(300),
        &opts,
    )?;
    let mut graph = parse_graph_json(&raw)?;
    graph.schema_version = SCHEMA_VERSION;
    graph.project = project_path.to_string();
    graph.generated_at = now_iso8601();
    // Surface truncation to the viewer (authoritative) — a capped graph is
    // incomplete, and stderr alone is invisible to the GUI user (F1: no silent
    // failure). Empty otherwise (don't trust any model-emitted `notes`).
    graph.notes = if truncated {
        vec![format!(
            "하위 저장소 {total_roots}개 중 상한 {MAX_GRAPH_ROOTS}개만 포함 — 그래프가 불완전합니다"
        )]
    } else {
        Vec::new()
    };
    Ok(graph)
}

// ---- `.claude` marker discovery (task-07: per-folder graphs) ----

/// Marker directory name: a folder is a graph target iff it directly contains a
/// `.claude` directory. The user creates these by hand to opt a folder in.
const MARKER_DIR: &str = ".claude";
/// Bounded-scan caps for [`find_marked_folders`], mirroring `git::git_roots`
/// (worktree.rs): depth, result count, and total directories visited. A
/// pathological tree can never hang the caller, and hitting a cap is logged
/// (never silent — F1).
const MARKER_MAX_DEPTH: usize = 8;
const MARKER_MAX_COUNT: usize = 200;
const MARKER_MAX_VISITED_DIRS: usize = 20_000;
/// Directory names pruned during the marker scan — VCS internals and heavy
/// build/dependency trees that never hold a hand-placed marker we'd want.
/// `.claude` itself is pruned from *descent* (it is the marker, detected on its
/// parent — we never look for markers inside it). Kept in sync with
/// `git::PRUNE_DIRS` (the reference scanner).
const MARKER_PRUNE_DIRS: &[&str] = &[
    ".claude", ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "out", ".next",
    "vendor", ".cache", "coverage", "__pycache__", ".venv", "venv", ".tox", ".gradle",
];

/// Find every folder at or under `project_path` that directly contains a
/// `.claude` marker directory — the set of user-opted graph targets. The project
/// root itself is included when it is marked.
///
/// Bounded like `git::git_roots`: it prunes VCS/build dirs, **never follows
/// symlinks** (so it can't escape the tree or loop), and stops at depth / count /
/// visited-dir caps; hitting a cap is logged to stderr (never silent). A marked
/// folder is still descended into, so nested markers are found. Results are
/// returned lexicographically sorted (deterministic).
pub fn find_marked_folders(project_path: &str) -> Vec<PathBuf> {
    let base = Path::new(project_path);
    let mut found: Vec<PathBuf> = Vec::new();
    let mut visited = 0usize;
    scan_marked_folders(base, 0, &mut found, &mut visited);
    if found.len() >= MARKER_MAX_COUNT || visited >= MARKER_MAX_VISITED_DIRS {
        eprintln!(
            "graph: marker scan under {project_path} hit a cap ({} folders, {visited} dirs visited) — the list may be truncated",
            found.len()
        );
    }
    found.sort();
    found
}

/// Recursive worker for [`find_marked_folders`]. Checks whether `dir` itself is
/// marked (holds a `.claude` dir), records it, then descends into non-pruned real
/// subdirectories. Bounded by the same depth/count/visited caps.
fn scan_marked_folders(dir: &Path, depth: usize, found: &mut Vec<PathBuf>, visited: &mut usize) {
    if depth > MARKER_MAX_DEPTH || found.len() >= MARKER_MAX_COUNT || *visited >= MARKER_MAX_VISITED_DIRS
    {
        return;
    }
    *visited += 1;
    // `dir` is marked when it directly contains a `.claude` directory.
    if dir.join(MARKER_DIR).is_dir() {
        found.push(dir.to_path_buf());
        if found.len() >= MARKER_MAX_COUNT {
            return;
        }
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir (permissions) — skip, not fatal
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Never follow symlinks (could escape the tree or cycle); real dirs only.
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if MARKER_PRUNE_DIRS.contains(&name.as_ref()) {
            continue;
        }
        scan_marked_folders(&entry.path(), depth + 1, found, visited);
        if found.len() >= MARKER_MAX_COUNT || *visited >= MARKER_MAX_VISITED_DIRS {
            return;
        }
    }
}

/// Reject a target that does not live under `root` (both already canonicalized).
fn ensure_contained(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err("아카이브 밖 경로에는 저장할 수 없습니다".to_string())
    }
}

/// Resolve (creating as needed) the per-project `graph/` folder under
/// `archive_root` and atomically write `contents` to `file_name` inside it.
///
/// The single containment/atomic-write path shared by [`save_graph`] and
/// [`save_graph_html`]: reuses [`project_key`] for the per-project folder (same
/// key as the session archive), canonicalizes the archive root and the graph
/// dir and refuses any path that escapes the root (containment — archive.rs
/// pattern), then writes to a temp file and renames into place (atomic; a crash
/// never leaves a half file). `file_name` is a fixed literal (`graph.json` /
/// `graph.html`), never attacker-controlled, so it needs no sanitization.
fn write_graph_artifact(
    archive_root: &Path,
    project_path: &str,
    file_name: &str,
    contents: &str,
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

    let final_path = dir_c.join(file_name);
    let tmp = dir_c.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = fs::write(&tmp, contents) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("그래프를 쓸 수 없습니다: {}", e.kind()));
    }
    if let Err(e) = fs::rename(&tmp, &final_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("그래프 저장에 실패했습니다: {}", e.kind()));
    }
    Ok(final_path)
}

/// Persist `graph` as JSON at `<archive_root>/<project_key>/graph/graph.json`.
pub fn save_graph(
    archive_root: &Path,
    project_path: &str,
    graph: &Graph,
) -> Result<PathBuf, String> {
    let json =
        serde_json::to_string_pretty(graph).map_err(|_| "그래프 직렬화에 실패했습니다".to_string())?;
    write_graph_artifact(archive_root, project_path, "graph.json", &json)
}

/// Persist the self-contained HTML viewer at
/// `<archive_root>/<project_key>/graph/graph.html` (same folder as the JSON).
/// Renders via [`render_graph_html`] — no external requests, fully offline.
pub fn save_graph_html(
    archive_root: &Path,
    project_path: &str,
    graph: &Graph,
) -> Result<PathBuf, String> {
    let html = render_graph_html(graph);
    write_graph_artifact(archive_root, project_path, "graph.html", &html)
}

/// Convenience: persist both the JSON document and the HTML viewer for `graph`,
/// returning `(json_path, html_path)`. Individual `save_graph` / `save_graph_html`
/// stay public so the command layer (task-03) can compose them differently.
pub fn save_graph_all(
    archive_root: &Path,
    project_path: &str,
    graph: &Graph,
) -> Result<(PathBuf, PathBuf), String> {
    let json_path = save_graph(archive_root, project_path, graph)?;
    let html_path = save_graph_html(archive_root, project_path, graph)?;
    Ok((json_path, html_path))
}

/// Render `graph` as a **self-contained** HTML viewer string — one document with
/// inline `<style>`/`<script>` and **zero external requests** (no CDN, no remote
/// fonts, no images). Mirrors [`crate::archive::render_book_html`]: the graph is
/// embedded as JSON in [`GRAPH_TEMPLATE`]'s `__DATA__` slot with every `<`
/// escaped to `<` (valid both as JSON and as a JS string escape) so no node
/// label / path can close the `<script>` element or open a tag. The inline SVG
/// renderer assigns node/edge text via `textContent` only (never innerHTML), so
/// model-supplied strings are inert (XSS-safe).
pub fn render_graph_html(graph: &Graph) -> String {
    // 이스케이프 규칙은 core::embed 단일 출처 (P4 — archive와 공용).
    GRAPH_TEMPLATE.replace("__DATA__", &crate::embed::embed_json(graph))
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

/// The self-contained graph viewer page. Sole placeholder: `__DATA__` (the
/// `<`-escaped JSON [`Graph`]). No external requests, no innerHTML — nodes and
/// edges are drawn as inline SVG and every model string is set via `textContent`.
/// Layout is a deterministic Fruchterman–Reingold force pass (no `Math.random`),
/// so the same graph always renders the same shape.
const GRAPH_TEMPLATE: &str = include_str!("../templates/graph.html"); // P5 B-a: 외부화(바이트 동일 추출)

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
    fn parse_stops_at_first_balanced_object_ignoring_trailing_prose_braces() {
        // Valid object followed by prose that itself contains braces — the old
        // first-`{`..last-`}` grab would swallow both and fail to parse (F2).
        let raw = format!("여기 그래프입니다:\n{SAMPLE}\n참고: 필드는 {{from, to}} 형식입니다.");
        let g = parse_graph_json(&raw).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn parse_ignores_braces_inside_string_literals() {
        // A `{`/`}` inside a string value must not skew the depth counter (F2).
        let raw = r#"prefix {"nodes":[{"id":"n","label":"a{b}c"}],"edges":[]} suffix"#;
        let g = parse_graph_json(raw).unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].label, "a{b}c");
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

    // --- HTML viewer (task-02) ---

    /// The set of substrings that would betray an external request. Kept in sync
    /// with the packet's `grep -iE 'https?://|src=|cdn|@import|fonts.googleapis'`.
    fn external_ref_markers(html: &str) -> Vec<&'static str> {
        let lower = html.to_lowercase();
        ["http://", "https://", "src=", "cdn", "@import", "fonts.googleapis"]
            .into_iter()
            .filter(|m| lower.contains(m))
            .collect()
    }

    #[test]
    fn render_html_is_self_contained() {
        let g = parse_graph_json(SAMPLE).unwrap();
        let html = render_graph_html(&g);
        // Placeholder fully substituted.
        assert!(!html.contains("__DATA__"), "template placeholder left in output");
        // Zero external references (offline / CSP-independent self-containment).
        let refs = external_ref_markers(&html);
        assert!(refs.is_empty(), "unexpected external references: {refs:?}");
        // Well-formed enough: balanced script/style tags, doctype present.
        assert!(html.starts_with("<!doctype html>"));
        assert_eq!(html.matches("<script").count(), html.matches("</script>").count());
        assert_eq!(html.matches("<style").count(), html.matches("</style>").count());
        assert!(html.contains("</html>"));
    }

    #[test]
    fn render_html_embeds_graph_content() {
        let g = parse_graph_json(SAMPLE).unwrap();
        let html = render_graph_html(&g);
        // Node ids/labels and edge endpoints ride in the embedded JSON payload.
        assert!(html.contains("\"id\":\"a\""), "node id missing from payload");
        assert!(html.contains("\"label\":\"A\""), "node label missing");
        assert!(html.contains("\"kind\":\"module\""), "node kind missing");
        assert!(html.contains("src/a.rs"), "node path missing");
        assert!(html.contains("\"from\":\"a\""), "edge from missing");
        assert!(html.contains("\"to\":\"b\""), "edge to missing");
    }

    #[test]
    fn render_html_escapes_script_breakout() {
        // A hostile label must not be able to close the <script> element.
        let mut g = parse_graph_json(SAMPLE).unwrap();
        g.nodes.push(Node {
            id: "x".into(),
            label: "</script><img src=x onerror=alert(1)>".into(),
            kind: "file".into(),
            path: None,
            group: None,
        });
        let html = render_graph_html(&g);
        // The only literal </script> is the template's own closing tag.
        assert_eq!(html.matches("</script>").count(), 1, "breakout not neutralized");
        // The '<' of the payload is escaped to the JS/JSON-safe form.
        assert!(html.contains("\\u003c/script>"), "'<' not escaped in payload");
        assert!(!html.contains("<img src=x"), "raw tag leaked into document");
    }

    #[test]
    fn render_empty_graph_is_valid_html() {
        let g = Graph {
            schema_version: 1,
            project: "/p".into(),
            generated_at: "2026-07-20T00:00:00Z".into(),
            nodes: vec![],
            edges: vec![],
            notes: vec![],
        };
        let html = render_graph_html(&g);
        assert!(!html.contains("__DATA__"));
        assert!(external_ref_markers(&html).is_empty());
        assert!(html.contains("\"nodes\":[]"));
    }

    #[test]
    fn notes_serde_is_optional_and_backcompat() {
        // Pre-notes graph.json (no `notes` key) still parses → notes default empty.
        let g = parse_graph_json(SAMPLE).unwrap();
        assert!(g.notes.is_empty(), "absent notes → empty vec");
        // Empty notes are omitted on serialize (skip_serializing_if) — old readers
        // never see a new key.
        let out = serde_json::to_string(&g).unwrap();
        assert!(!out.contains("\"notes\""), "empty notes must not serialize");
        // A graph WITH notes round-trips.
        let withnotes = r#"{ "nodes": [], "edges": [], "notes": ["잘림 경고"] }"#;
        let g2 = parse_graph_json(withnotes).unwrap();
        assert_eq!(g2.notes, vec!["잘림 경고".to_string()]);
    }

    #[test]
    fn render_html_with_notes_embeds_banner_and_stays_self_contained() {
        let mut g = parse_graph_json(SAMPLE).unwrap();
        g.notes.push("하위 저장소 60개 중 상한 50개만 포함 — 그래프가 불완전합니다".into());
        let html = render_graph_html(&g);
        // The note rides in the embedded payload (drives the JS-built banner).
        assert!(html.contains("\"notes\":["), "notes serialized into payload");
        assert!(
            html.contains("상한 50개만 포함"),
            "note text present in payload"
        );
        // The banner-building code is present in the template.
        assert!(html.contains("id = \"banner\"") || html.contains("banner.id = \"banner\""),
            "banner element is built");
        // Self-containment invariant preserved (no external references).
        assert!(external_ref_markers(&html).is_empty(), "noted graph must stay offline");
        assert!(!html.contains("__DATA__"));
    }

    #[test]
    fn save_graph_html_writes_under_project_key() {
        let root = temp_root("html");
        let project = "/home/x/some-proj";
        let g = parse_graph_json(SAMPLE).unwrap();
        let path = save_graph_html(&root, project, &g).unwrap();

        let key = project_key(project);
        assert!(
            path.ends_with(PathBuf::from(&key).join("graph").join("graph.html")),
            "unexpected path: {}",
            path.display()
        );
        assert!(path.is_file());
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.starts_with("<!doctype html>"));
        assert!(external_ref_markers(&body).is_empty());
        assert!(body.contains("\"id\":\"a\""));
        // No temp leftovers.
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".graph.html.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file not cleaned up");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_graph_all_writes_both_artifacts() {
        let root = temp_root("all");
        let project = "/home/x/proj";
        let g = parse_graph_json(SAMPLE).unwrap();
        let (json_path, html_path) = save_graph_all(&root, project, &g).unwrap();
        assert!(json_path.ends_with("graph.json"));
        assert!(html_path.ends_with("graph.html"));
        assert!(json_path.is_file() && html_path.is_file());
        // Both landed in the same graph/ folder.
        assert_eq!(json_path.parent(), html_path.parent());
        let _ = fs::remove_dir_all(&root);
    }

    // --- hierarchical grouping (task-05) ---

    #[test]
    fn parse_node_group_is_optional_and_backcompat() {
        // Pre-group graph.json (no `group` key) still parses → group defaults None.
        let g = parse_graph_json(SAMPLE).unwrap();
        assert!(g.nodes.iter().all(|n| n.group.is_none()), "group absent → None");
        // And a graph WITH group round-trips into Some.
        let grouped = r#"{ "nodes": [ { "id": "a", "group": "sub-x" } ], "edges": [] }"#;
        let g2 = parse_graph_json(grouped).unwrap();
        assert_eq!(g2.nodes[0].group.as_deref(), Some("sub-x"));
        // Serializing a None group omits the key (skip_serializing_if) — no `"group"`.
        let out = serde_json::to_string(&g).unwrap();
        assert!(!out.contains("\"group\""), "None group must not serialize");
    }

    #[test]
    fn subproject_roots_keeps_self_and_descendants_drops_ancestor() {
        let mk = |p: &str| GitRoot { path: p.to_string(), branch: "main".into() };
        let roots = vec![
            mk("/home/x"),              // ancestor of the project → dropped
            mk("/home/x/proj"),         // the project itself → kept
            mk("/home/x/proj/sub-a"),   // nested repo → kept
            mk("/home/x/proj/sub-b"),   // nested repo → kept
            mk("/home/x/proj-other"),   // sibling sharing a name prefix → dropped
        ];
        let kept: Vec<String> =
            subproject_roots("/home/x/proj", roots).into_iter().map(|r| r.path).collect();
        assert_eq!(
            kept,
            vec![
                "/home/x/proj".to_string(),
                "/home/x/proj/sub-a".to_string(),
                "/home/x/proj/sub-b".to_string(),
            ],
            "only the project and its descendants survive (component-wise prefix)"
        );
    }

    #[test]
    fn project_graph_prompt_lists_roots_and_requests_group() {
        let roots = vec![
            GitRoot { path: "/p".into(), branch: "main".into() },
            GitRoot { path: "/p/sub".into(), branch: "".into() },
        ];
        let p = project_graph_prompt("/p", &roots, false);
        assert!(p.contains("/p/sub"), "sub-project path listed");
        assert!(p.contains("group"), "asks the model to tag group");
        assert!(p.contains("<top>"), "documents the top-level group sentinel");
        assert!(!p.contains("잘랐다"), "no truncation note when not truncated");
        // Truncated variant carries a visible (non-silent) note.
        let pt = project_graph_prompt("/p", &roots, true);
        assert!(pt.contains("잘랐다"), "truncation is stated in the prompt");
    }

    // --- `.claude` marker discovery (task-07) ---

    /// Build `<dir>/.claude` so `dir` reads as a marked folder.
    fn mark(dir: &Path) {
        fs::create_dir_all(dir.join(".claude")).unwrap();
    }

    #[test]
    fn find_marked_folders_detects_marked_dirs_and_ignores_unmarked() {
        let root = temp_root("markers");
        // root/a is marked; root/b is not; root/a/nested is marked (descend past a mark).
        mark(&root.join("a"));
        fs::create_dir_all(root.join("b")).unwrap();
        mark(&root.join("a").join("nested"));
        // The root itself is unmarked here.
        let got = find_marked_folders(&root.to_string_lossy());
        assert_eq!(
            got,
            vec![root.join("a"), root.join("a").join("nested")],
            "only .claude-holding folders, sorted, unmarked skipped"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn find_marked_folders_includes_root_when_marked() {
        let root = temp_root("markers-root");
        mark(&root);
        let got = find_marked_folders(&root.to_string_lossy());
        assert_eq!(got, vec![root.to_path_buf()], "a marked project root is a target");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn find_marked_folders_prunes_build_and_vcs_trees() {
        let root = temp_root("markers-prune");
        // Markers buried inside pruned dirs must NOT be discovered.
        mark(&root.join("node_modules").join("pkg"));
        mark(&root.join("target").join("debug"));
        mark(&root.join(".git").join("hooksdir"));
        // A real marker outside the pruned trees is found.
        mark(&root.join("src"));
        let got = find_marked_folders(&root.to_string_lossy());
        assert_eq!(got, vec![root.join("src")], "pruned subtrees yield no markers");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn find_marked_folders_does_not_descend_into_the_marker_dir() {
        let root = temp_root("markers-nodescend");
        // A `.claude` that itself contains a nested `.claude` must not produce a
        // second result — the marker dir is never scanned into.
        mark(&root.join("proj"));
        fs::create_dir_all(root.join("proj").join(".claude").join(".claude")).unwrap();
        let got = find_marked_folders(&root.to_string_lossy());
        assert_eq!(got, vec![root.join("proj")], "marker dir is not descended");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn find_marked_folders_empty_when_none_marked() {
        let root = temp_root("markers-empty");
        fs::create_dir_all(root.join("x").join("y")).unwrap();
        assert!(find_marked_folders(&root.to_string_lossy()).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn render_html_with_groups_shows_group_legend_and_stays_self_contained() {
        let grouped = r#"{
            "project": "/mono",
            "nodes": [
                { "id": "a", "label": "A", "kind": "module", "group": "svc-a" },
                { "id": "b", "label": "B", "kind": "module", "group": "svc-b" }
            ],
            "edges": [ { "from": "a", "to": "b" } ]
        }"#;
        let g = parse_graph_json(grouped).unwrap();
        let html = render_graph_html(&g);
        // Group values ride in the embedded payload and drive the group-colored legend.
        assert!(html.contains("\"group\":\"svc-a\""), "group in payload");
        assert!(html.contains("\"group\":\"svc-b\""), "group in payload");
        // Self-containment invariant is preserved (no external references).
        assert!(external_ref_markers(&html).is_empty(), "grouped graph must stay offline");
        assert!(!html.contains("__DATA__"));
    }
}
