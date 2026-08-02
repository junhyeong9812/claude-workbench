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
  /** Ignored by .gitignore/.ignore — shown but dimmed (VS Code style). Absent
   * for older payloads (serde default false). */
  is_ignored?: boolean;
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

/** A detected build/test toolchain (`detect_run_targets` command). */
export interface RunTarget {
  /** Tool id for the label ("cargo", "npm", "gradle", "maven", "python", "go"). */
  kind: string;
  build: string | null;
  test: string | null;
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
  /** Session-archive root override (null/absent = default app-data dir). Must
   * round-trip through persist() — dropping it here would wipe the setting. */
  archive_root?: string | null;
  /** Archive-extraction claude model (`--model`). null = 기본(opus). Must
   * round-trip through persist(). */
  archive_model?: string | null;
  /** Archive-extraction effort (`--effort`). null = 기본(xhigh). Must
   * round-trip through persist(). */
  archive_effort?: string | null;
}

/** PTY output event pushed from Rust — incremental bytes. P3: 세션별 이벤트
 * `terminal-output-{id}`(pty.ts ptyEventName)로 수신하며 `data`는 base64
 * (decodePtyData로 원시 바이트 복원 — number[] JSON 3-4배 팽창 제거). */
export interface TerminalOutputEvent {
  session_id: number;
  seq: number;
  data: string;
}

/** Snapshot of a PTY's scrollback on attach (`*_snapshot`) — full bytes
 * (base64, decodePtyData로 복원) + seq. */
export interface SnapshotResult {
  data: string;
  last_seq: number;
}

/** P6 D3: 타임라인 아이템 — 컴포넌트가 아니라 타입 모듈 소유(상태
 * 모듈(claudeStatusGlobal 등)의 컴포넌트 역의존 해소). */
export interface TimelineItem {
  turn: number;
  session_id: string;
  tool_call_id: string;
  seq: number;
  kind: string;
  title: string;
  locations: string[];
  project_label: string | null;
  /** Directory this call ran in (JSONL cwd). Differs from the session cwd when a
   * subagent works in an isolation worktree — used to label "another worktree". */
  cwd?: string | null;
  diffs: { path: string; old_text: string | null; new_text: string }[];
  content_text: string | null;
  /** P1: 표시 계층에서 content_text가 상한(32KB)으로 절단됨 — 뷰어가
   * claude_item_detail로 원문을 lazy 조회한다. 구 스냅샷엔 없음(optional). */
  content_truncated?: boolean;
  raw_input: unknown;
  agent_status: string;
  write_status: string;
  revision: number;
}
