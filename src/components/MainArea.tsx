import { useEffect, useRef, useState } from "react";
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
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { ClaudeTab } from "./ClaudeTab";

/** A saved session normalized for the reopen picker (ACP `claude` or A
 * `claudeterm`). `id` is the session UUID. */
interface SessionSummary {
  id: string;
  date: string;
  name: string;
  title: string;
  count: number;
}

/** Default tab for all panels. Both Claude panel kinds (ACP `claude` and the
 * architecture-A `claudeterm`) use the custom tab — its × raises a 닫기/삭제
 * modal and its title renames inline (B3-1/B3-5). */
function AppTab(props: IDockviewPanelHeaderProps) {
  const kind = props.params.kind;
  if (kind === "claude" || kind === "claudeterm") return <ClaudeTab {...props} />;
  return <DockviewDefaultTab {...props} />;
}

/** dockview component registry — maps component name -> React panel. */
const components = {
  placeholder: PlaceholderPanel,
  terminal: TerminalPanel,
  claude: ClaudePanel,
  claudeterm: ClaudeTermPanel,
};

type PanelKind = "terminal" | "editor" | "claude" | "claudeterm";

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
  // Saved-session picker for "+ Claude" (null = closed) + the name a "새 세션"
  // would get (B3-4: per-project "Claude N", computed when the picker opens).
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // Which kind the open picker creates/reopens: ACP `claude` or A `claudeterm`.
  const [pickerKind, setPickerKind] = useState<"claude" | "claudeterm">("claudeterm");
  const [newName, setNewName] = useState("Claude 1");
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
      const params = panel.params as
        | { kind?: string; sessionId?: number; acpId?: number }
        | undefined;
      if (typeof params?.sessionId === "number") {
        // claudeterm sessions also need their poll thread stopped (claude_close);
        // plain terminals just close the PTY.
        const cmd = params.kind === "claudeterm" ? "claude_close" : "terminal_close";
        invoke(cmd, { id: params.sessionId }).catch(() => {});
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
      kind === "terminal"
        ? "terminal"
        : kind === "claude"
          ? "claude"
          : kind === "claudeterm"
            ? "claudeterm"
            : "placeholder";
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
      const cmd = req.kind === "claudeterm" ? "claude_delete" : "acp_delete_session";
      const args =
        req.kind === "claudeterm"
          ? { project: activeProject, uuid: req.sessionId }
          : { project: activeProject, sessionId: req.sessionId };
      invoke(cmd, args).catch(() => {});
    }
    apiRef.current?.getPanel(req.panelId)?.api.close();
  };

  /** Session ids currently open in a panel (live `sessionId`/`sessionUuid` or
   * read-only `loadSessionId`), so the picker can exclude them (B3-2). */
  const openSessionIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const p of apiRef.current?.panels ?? []) {
      const prm = p.params as
        | { sessionId?: string; sessionUuid?: string; loadSessionId?: string }
        | undefined;
      // claude panels carry a string sessionId; claudeterm's sessionId is the
      // numeric PTY id, so its session UUID is `sessionUuid`.
      if (typeof prm?.sessionId === "string") ids.add(prm.sessionId);
      if (prm?.sessionUuid) ids.add(prm.sessionUuid);
      if (prm?.loadSessionId) ids.add(prm.loadSessionId);
    }
    return ids;
  };

  /** Open panels of `kind` (for numbering): empty sessions never persist, so the
   * next number is saved sessions + currently-open panels of that kind + 1. */
  const openKindCount = (kind: PanelKind): number =>
    (apiRef.current?.panels ?? []).filter(
      (p) => (p.params as { kind?: string } | undefined)?.kind === kind,
    ).length;

  // "+ Claude" / "+ Claude(A)": open the picker — name a new session or reopen a
  // saved (not-already-open) one. Normalizes both backends to `SessionSummary`.
  const openPicker = async (kind: "claude" | "claudeterm") => {
    setPickerKind(kind);
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      if (kind === "claudeterm") {
        const raw = await invoke<
          { uuid: string; name: string; title: string; date: string; count: number }[]
        >("claude_sessions", { project: activeProject }).catch(() => []);
        sessions = raw.map((s) => ({
          id: s.uuid,
          name: s.name,
          title: s.title,
          date: s.date,
          count: s.count,
        }));
      } else {
        const raw = await invoke<
          { session_id: string; name: string; title: string; date: string; count: number }[]
        >("acp_sessions", { project: activeProject }).catch(() => []);
        sessions = raw.map((s) => ({
          id: s.session_id,
          name: s.name,
          title: s.title,
          date: s.date,
          count: s.count,
        }));
      }
    }
    setNewName(`Claude ${sessions.length + openKindCount(kind) + 1}`);
    const open = openSessionIds();
    setPicker(sessions.filter((s) => !open.has(s.id)));
  };

  const createNewSession = () => {
    const name = newName.trim() || "Claude";
    setPicker(null);
    addPanel(pickerKind, { title: name });
  };

  // Alt+←/→/↑/↓ cycles the active session tab (dockview panel). Left/Up = prev,
  // Right/Down = next (wraps). Distinct from a Claude panel's Ctrl+←/→ pane focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const isNext = e.key === "ArrowRight" || e.key === "ArrowDown";
      const isPrev = e.key === "ArrowLeft" || e.key === "ArrowUp";
      if (!isNext && !isPrev) return;
      const api = apiRef.current;
      if (!api) return;
      const panels = api.panels;
      if (panels.length < 2) return;
      const idx = api.activePanel ? panels.indexOf(api.activePanel) : -1;
      const next = isNext
        ? (idx + 1) % panels.length
        : (idx - 1 + panels.length) % panels.length;
      e.preventDefault();
      panels[next].api.setActive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="main-area">
      <div className="main-toolbar">
        <button className="toolbar-btn" onClick={() => addPanel("terminal")}>
          + Terminal
        </button>
        <button className="toolbar-btn" onClick={() => openPicker("claude")}>
          + Claude
        </button>
        <button className="toolbar-btn" onClick={() => openPicker("claudeterm")}>
          + Claude(A)
        </button>
        <button className="toolbar-btn" onClick={() => addPanel("editor")}>
          + Editor
        </button>
        {picker !== null && (
          <div className="claude-picker">
            <div className="claude-picker-new-row">
              <input
                className="claude-picker-input"
                value={newName}
                autoFocus
                placeholder="새 세션 이름"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createNewSession();
                  else if (e.key === "Escape") setPicker(null);
                }}
              />
              <button className="claude-picker-create" onClick={createNewSession}>
                + 만들기
              </button>
            </div>
            {picker.length > 0 && <div className="claude-picker-sep">저장된 세션</div>}
            {picker.map((s) => (
              <button
                key={s.id}
                className="claude-picker-item"
                onClick={() => {
                  setPicker(null);
                  addPanel(pickerKind, {
                    loadSessionId: s.id,
                    title: s.name || s.title?.slice(0, 24) || s.date,
                  });
                }}
              >
                <span className="claude-picker-title">{s.name || "(이름 없음)"}</span>
                <span className="claude-picker-meta">
                  {s.title ? `${s.title.slice(0, 40)} · ` : ""}
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
