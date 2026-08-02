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
/// empty here; [`core_lib::graph::generate_project_graph`] adds the target project
/// and every sub-project root itself.
fn graph_opts(app: &AppHandle) -> ClaudeOpts {
    let ws = super::files::load_state(app.clone());
    ClaudeOpts {
        model: Some(ws.graph_model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "opus".into())),
        effort: Some(ws.graph_effort.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "xhigh".into())),
        ..Default::default()
    }
}

/// Canonical project identity for the graph feature — resolves symlinks / `.` /
/// trailing-slash aliases so the write side ([`graph_generate`]) and the read side
/// ([`graph_list`]) derive the **same** `project_key`, and so that key matches the
/// session archive's (`archive_session` canonicalizes identically, archive.rs:102).
/// Also keeps the core generator's prompt path and `--add-dir` grants consistent
/// (both then see the canonical path). Falls back to the raw path when it can't be
/// resolved (e.g. the project isn't on disk).
fn canonical_project(project_path: &str) -> String {
    core_lib::pathguard::canonical_key(project_path) // P4 — alias 접기 계약 단일 출처
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
    // Emit the original path to the frontend (its listener matches `activeProject`,
    // the raw store value), but drive generation/persistence off the canonical path
    // so the project_key is stable across symlink/`.` aliases and matches graph_list.
    let project = project_path.clone();
    let canon = canonical_project(&project_path);
    let (json, html) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, PathBuf), String> {
        let graph = core_lib::graph::generate_project_graph(&canon, &opts)?;
        core_lib::graph::save_graph_all(&root, &canon, &graph)
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
    // Same canonical key as graph_generate wrote under (read/write must agree).
    Ok(read_graph_info(&root, &canonical_project(&project_path)))
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

/// One `.claude`-marked folder under a project (task-07): its absolute path, the
/// project-relative display path, and whether a graph is already cached for it.
#[derive(Serialize)]
pub struct MarkedFolder {
    pub path: String,
    /// Path relative to the project root (`.` for the project root itself).
    pub rel: String,
    /// Whether a cached graph.json already exists for this folder (same cache
    /// probe as [`graph_list`]) — lets the UI show 생성 vs 열기.
    pub has_graph: bool,
}

/// List the folders under `project_path` the user opted into graphing by placing
/// a `.claude` marker directory (task-07). Each folder can then be generated /
/// opened via the existing `graph_generate` / `graph_open_path` commands by
/// passing its `path` — no per-folder command is needed. Cache probing reuses the
/// same canonical key as [`graph_generate`] writes under, so `has_graph` agrees
/// with what a later generate/list would find.
#[tauri::command]
pub fn graph_marked_folders(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<MarkedFolder>, AppError> {
    let root = super::archive::archive_root(&app)?;
    // Scan from the canonical project root so the folder paths (and their derived
    // project_keys) match what graph_generate/graph_list use.
    Ok(collect_marked_folders(&root, &canonical_project(&project_path)))
}

/// Build the [`MarkedFolder`] list for the canonical project root `canon` under
/// archive `root`. Pure (no `AppHandle`) so the rel/has_graph mapping is
/// unit-testable; the command is a thin wrapper resolving `root`/`canon`.
fn collect_marked_folders(root: &Path, canon: &str) -> Vec<MarkedFolder> {
    let base = Path::new(canon);
    core_lib::graph::find_marked_folders(canon)
        .into_iter()
        .map(|p| {
            let rel = match p.strip_prefix(base) {
                Ok(r) if r.as_os_str().is_empty() => ".".to_string(),
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => p.to_string_lossy().to_string(),
            };
            let path = p.to_string_lossy().to_string();
            // `find_marked_folders` returns paths under the canonical base, so they
            // are already canonical; canonical_project is idempotent here and keeps
            // the key identical to a subsequent graph_generate on this path.
            let has_graph = read_graph_info(root, &canonical_project(&path)).is_some();
            MarkedFolder { path, rel, has_graph }
        })
        .collect()
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
    // 봉쇄 알고리즘은 core::pathguard 단일 출처(P4) — 문구만 도메인 소유.
    use core_lib::pathguard::ContainErr;
    core_lib::pathguard::contained_existing(root, path).map_err(|e| {
        AppError::new(match e {
            ContainErr::Root => "아카이브 폴더를 확인할 수 없습니다",
            ContainErr::Path => "경로를 확인할 수 없습니다",
            ContainErr::Outside => "아카이브 밖 경로는 열 수 없습니다",
        })
    })
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
                group: None,
            }],
            edges: vec![],
            notes: vec![],
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
    fn canonical_project_falls_back_to_raw_when_absent() {
        // A not-yet-on-disk path can't be canonicalized → raw passthrough (so a
        // never-generated project still yields a stable, if uncanonical, key).
        let missing = "/nonexistent/graph-canon-xyz-123";
        assert_eq!(canonical_project(missing), missing);
    }

    #[test]
    fn canonical_project_resolves_existing_path() {
        let dir = temp_root("canon");
        let got = canonical_project(&dir.to_string_lossy());
        let expected = std::fs::canonicalize(&dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(got, expected, "existing path resolves to its canonical form");
        let _ = std::fs::remove_dir_all(&dir);
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
    fn collect_marked_folders_maps_rel_and_has_graph() {
        // A project tree with two marked folders; one already has a cached graph.
        let proj = temp_root("marked-proj");
        let root = temp_root("marked-archive");
        let canon = std::fs::canonicalize(&proj).unwrap().to_string_lossy().to_string();

        std::fs::create_dir_all(Path::new(&canon).join("svc-a").join(".claude")).unwrap();
        std::fs::create_dir_all(Path::new(&canon).join("svc-b").join(".claude")).unwrap();

        // Seed a cached graph for svc-a only (same writer/key the command reads).
        let svc_a = Path::new(&canon).join("svc-a").to_string_lossy().to_string();
        let graph = core_lib::graph::Graph {
            schema_version: 1,
            project: svc_a.clone(),
            generated_at: "2026-07-20T00:00:00Z".into(),
            nodes: vec![],
            edges: vec![],
            notes: vec![],
        };
        let root_c = std::fs::canonicalize(&root).unwrap();
        core_lib::graph::save_graph_all(&root_c, &svc_a, &graph).unwrap();

        let got = collect_marked_folders(&root_c, &canon);
        assert_eq!(got.len(), 2, "both marked folders listed");
        // Sorted by absolute path → svc-a before svc-b.
        assert_eq!(got[0].rel, "svc-a");
        assert!(got[0].has_graph, "svc-a has a cached graph");
        assert_eq!(got[1].rel, "svc-b");
        assert!(!got[1].has_graph, "svc-b has no cached graph yet");

        let _ = std::fs::remove_dir_all(&proj);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_marked_folders_root_marker_rel_is_dot() {
        let proj = temp_root("marked-root");
        let root = temp_root("marked-root-archive");
        let canon = std::fs::canonicalize(&proj).unwrap().to_string_lossy().to_string();
        std::fs::create_dir_all(Path::new(&canon).join(".claude")).unwrap();
        let got = collect_marked_folders(&root, &canon);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].rel, ".", "a marked project root shows rel '.'");
        let _ = std::fs::remove_dir_all(&proj);
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
