// Mirrors the serde types exposed by the Rust `core` crate.

export type ProjectType =
  | "Rust"
  | "Java"
  | "Kotlin"
  | "Python"
  | "React"
  | "JavaScript"
  | "Vue"
  | "Unknown";

/** One entry in a directory listing (from the `read_dir` command). */
export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  project_types: ProjectType[];
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
  project_types: ProjectType[];
  tree_state: TreeState;
  /**
   * Opaque dockview layout JSON for this project's main area. Owned by the
   * frontend (dockview serialization); the backend stores it untyped. Absent
   * for projects that have never arranged their main area.
   */
  layout?: unknown;
}

/** Full persisted workspace state (round-trips through Rust). */
export interface WorkspaceState {
  open_projects: Project[];
  active_project: string | null;
}
