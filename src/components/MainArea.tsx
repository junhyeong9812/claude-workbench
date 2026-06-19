import { useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudePanel } from "./ClaudePanel";

/** dockview component registry — maps component name -> React panel. */
const components = {
  placeholder: PlaceholderPanel,
  terminal: TerminalPanel,
  claude: ClaudePanel,
};

type PanelKind = "terminal" | "editor" | "claude";

/**
 * The 80% main area, backed by dockview.
 *
 * Per-project isolation is achieved by keying the <DockviewReact> on the active
 * project path: switching projects remounts dockview, which fires `onReady`
 * again and restores *that* project's saved layout (or an empty layout). Layout
 * changes are persisted back to the store via `onDidLayoutChange`.
 */
export function MainArea() {
  const activeProject = useAppStore((s) => s.activeProject);
  const projects = useAppStore((s) => s.projects);
  const setLayout = useAppStore((s) => s.setLayout);

  const apiRef = useRef<DockviewApi | null>(null);
  // Monotonic per-mount counter for human-friendly panel titles.
  const counterRef = useRef(0);

  // The layout for the project this mount belongs to (read once at onReady).
  const savedLayout = projects.find((p) => p.path === activeProject)?.layout;

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;

    // Restore the saved layout first; a corrupt/incompatible blob must never
    // crash — fall back to an empty layout.
    if (savedLayout != null) {
      try {
        api.fromJSON(savedLayout as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.error("dockview fromJSON failed; starting empty", err);
      }
    }

    // Persist after restore so the restore itself does not redundantly re-save.
    api.onDidLayoutChange(() => {
      if (activeProject) {
        setLayout(activeProject, api.toJSON());
      }
    });

    // Real panel removal (close) -> close the backing session (spec §0.1). Tab/
    // project switches don't fire this, so those only detach (session lives).
    api.onDidRemovePanel((panel) => {
      const params = panel.params as { sessionId?: number; acpId?: number } | undefined;
      if (typeof params?.sessionId === "number") {
        invoke("terminal_close", { id: params.sessionId }).catch(() => {});
      }
      if (typeof params?.acpId === "number") {
        invoke("acp_close", { id: params.acpId }).catch(() => {});
      }
    });
  };

  const addPanel = (kind: PanelKind) => {
    const api = apiRef.current;
    if (!api) return;
    const n = ++counterRef.current;
    const title = `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`;
    // Terminals get the real PTY panel, Claude the ACP panel (with its own
    // embedded change timeline); editor stays a stub until P3.
    const component =
      kind === "terminal" ? "terminal" : kind === "claude" ? "claude" : "placeholder";
    api.addPanel({
      id: `${kind}-${Date.now()}`,
      component,
      title,
      params: { kind, title },
    });
  };

  return (
    <div className="main-area">
      <div className="main-toolbar">
        <button className="toolbar-btn" onClick={() => addPanel("terminal")}>
          + Terminal
        </button>
        <button className="toolbar-btn" onClick={() => addPanel("claude")}>
          + Claude
        </button>
        <button className="toolbar-btn" onClick={() => addPanel("editor")}>
          + Editor
        </button>
      </div>
      <DockviewReact
        key={activeProject ?? "none"}
        className="dockview-theme-dark main-dock"
        components={components}
        onReady={onReady}
      />
    </div>
  );
}
