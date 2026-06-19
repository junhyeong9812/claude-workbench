import { useRef, useState } from "react";
import {
  DockviewReact,
  DockviewDefaultTab,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudePanel } from "./ClaudePanel";

/** A saved Claude session, for the "+ Claude" picker (S3c). */
interface SessionSummary {
  session_id: string;
  date: string;
  title: string;
  count: number;
}

/** Default tab for all panels. Claude panels keep the standard tab look but
 * override its × to raise a close request (-> 닫기/삭제 modal, B3-1); this
 * applies to restored panels too. */
function AppTab(props: IDockviewPanelHeaderProps) {
  if (props.params.kind === "claude") {
    const sessionId =
      (props.params.sessionId as string) ?? (props.params.loadSessionId as string) ?? null;
    return (
      <DockviewDefaultTab
        {...props}
        closeActionOverride={() =>
          useClaudeUi.getState().requestClose({ panelId: props.api.id, sessionId })
        }
      />
    );
  }
  return <DockviewDefaultTab {...props} />;
}

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
  // Saved-session picker for "+ Claude" (null = closed).
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // Close request raised by a Claude tab's × (B3-1).
  const closeRequest = useClaudeUi((s) => s.closeRequest);
  const clearClose = useClaudeUi((s) => s.clearClose);

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

  const addPanel = (kind: PanelKind, opts?: { loadSessionId?: string; title?: string }) => {
    const api = apiRef.current;
    if (!api) return;
    const n = ++counterRef.current;
    const title = opts?.title ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`;
    // Terminals get the real PTY panel, Claude the ACP panel (with its own
    // embedded change timeline); editor stays a stub until P3.
    const component =
      kind === "terminal" ? "terminal" : kind === "claude" ? "claude" : "placeholder";
    api.addPanel({
      id: `${kind}-${Date.now()}`,
      component,
      title,
      params: { kind, title, ...(opts?.loadSessionId ? { loadSessionId: opts.loadSessionId } : {}) },
    });
  };

  // Resolve a close request from a Claude tab's × (B3-1): 닫기 keeps the saved
  // history, 삭제 also removes it; both close the panel.
  const resolveClose = (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    if (deleteHistory && req.sessionId && activeProject) {
      invoke("acp_delete_session", { project: activeProject, sessionId: req.sessionId }).catch(
        () => {},
      );
    }
    apiRef.current?.getPanel(req.panelId)?.api.close();
  };

  /** Session ids currently open in a panel (live `sessionId` or read-only
   * `loadSessionId`), so the picker can exclude them (B3-2). */
  const openSessionIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const p of apiRef.current?.panels ?? []) {
      const prm = p.params as { sessionId?: string; loadSessionId?: string } | undefined;
      if (prm?.sessionId) ids.add(prm.sessionId);
      if (prm?.loadSessionId) ids.add(prm.loadSessionId);
    }
    return ids;
  };

  // "+ Claude": offer to reopen a saved (and not-already-open) session, else new.
  const openClaude = async () => {
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      sessions = await invoke<SessionSummary[]>("acp_sessions", { project: activeProject }).catch(
        () => [],
      );
    }
    const open = openSessionIds();
    sessions = sessions.filter((s) => !open.has(s.session_id));
    if (sessions.length === 0) addPanel("claude");
    else setPicker(sessions);
  };

  return (
    <div className="main-area">
      <div className="main-toolbar">
        <button className="toolbar-btn" onClick={() => addPanel("terminal")}>
          + Terminal
        </button>
        <button className="toolbar-btn" onClick={openClaude}>
          + Claude
        </button>
        <button className="toolbar-btn" onClick={() => addPanel("editor")}>
          + Editor
        </button>
        {picker && (
          <div className="claude-picker">
            <button
              className="claude-picker-item claude-picker-new"
              onClick={() => {
                setPicker(null);
                addPanel("claude");
              }}
            >
              + 새 세션
            </button>
            {picker.map((s) => (
              <button
                key={s.session_id}
                className="claude-picker-item"
                onClick={() => {
                  setPicker(null);
                  addPanel("claude", {
                    loadSessionId: s.session_id,
                    title: s.title ? s.title.slice(0, 24) : s.date,
                  });
                }}
              >
                <span className="claude-picker-title">{s.title || "(제목 없음)"}</span>
                <span className="claude-picker-meta">
                  {s.date} · 변경 {s.count}
                </span>
              </button>
            ))}
            <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
              취소
            </button>
          </div>
        )}
      </div>
      <DockviewReact
        key={activeProject ?? "none"}
        className="dockview-theme-dark main-dock"
        components={components}
        defaultTabComponent={AppTab}
        onReady={onReady}
      />

      {closeRequest && (
        <div className="claude-modal-backdrop" onClick={() => clearClose()}>
          <div className="claude-modal" onClick={(e) => e.stopPropagation()}>
            <div className="claude-modal-title">이 Claude 세션을 어떻게 할까요?</div>
            <button className="claude-modal-opt" onClick={() => resolveClose(false)}>
              닫기 <span className="claude-modal-hint">세션 히스토리 보존 (나중에 다시 열기)</span>
            </button>
            <button
              className="claude-modal-opt claude-modal-del"
              onClick={() => resolveClose(true)}
            >
              삭제 <span className="claude-modal-hint">히스토리까지 영구 삭제</span>
            </button>
            <button className="claude-modal-opt claude-modal-cancel" onClick={() => clearClose()}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
