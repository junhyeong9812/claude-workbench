import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ITheme } from "@xterm/xterm";
import type { DirEntry, Project, ProjectType, WorkspaceState } from "../types";

/** Clamp a font size to the allowed range (also normalizes NaN). */
export const clampFontSize = (n: number): number => Math.max(9, Math.min(28, Math.round(n) || 13));

/** Persisted study slice (folders + tabs + active + per-side mode). */
interface StudyPersist {
  folders: { left: string | null; right: string | null };
  tabs: { left: string[]; right: string[] };
  active: { left: string | null; right: string | null };
  mode: { left: "viewer" | "editor"; right: "viewer" | "editor" };
}

const STUDY_DEFAULT: StudyPersist = {
  folders: { left: null, right: null },
  tabs: { left: [], right: [] },
  active: { left: null, right: null },
  mode: { left: "viewer", right: "viewer" },
};

/** Safe-parse + validate the persisted study view slice (P4). Validates nested
 * fields so corrupt/old JSON can't break consumers (codex SF-4). */
function loadStudyView(): StudyPersist {
  try {
    const v = JSON.parse(localStorage.getItem("studyView") || "null");
    if (!v || typeof v !== "object") return STUDY_DEFAULT;
    const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
    const strArr = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : [];
    const md = (x: unknown): "viewer" | "editor" => (x === "editor" ? "editor" : "viewer");
    const F = (v.folders ?? {}) as Record<string, unknown>;
    const T = (v.tabs ?? {}) as Record<string, unknown>;
    const A = (v.active ?? {}) as Record<string, unknown>;
    const M = (v.mode ?? {}) as Record<string, unknown>;
    return {
      folders: { left: str(F.left), right: str(F.right) },
      tabs: { left: strArr(T.left), right: strArr(T.right) },
      active: { left: str(A.left), right: str(A.right) },
      mode: { left: md(M.left), right: md(M.right) },
    };
  } catch {
    return STUDY_DEFAULT;
  }
}

/** Persist the study view slice to localStorage (survives restart). */
function saveStudyView(s: {
  studyFolders: StudyPersist["folders"];
  studyTabs: StudyPersist["tabs"];
  studyActive: StudyPersist["active"];
  studyMode: StudyPersist["mode"];
}) {
  const slice: StudyPersist = {
    folders: s.studyFolders,
    tabs: s.studyTabs,
    active: s.studyActive,
    mode: s.studyMode,
  };
  localStorage.setItem("studyView", JSON.stringify(slice));
}

const STUDY0 = loadStudyView();

const TERM_COLOR_KEYS = new Set([
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
]);
const isHex = (v: unknown): v is string =>
  typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

/** Safe-parse + validate the persisted terminal color overrides — drop unknown
 * keys / non-hex values, and reject non-objects (codex CF-3). */
function loadTermColors(): Partial<ITheme> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem("termColors") || "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (TERM_COLOR_KEYS.has(k) && isHex(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as Partial<ITheme>) : null;
}

/** A request to open a diff in the main area (file change or a commit). */
export interface DiffSpec {
  title: string;
  cwd: string;
  /** File diff: the path (+ `staged`). */
  path?: string;
  staged?: boolean;
  /** Commit diff: the commit hash. */
  hash?: string;
}

/**
 * Global shell state.
 *
 * Invariants:
 *  - `projects` is the set of open tabs; `activeProject` is the path of the
 *    active one (or null).
 *  - Tree expansion is stored *per project* (`project.tree_state.expanded`) so
 *    manipulating one project's tree never affects another's.
 *  - `childrenCache` is keyed by absolute directory path. It is pure filesystem
 *    data (project-independent) and is NOT persisted.
 */
interface AppState {
  projects: Project[];
  activeProject: string | null;
  /** dirPath -> its immediate children (transient cache). */
  childrenCache: Record<string, DirEntry[]>;
  /** dirPath -> in-flight read_dir guard. */
  loadingDirs: Record<string, boolean>;
  /** Keyboard cursor in the folder tree (focused node path), or null. Transient. */
  treeCursor: string | null;
  /** File currently shown in the peek viewer overlay, or null (closed). Transient. */
  peekFile: string | null;
  /** A request to open a file in the editor (consumed by MainArea, which owns the
   * dockview api), or null. Transient. */
  editorOpenRequest: string | null;
  /** A request to open a diff panel (consumed by MainArea), or null. Transient. */
  diffRequest: DiffSpec | null;
  /** Bumped to ask MainArea to focus the active dockview panel (Ctrl+B from the
   * already-focused tree toggles focus back to the open tab). A counter so every
   * press re-fires even when the value would otherwise be unchanged. */
  focusMainRequest: number;
  /** Color theme (persisted to localStorage). Drives CSS vars + xterm palette. */
  theme: "dark" | "light";
  /** Code font size in px (terminals + editor/viewer), persisted. */
  fontSize: number;
  /** Workspace view mode: normal workspace or the two-folder study view. Persisted. */
  mode: "workspace" | "study";
  /** Study view: root folder per side (persisted). */
  studyFolders: { left: string | null; right: string | null };
  /** Study view: open file tabs per side, MRU order (most recent first). */
  studyTabs: { left: string[]; right: string[] };
  /** Study view: active tab path per side. */
  studyActive: { left: string | null; right: string | null };
  /** Study view: dockview layout of the single pinned Claude study session
   * (in-memory — keeps the session attached across mode switches within a run). */
  studySessionLayout: unknown | null;
  /** Study view: stable Claude session UUID (persisted). The study session is
   * always created/resumed under this id so it survives restart even before any
   * chat (claude writes the JSONL only on interaction). */
  studySessionUuid: string | null;
  /** Study view: per-side open behavior. "viewer" = tree cursor follows and
   * replaces a single preview (read); "editor" = files accumulate as tabs. */
  studyMode: { left: "viewer" | "editor"; right: "viewer" | "editor" };
  /** Custom terminal color overrides (merged over the theme base), or null to
   * follow the theme. Persisted. */
  termColors: Partial<ITheme> | null;

  /** Load persisted state from the backend on startup. */
  init: () => Promise<void>;
  /** Open a folder as a new project tab (or focus it if already open). */
  addProject: (path: string) => Promise<void>;
  /** Close a project tab. */
  closeProject: (path: string) => void;
  /** Move `fromPath`'s tab to just before/after `toPath` and persist. */
  reorderProject: (
    fromPath: string,
    toPath: string,
    insertAfter: boolean,
  ) => void;
  /** Make a project active (swaps the visible tree). */
  setActive: (path: string) => void;
  /** Expand/collapse a directory for the active project. */
  toggleExpanded: (dirPath: string) => void;
  /** Lazily load a directory's children via the backend. */
  loadChildren: (dirPath: string) => Promise<void>;
  /** Force re-read a directory (after create/delete) — bypasses the cache. */
  reloadDir: (dirPath: string) => Promise<void>;
  /** Re-read the active project's root + expanded dirs (disk reload). */
  reloadActiveTree: () => Promise<void>;
  /** Save a project's dockview main-area layout (opaque JSON) and persist. */
  setLayout: (path: string, layout: unknown) => void;
  /** Move the folder-tree keyboard cursor. */
  setTreeCursor: (path: string | null) => void;
  /** Open/close the peek viewer on a file (null closes it). */
  setPeekFile: (path: string | null) => void;
  /** Request opening a file in the editor (MainArea consumes + clears with null). */
  requestEditorOpen: (path: string | null) => void;
  /** Request opening a diff panel (MainArea consumes + clears with null). */
  requestDiff: (spec: DiffSpec | null) => void;
  /** Ask MainArea to focus the active dockview panel (Ctrl+B tree→tab toggle). */
  requestFocusMain: () => void;
  /** Switch the color theme. */
  setTheme: (theme: "dark" | "light") => void;
  /** Set the code font size (clamped 9–28). */
  setFontSize: (n: number) => void;
  /** Set (or clear with null) the custom terminal color overrides. */
  setTermColors: (c: Partial<ITheme> | null) => void;
  /** Switch the workspace view mode (workspace / study). */
  setMode: (mode: "workspace" | "study") => void;
  /** Set (or clear) a study side's root folder (resets that side's tabs). */
  setStudyFolder: (side: "left" | "right", path: string | null) => void;
  /** Open a file in a study side's viewer (front of MRU + active). */
  openStudyTab: (side: "left" | "right", path: string) => void;
  /** Close a study tab (fixes the active tab if it was the one closed). */
  closeStudyTab: (side: "left" | "right", path: string) => void;
  /** Activate a study tab (moves it to front of MRU). */
  setStudyActive: (side: "left" | "right", path: string) => void;
  /** Save the study session's dockview layout (in-memory). */
  setStudySessionLayout: (layout: unknown | null) => void;
  /** Return the stable study session UUID, generating + persisting if absent. */
  ensureStudySessionUuid: () => string;
  /** Set a study side's open mode (viewer / editor). */
  setStudyMode: (side: "left" | "right", mode: "viewer" | "editor") => void;
  /** Viewer-mode open: replace the side's single preview tab (no accumulation). */
  openStudyPreview: (side: "left" | "right", path: string) => void;
  /** Cycle the active tab by `dir` (+1/-1) in stable order (Alt+←/→ tab nav). */
  cycleStudyTab: (side: "left" | "right", dir: 1 | -1) => void;
  /** Close any study tabs at `path` or under it (after a delete) — both sides. */
  closeStudyTabsUnder: (path: string) => void;
  /** Persist the current workspace to the backend. */
  persist: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  activeProject: null,
  childrenCache: {},
  loadingDirs: {},
  treeCursor: null,
  peekFile: null,
  editorOpenRequest: null,
  diffRequest: null,
  focusMainRequest: 0,
  theme: (localStorage.getItem("theme") as "dark" | "light") || "dark",
  fontSize: clampFontSize(Number(localStorage.getItem("fontSize")) || 13),
  termColors: loadTermColors(),
  mode: (localStorage.getItem("mode") as "workspace" | "study") || "workspace",
  studyFolders: STUDY0.folders,
  studyTabs: STUDY0.tabs,
  studyActive: STUDY0.active,
  studyMode: STUDY0.mode,
  studySessionLayout: null,
  studySessionUuid: localStorage.getItem("studySessionUuid"),

  init: async () => {
    try {
      const ws = await invoke<WorkspaceState>("load_state");
      const loaded = ws.open_projects ?? [];
      set({
        projects: loaded,
        activeProject: ws.active_project ?? null,
      });

      // Self-heal: re-detect types for every loaded project so old saved
      // state (single `project_type`, or stale markers) normalizes to the
      // current multi-type model. Best-effort; failures keep prior value.
      const refreshed = await Promise.all(
        loaded.map(async (p) => {
          try {
            const types = await invoke<ProjectType[]>("detect_project_types", {
              path: p.path,
            });
            return { ...p, project_types: types };
          } catch (err) {
            console.error("detect_project_types failed", err);
            return { ...p, project_types: p.project_types ?? [] };
          }
        }),
      );
      set({ projects: refreshed });
      get().persist();
    } catch (err) {
      // load_state is infallible on the Rust side, but guard anyway.
      console.error("load_state failed", err);
    }
  },

  addProject: async (path) => {
    // Already open -> just focus it.
    if (get().projects.some((p) => p.path === path)) {
      set({ activeProject: path });
      get().persist();
      return;
    }

    let projectTypes: ProjectType[] = [];
    try {
      projectTypes = await invoke<ProjectType[]>("detect_project_types", {
        path,
      });
    } catch (err) {
      console.error("detect_project_types failed", err);
    }

    const project: Project = {
      path,
      name: basename(path),
      project_types: projectTypes,
      tree_state: { expanded: [] },
    };

    set((s) => ({
      projects: [...s.projects, project],
      activeProject: path,
    }));
    get().persist();
  },

  closeProject: (path) => {
    set((s) => {
      const projects = s.projects.filter((p) => p.path !== path);
      let activeProject = s.activeProject;
      if (activeProject === path) {
        activeProject = projects.length > 0 ? projects[0].path : null;
      }
      return { projects, activeProject };
    });
    get().persist();
  },

  reorderProject: (fromPath, toPath, insertAfter) => {
    set((s) => {
      if (fromPath === toPath) return {};
      const fromIdx = s.projects.findIndex((p) => p.path === fromPath);
      if (fromIdx === -1) return {};
      const projects = [...s.projects];
      const [moved] = projects.splice(fromIdx, 1);
      // Compute the insertion point AFTER removal so no index-shift correction
      // is needed; `toPath` still exists in the array (from !== to).
      const targetIdx = projects.findIndex((p) => p.path === toPath);
      if (targetIdx === -1) return {};
      projects.splice(insertAfter ? targetIdx + 1 : targetIdx, 0, moved);
      return { projects };
    });
    get().persist();
  },

  setActive: (path) => {
    set({ activeProject: path });
    get().persist();
  },

  setTreeCursor: (path) => set({ treeCursor: path }),
  setPeekFile: (path) => set({ peekFile: path }),
  requestEditorOpen: (path) => set({ editorOpenRequest: path }),
  requestDiff: (spec) => set({ diffRequest: spec }),
  requestFocusMain: () => set((s) => ({ focusMainRequest: s.focusMainRequest + 1 })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (n) => set({ fontSize: clampFontSize(n) }),
  setTermColors: (c) => {
    if (c) localStorage.setItem("termColors", JSON.stringify(c));
    else localStorage.removeItem("termColors");
    set({ termColors: c });
  },
  setMode: (mode) => {
    localStorage.setItem("mode", mode);
    set({ mode });
  },
  setStudyFolder: (side, path) => {
    set((s) => ({
      studyFolders: { ...s.studyFolders, [side]: path },
      studyTabs: { ...s.studyTabs, [side]: [] },
      studyActive: { ...s.studyActive, [side]: null },
    }));
    saveStudyView(get());
  },
  openStudyTab: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path, ...s.studyTabs[side].filter((p) => p !== path)] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  setStudyActive: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path, ...s.studyTabs[side].filter((p) => p !== path)] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  closeStudyTab: (side, path) => {
    set((s) => {
      const next = s.studyTabs[side].filter((p) => p !== path);
      const active = s.studyActive[side] === path ? (next[0] ?? null) : s.studyActive[side];
      return {
        studyTabs: { ...s.studyTabs, [side]: next },
        studyActive: { ...s.studyActive, [side]: active },
      };
    });
    saveStudyView(get());
  },
  setStudySessionLayout: (layout) => set({ studySessionLayout: layout }),
  ensureStudySessionUuid: () => {
    let u = get().studySessionUuid;
    if (!u) {
      u = crypto.randomUUID();
      localStorage.setItem("studySessionUuid", u);
      set({ studySessionUuid: u });
    }
    return u;
  },
  setStudyMode: (side, mode) => {
    set((s) => ({ studyMode: { ...s.studyMode, [side]: mode } }));
    saveStudyView(get());
  },
  openStudyPreview: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  cycleStudyTab: (side, dir) => {
    set((s) => {
      const tabs = s.studyTabs[side];
      if (tabs.length === 0) return {};
      const i = tabs.indexOf(s.studyActive[side] ?? "");
      const ni = ((i === -1 ? 0 : i) + dir + tabs.length) % tabs.length;
      return { studyActive: { ...s.studyActive, [side]: tabs[ni] } };
    });
    saveStudyView(get());
  },
  closeStudyTabsUnder: (path) => {
    const match = (p: string) => p === path || p.startsWith(`${path}/`);
    set((s) => {
      const prune = (side: "left" | "right") => {
        const tabs = s.studyTabs[side].filter((p) => !match(p));
        const active = match(s.studyActive[side] ?? "\0") ? (tabs[0] ?? null) : s.studyActive[side];
        return { tabs, active };
      };
      const L = prune("left");
      const R = prune("right");
      return {
        studyTabs: { left: L.tabs, right: R.tabs },
        studyActive: { left: L.active, right: R.active },
      };
    });
    saveStudyView(get());
  },

  toggleExpanded: (dirPath) => {
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.path !== s.activeProject) return p;
        const expanded = p.tree_state.expanded;
        const next = expanded.includes(dirPath)
          ? expanded.filter((d) => d !== dirPath)
          : [...expanded, dirPath];
        return { ...p, tree_state: { ...p.tree_state, expanded: next } };
      }),
    }));
    get().persist();
  },

  loadChildren: async (dirPath) => {
    const { childrenCache, loadingDirs } = get();
    if (childrenCache[dirPath] || loadingDirs[dirPath]) return;

    set((s) => ({ loadingDirs: { ...s.loadingDirs, [dirPath]: true } }));
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dirPath });
      set((s) => ({
        childrenCache: { ...s.childrenCache, [dirPath]: entries },
      }));
    } catch (err) {
      // Surface as an empty (but resolved) listing; do not crash the tree.
      console.error("read_dir failed", err);
      set((s) => ({
        childrenCache: { ...s.childrenCache, [dirPath]: [] },
      }));
    } finally {
      set((s) => ({ loadingDirs: { ...s.loadingDirs, [dirPath]: false } }));
    }
  },

  reloadDir: async (dirPath) => {
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dirPath });
      set((s) => ({ childrenCache: { ...s.childrenCache, [dirPath]: entries } }));
    } catch (err) {
      console.error("reloadDir failed", err);
    }
  },

  reloadActiveTree: async () => {
    const { activeProject, projects } = get();
    if (!activeProject) return;
    await get().reloadDir(activeProject);
    const expanded = projects.find((p) => p.path === activeProject)?.tree_state.expanded ?? [];
    for (const d of expanded) await get().reloadDir(d);
  },

  setLayout: (path, layout) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.path === path ? { ...p, layout } : p,
      ),
    }));
    get().persist();
  },

  persist: () => {
    const state: WorkspaceState = {
      open_projects: get().projects,
      active_project: get().activeProject,
    };
    invoke("save_state", { state }).catch((err) => {
      console.error("save_state failed", err);
    });
  },
}));
