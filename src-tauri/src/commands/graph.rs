// ---- Project dependency graph (generate → cache → open viewer) ----
//
// The command layer over `core_lib::graph`: expose graph generation (a one-shot
// Opus run, so blocking + off the webview thread), a cache probe (is there
// already a graph.json for this project?), and a confined open for the rendered
// HTML viewer. Generation writes under the archive root — the same per-project
// layout as the session archive (`<archive_root>/<project_key>/graph/`), so the
// two features share one root and one project key.
//
// Error/containment policy mirrors archive.rs: user-safe `AppError` messages
// (kind only, never the offending path), and any path that opens must be
// canonicalized-contained under the archive root.

use std::path::{Path, PathBuf};

use core_lib::claude_cli::ClaudeOpts;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::AppError;

/// Where a freshly generated graph landed, for the UI to open.
#[derive(Clone, Serialize)]
pub struct GraphPaths {
    pub json_path: String,
    pub html_path: String,
}

/// Cache metadata for an already-generated graph, so the UI can decide whether
/// to reuse it or regenerate. `None` from [`graph_list`] means "no cached graph".
#[derive(Serialize)]
pub struct GraphInfo {
    pub json_path: String,
    /// The rendered viewer, when it exists alongside the JSON.
    pub html_path: Option<String>,
    /// The graph's own generation timestamp (UTC ISO-8601), read from graph.json.
    pub generated_at: String,
    pub nodes: usize,
    pub edges: usize,
}

/// Emitted once generation finishes so an open project view can refresh (task-04
/// listens). Carries the project it was generated for + where it landed.
#[derive(Clone, Serialize)]
struct GraphGenerated {
    project: String,
    json_path: String,
    html_path: String,
}

/// The graph-generation model/effort: workspace settings when set, else the app
/// default **opus + xhigh** — mirrors `archive::extraction_opts`, but reads the
/// independent `graph_model` / `graph_effort` preferences. `add_dirs` is left
/// empty here; [`core_lib::graph::generate_graph`] adds the target project itself.
fn graph_opts(app: &AppHandle) -> ClaudeOpts {
    let ws = super::load_state(app.clone());
    ClaudeOpts {
        model: Some(ws.graph_model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "opus".into())),
        effort: Some(ws.graph_effort.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "xhigh".into())),
        ..Default::default()
    }
}

/// Generate a dependency graph for `project_path` and persist JSON + HTML under
/// the archive root. The Opus exploration is up to 3 minutes, so the whole
/// generate-and-save runs on the blocking pool — the webview must stay
/// responsive (archive.rs `spawn_blocking` pattern, archive.rs:113). cwd
/// handling (fixed `/tmp` + `--add-dir`) is owned by the core layer; this
/// command never touches cwd.
#[tauri::command]
pub async fn graph_generate(app: AppHandle, project_path: String) -> Result<GraphPaths, AppError> {
    let root = super::archive::archive_root(&app)?;
    let opts = graph_opts(&app);
    let project = project_path.clone();
    let (json, html) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, PathBuf), String> {
        let graph = core_lib::graph::generate_graph(&project_path, &opts)?;
        core_lib::graph::save_graph_all(&root, &project_path, &graph)
    })
    .await
    .map_err(|_| AppError::new("그래프 생성 작업을 실행하지 못했습니다"))?
    .map_err(AppError::new)?;

    let result = GraphPaths {
        json_path: json.to_string_lossy().to_string(),
        html_path: html.to_string_lossy().to_string(),
    };
    // Best-effort refresh signal — a failed emit never fails a completed generate.
    let _ = app.emit(
        "graph-generated",
        GraphGenerated {
            project,
            json_path: result.json_path.clone(),
            html_path: result.html_path.clone(),
        },
    );
    Ok(result)
}

/// Probe the cached graph for `project_path` (the "없으면 생성" decision in
/// task-04). Returns `None` when no readable graph.json exists — a missing file
/// *or* a corrupt one both mean "regenerate", so a corrupt cache is not an error.
#[tauri::command]
pub fn graph_list(app: AppHandle, project_path: String) -> Result<Option<GraphInfo>, AppError> {
    let root = super::archive::archive_root(&app)?;
    Ok(read_graph_info(&root, &project_path))
}

/// Read the cached graph info under `root` for `project_path`, or `None` if the
/// graph.json is absent/unreadable/unparseable. Pure (no `AppHandle`) so the
/// probe logic is unit-testable; the command is a thin wrapper resolving `root`.
fn read_graph_info(root: &Path, project_path: &str) -> Option<GraphInfo> {
    let dir = root
        .join(core_lib::history::project_key(project_path))
        .join("graph");
    let json_path = dir.join("graph.json");
    let text = std::fs::read_to_string(&json_path).ok()?;
    let graph: core_lib::graph::Graph = serde_json::from_str(&text).ok()?;
    let html_path = dir.join("graph.html");
    Some(GraphInfo {
        json_path: json_path.to_string_lossy().to_string(),
        html_path: html_path
            .is_file()
            .then(|| html_path.to_string_lossy().to_string()),
        generated_at: graph.generated_at,
        nodes: graph.nodes.len(),
        edges: graph.edges.len(),
    })
}

/// Open a generated graph artifact (graph.html) with the system handler —
/// confined to the archive root by a canonicalized containment check, so a
/// buggy/compromised renderer can't turn this into an arbitrary-file opener
/// (archive.rs `archive_open_path` pattern, archive.rs:384).
#[tauri::command]
pub fn graph_open_path(app: AppHandle, path: String) -> Result<(), AppError> {
    let root = super::archive::archive_root(&app)?;
    let target = contained_target(&root, &path)?;
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|_| AppError::new("시스템 뷰어를 열 수 없습니다"))
}

/// Canonicalize `path` and confirm it lives under `root` (also canonicalized).
/// Pure (no `AppHandle`, no spawn) so the containment gate is unit-testable
/// independently of the actual `xdg-open`.
fn contained_target(root: &Path, path: &str) -> Result<PathBuf, AppError> {
    let root_c = std::fs::canonicalize(root)
        .map_err(|_| AppError::new("아카이브 폴더를 확인할 수 없습니다"))?;
    let target = std::fs::canonicalize(path)
        .map_err(|_| AppError::new("경로를 확인할 수 없습니다"))?;
    if !target.starts_with(&root_c) {
        return Err(AppError::new("아카이브 밖 경로는 열 수 없습니다"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "mt-graphcmd-{}-{}-{tag}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_graph_info_none_when_absent() {
        let root = temp_root("absent");
        assert!(read_graph_info(&root, "/home/x/never-generated").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_graph_info_some_after_save() {
        let root = temp_root("present");
        let project = "/home/x/some-proj";
        // Seed a cached graph via the core writer (same project_key + layout the
        // command reads back).
        let graph = core_lib::graph::Graph {
            schema_version: 1,
            project: project.into(),
            generated_at: "2026-07-20T00:00:00Z".into(),
            nodes: vec![core_lib::graph::Node {
                id: "a".into(),
                label: "A".into(),
                kind: "module".into(),
                path: None,
            }],
            edges: vec![],
        };
        core_lib::graph::save_graph_all(&root, project, &graph).unwrap();

        // The canonical root is what read_graph_info must be given (save_graph_all
        // canonicalizes internally); pass the canonical form to match the on-disk
        // project_key folder.
        let root_c = std::fs::canonicalize(&root).unwrap();
        let info = read_graph_info(&root_c, project).expect("cached graph found");
        assert!(info.json_path.ends_with("graph.json"));
        assert!(info.html_path.is_some(), "html rendered alongside json");
        assert_eq!(info.generated_at, "2026-07-20T00:00:00Z");
        assert_eq!(info.nodes, 1);
        assert_eq!(info.edges, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_graph_info_none_when_corrupt() {
        let root = temp_root("corrupt");
        let project = "/home/x/corrupt-proj";
        let dir = root
            .join(core_lib::history::project_key(project))
            .join("graph");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("graph.json"), b"{ not valid json ]]]").unwrap();
        // A corrupt cache reads as "no usable graph" → regenerate, not an error.
        assert!(read_graph_info(&root, project).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn contained_target_rejects_outside_root() {
        let root = temp_root("contain");
        // A real file outside the root is rejected even though it exists.
        let outside = temp_root("outside").join("file.html");
        std::fs::write(&outside, b"x").unwrap();
        assert!(contained_target(&root, &outside.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn contained_target_accepts_inside_root() {
        let root = temp_root("inside");
        let inside = root.join("proj-key").join("graph");
        std::fs::create_dir_all(&inside).unwrap();
        let file = inside.join("graph.html");
        std::fs::write(&file, b"<!doctype html>").unwrap();
        let got = contained_target(&root, &file.to_string_lossy()).expect("inside root accepted");
        assert!(got.ends_with("graph.html"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn contained_target_missing_path_errors() {
        let root = temp_root("missing");
        let missing = root.join("nope").join("graph.html");
        assert!(contained_target(&root, &missing.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
