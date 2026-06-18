// Mirrors the serde types exposed by the Rust `core` crate.

export type ProjectType = "Rust" | "Java" | "Kotlin" | "Python" | "Unknown";

/** One entry in a directory listing (from the `read_dir` command). */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Per-project folder-tree UI state that survives restarts. */
export interface TreeState {
  /** Absolute paths of expanded directories, scoped to one project. */
  expanded: string[];
}

/** One open project (one tab). */
export interface Project {
  path: string;
  name: string;
  project_type: ProjectType;
  tree_state: TreeState;
}

/** Full persisted workspace state (round-trips through Rust). */
export interface WorkspaceState {
  open_projects: Project[];
  active_project: string | null;
}
