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

/** A file that matched a file-name search (`search_files` command). */
export interface FileHit {
  /** Absolute path, used to open the file. */
  path: string;
  /** Path relative to the search root, for display. */
  rel: string;
}

/** One matching line from a content search (`search_content` command). */
export interface ContentHit {
  path: string;
  rel: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line, trimmed and length-capped. */
  text: string;
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

/** A saved SSH connection — non-secret metadata only. Passwords / key
 * passphrases live in the OS keychain (keyed by `id`), never here. Mirrors
 * `core::persist::SshConnection`. */
export interface SshConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_kind: "password" | "publickey" | "agent";
  key_path?: string | null;
  has_stored_secret?: boolean;
}

/** Full persisted workspace state (round-trips through Rust). */
export interface WorkspaceState {
  open_projects: Project[];
  active_project: string | null;
  saved_connections?: SshConnection[];
}

/** PTY output event pushed from Rust (`*_output` listen) — incremental bytes. */
export interface TerminalOutputEvent {
  session_id: number;
  seq: number;
  data: number[];
}

/** Snapshot of a PTY's scrollback on attach (`*_snapshot`) — full bytes + seq. */
export interface SnapshotResult {
  data: number[];
  last_seq: number;
}
