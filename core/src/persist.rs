//! Workspace state persistence (JSON).
//!
//! Invariant: loading is *never* fatal. A missing or corrupt state file yields
//! [`WorkspaceState::default`] rather than an error or panic, so the app can
//! always start.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

use crate::project_type::ProjectType;

/// Per-project folder-tree UI state that must survive restarts.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TreeState {
    /// Absolute paths of directories the user has expanded, for this project.
    #[serde(default)]
    pub expanded: Vec<String>,
}

/// A single open project (one tab in the shell).
///
/// `Eq` is intentionally *not* derived: `layout` holds an opaque
/// [`serde_json::Value`] (which may contain floats and therefore is `PartialEq`
/// but not `Eq`). Equality is only needed for tests, where `PartialEq` suffices.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Project {
    /// Absolute path to the project root folder.
    pub path: String,
    /// Display name (typically the folder's file name).
    pub name: String,
    /// Detected project types (badges). A folder may match several ecosystems
    /// at once, so this is a (possibly empty) list rather than a single value.
    #[serde(default)]
    pub project_types: Vec<ProjectType>,
    /// Per-project tree state — kept isolated so one project's expansion does
    /// not affect another's.
    #[serde(default)]
    pub tree_state: TreeState,
    /// Opaque dockview layout JSON for this project's main area, persisted so
    /// each project restores its own panel arrangement. Stored as an untyped
    /// [`serde_json::Value`] because the shape is owned by the frontend
    /// (`dockview` serialization), not this crate. `None` for older saved
    /// state that predates the docking layout.
    #[serde(default)]
    pub layout: Option<serde_json::Value>,
}

/// The full persisted workspace: open projects + which one is active.
///
/// `Eq` is not derived because it contains [`Project`], which is `PartialEq`
/// only (see its docs).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct WorkspaceState {
    #[serde(default)]
    pub open_projects: Vec<Project>,
    /// Path of the active project, if any.
    #[serde(default)]
    pub active_project: Option<String>,
}

/// Serialize `state` to `path` as pretty JSON, creating parent dirs as needed.
///
/// Returns an [`io::Error`] (never panics) on any I/O or serialization failure.
pub fn save_state<P: AsRef<Path>>(state: &WorkspaceState, path: P) -> io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// Load workspace state from `path`.
///
/// A missing file, an unreadable file, or malformed JSON all resolve to
/// [`WorkspaceState::default`]. This function does not return an error and does
/// not panic.
pub fn load_state<P: AsRef<Path>>(path: P) -> WorkspaceState {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => WorkspaceState::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_path(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("mt_persist_{tag}_{nanos}_{n}"));
        fs::create_dir_all(&p).unwrap();
        p.push("workspace.json");
        p
    }

    fn sample_state() -> WorkspaceState {
        WorkspaceState {
            open_projects: vec![
                Project {
                    path: "/home/u/proj-a".into(),
                    name: "proj-a".into(),
                    project_types: vec![ProjectType::Rust, ProjectType::React],
                    tree_state: TreeState {
                        expanded: vec!["/home/u/proj-a/src".into()],
                    },
                    layout: None,
                },
                Project {
                    path: "/home/u/proj-b".into(),
                    name: "proj-b".into(),
                    project_types: vec![ProjectType::Python],
                    tree_state: TreeState { expanded: vec![] },
                    layout: None,
                },
            ],
            active_project: Some("/home/u/proj-b".into()),
        }
    }

    #[test]
    fn round_trip_is_lossless() {
        let path = temp_path("roundtrip");
        let state = sample_state();
        save_state(&state, &path).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, state);
    }

    #[test]
    fn missing_file_yields_default() {
        let path = temp_path("missing");
        // Note: temp_path creates the parent dir but not the file itself.
        assert!(!path.exists());
        let loaded = load_state(&path);
        assert_eq!(loaded, WorkspaceState::default());
    }

    #[test]
    fn corrupt_file_yields_default() {
        let path = temp_path("corrupt");
        fs::write(&path, b"{ this is not valid json ]]]").unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, WorkspaceState::default());
    }

    #[test]
    fn empty_file_yields_default() {
        let path = temp_path("empty");
        fs::write(&path, b"").unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, WorkspaceState::default());
    }

    #[test]
    fn default_state_is_empty() {
        let s = WorkspaceState::default();
        assert!(s.open_projects.is_empty());
        assert_eq!(s.active_project, None);
    }

    #[test]
    fn layout_round_trips_losslessly() {
        let path = temp_path("layout_roundtrip");
        let layout = serde_json::json!({
            "grid": { "root": { "type": "branch", "data": [] }, "width": 800, "height": 600 },
            "panels": { "terminal-1": { "id": "terminal-1", "title": "Terminal 1" } },
            "ratio": 0.5,
        });
        let state = WorkspaceState {
            open_projects: vec![Project {
                path: "/home/u/proj-a".into(),
                name: "proj-a".into(),
                project_types: vec![ProjectType::Rust],
                tree_state: TreeState::default(),
                layout: Some(layout.clone()),
            }],
            active_project: Some("/home/u/proj-a".into()),
        };
        save_state(&state, &path).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded, state);
        assert_eq!(loaded.open_projects[0].layout, Some(layout));
    }

    #[test]
    fn old_state_without_layout_key_loads_as_none() {
        let path = temp_path("layout_migration");
        // A pre-phase-02a saved project: no `layout` key at all.
        let json = r#"{
            "open_projects": [
                {
                    "path": "/home/u/proj-a",
                    "name": "proj-a",
                    "project_types": ["Rust"],
                    "tree_state": { "expanded": [] }
                }
            ],
            "active_project": "/home/u/proj-a"
        }"#;
        fs::write(&path, json).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded.open_projects.len(), 1);
        assert_eq!(loaded.open_projects[0].layout, None);
    }

    #[test]
    fn save_creates_missing_parent_dirs() {
        let mut path = temp_path("nested");
        path.pop(); // back to the temp dir
        path.push("a");
        path.push("b");
        path.push("workspace.json");
        assert!(!path.exists());
        save_state(&sample_state(), &path).unwrap();
        assert!(path.exists());
        assert_eq!(load_state(&path), sample_state());
    }
}
