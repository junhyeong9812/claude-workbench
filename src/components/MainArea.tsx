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
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { EditorPanel } from "./EditorPanel";
import { DiffPanel } from "./DiffPanel";
import { fileName } from "./cmLang";
import { ClaudeTab } from "./ClaudeTab";

/** A saved session normalized for the reopen picker (ACP `claude` or A
 * `claudeterm`). `id` is the session UUID. */
interface SessionSummary {
  id: string;
  date: string;
  name: string;
  title: string;
  count: number;
  /** Handoff chain link (claudeterm only) — groups sessions into task chains. */
  prev_uuid?: string | null;
  /** The project (cwd) this session belongs to — passed through on reopen. */
  project: string;
}


/** Default tab for all panels. Both Claude panel kinds (ACP `claude` and the
 * architecture-A `claudeterm`) use the custom tab — its × raises a 닫기/삭제
 * modal and its title renames inline (B3-1/B3-5). */
function AppTab(props: IDockviewPanelHeaderProps) {
  const kind = props.params.kind;
  if (kind === "claudeterm") return <ClaudeTab {...props} />;
  return <DockviewDefaultTab {...props} />;
}

/** dockview component registry — maps component name -> React panel. */
const components = {
  placeholder: PlaceholderPanel,
  terminal: TerminalPanel,
  claudeterm: ClaudeTermPanel,
  editor: EditorPanel,
  diff: DiffPanel,
};

type PanelKind = "terminal" | "editor" | "claudeterm";

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
  const theme = useAppStore((s) => s.theme);
  const projects = useAppStore((s) => s.projects);
  const editorOpenRequest = useAppStore((s) => s.editorOpenRequest);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const diffRequest = useAppStore((s) => s.diffRequest);
  const requestDiff = useAppStore((s) => s.requestDiff);
  const focusMainRequest = useAppStore((s) => s.focusMainRequest);
  const setLayout = useAppStore((s) => s.setLayout);

  const apiRef = useRef<DockviewApi | null>(null);
  // Monotonic per-mount counter for human-friendly panel titles.
  const counterRef = useRef(0);
  // Saved-session picker for "+ Claude" (null = closed) + the name a "새 세션"
  // would get (B3-4: per-project "Claude N", computed when the picker opens).
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // Which kind the open picker creates/reopens: ACP `claude` or A `claudeterm`.
  const [newName, setNewName] = useState("Claude 1");
  // Expanded task chains in the picker (by head uuid) — collapsed shows only the
  // latest task of each chain; expand reveals its previous tasks.
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const toggleChain = (uuid: string) =>
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
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
      const params = panel.params as { kind?: string; sessionId?: number } | undefined;
      if (typeof params?.sessionId === "number") {
        // claudeterm sessions also need their poll thread stopped (claude_close);
        // plain terminals just close the PTY.
        const cmd = params.kind === "claudeterm" ? "claude_close" : "terminal_close";
        invoke(cmd, { id: params.sessionId }).catch(() => {});
      }
    });
  };

  const addPanel = (
    kind: PanelKind,
    opts?: { loadSessionId?: string; title?: string; project?: string; path?: string },
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const n = ++counterRef.current;
    const title = opts?.title ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`;
    // Terminals get the real PTY panel, claudeterm the real claude CLI + timeline,
    // editor a CodeMirror editor; anything else is a stub.
    const component =
      kind === "terminal"
        ? "terminal"
        : kind === "claudeterm"
          ? "claudeterm"
          : kind === "editor"
            ? "editor"
            : "placeholder";
    api.addPanel({
      id: `${kind}-${Date.now()}`,
      component,
      title,
      params: {
        kind,
        title,
        ...(opts?.loadSessionId ? { loadSessionId: opts.loadSessionId } : {}),
        ...(opts?.project ? { project: opts.project } : {}),
        ...(opts?.path ? { path: opts.path } : {}),
      },
    });
  };

  // Open a file in the editor when requested (from the peek viewer or tree). Focus
  // an already-open editor for the same file instead of opening a duplicate.
  useEffect(() => {
    if (!editorOpenRequest) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready (mount/project switch) — keep the request
    const path = editorOpenRequest;
    requestEditorOpen(null); // consume only once we can actually act (codex P2 E4)
    const existing = api.panels.find((p) => {
      const prm = p.params as { kind?: string; path?: string } | undefined;
      return prm?.kind === "editor" && prm.path === path;
    });
    if (existing) {
      existing.api.setActive();
      return;
    }
    addPanel("editor", { path, title: fileName(path) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest, activeProject]);

  // Open a diff panel (changed file or commit) when requested from the Git panel.
  useEffect(() => {
    if (!diffRequest) return;
    const api = apiRef.current;
    if (!api) return;
    const spec = diffRequest;
    requestDiff(null);
    const key = spec.hash ? `diff:${spec.hash}` : `diff:${spec.path}:${spec.staged ? 1 : 0}`;
    const existing = api.panels.find((p) => p.id === key);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: key,
      component: "diff",
      title: spec.title,
      params: { kind: "diff", ...spec },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffRequest, activeProject]);

  // Resolve a close request from a Claude tab's × (B3-1): 닫기 keeps the saved
  // history, 삭제 also removes it; both close the panel.
  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    // Delete must target the session's *own* project (a workspace-wide reopen can
    // open a task from a project other than the active tab) — codex P2 F1.
    const project = req.project ?? activeProject;
    if (req.kind === "claudeterm") {
      // Stop the live poll thread BEFORE deleting, so it can't recreate the
      // snapshot we're about to remove (codex session-UX F4).
      if (typeof req.ptyId === "number") {
        await invoke("claude_close", { id: req.ptyId }).catch(() => {});
      }
      if (deleteHistory && req.sessionId && project) {
        await invoke("claude_delete", {
          project,
          uuid: req.sessionId,
        }).catch(() => {});
      }
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

  // "+ Claude(A)": open the picker — name a new task session or reopen a saved
  // (not-already-open) one, grouped into task chains. Per-project (active project).
  const openPicker = async () => {
    setExpandedChains(new Set());
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      const raw = await invoke<
        {
          uuid: string;
          name: string;
          title: string;
          date: string;
          count: number;
          prev_uuid?: string | null;
        }[]
      >("claude_sessions", { project: activeProject }).catch(() => []);
      sessions = raw.map((s) => ({
        id: s.uuid,
        name: s.name,
        title: s.title,
        date: s.date,
        count: s.count,
        prev_uuid: s.prev_uuid ?? null,
        project: activeProject,
      }));
    }
    setNewName(`Claude ${sessions.length + openKindCount("claudeterm") + 1}`);
    setPicker(sessions); // open-session filtering + chain grouping happen at render
  };

  // Picker rows: group saved task sessions into chains (head + collapsed previous
  // tasks). Already-open sessions never appear as rows (their predecessors still
  // surface via the fallback below). Chain indexing keys on uuid alone — handoff
  // uuids are random v4 (globally unique); the React row key is still compounded
  // with project to be safe (codex P2 F2).
  const pickerRows = (): { s: SessionSummary; depth: number; hasPrev: boolean }[] => {
    if (picker == null) return [];
    const open = openSessionIds();
    const byUuid = new Map(picker.map((s) => [s.id, s]));
    const referenced = new Set(picker.map((s) => s.prev_uuid).filter(Boolean) as string[]);
    const rows: { s: SessionSummary; depth: number; hasPrev: boolean }[] = [];
    const visited = new Set<string>();

    // Emit a chain rooted at `head`: the head row + (when expanded) its previous
    // tasks, both skipping already-open sessions.
    const emit = (head: SessionSummary) => {
      visited.add(head.id);
      const prev: SessionSummary[] = [];
      const seen = new Set([head.id]);
      let cur = head.prev_uuid ? byUuid.get(head.prev_uuid) : undefined;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        visited.add(cur.id);
        prev.push(cur);
        cur = cur.prev_uuid ? byUuid.get(cur.prev_uuid) : undefined;
      }
      const shownPrev = prev.filter((p) => !open.has(p.id));
      rows.push({ s: head, depth: 0, hasPrev: shownPrev.length > 0 });
      if (expandedChains.has(head.id)) {
        for (const p of shownPrev) rows.push({ s: p, depth: 1, hasPrev: false });
      }
    };

    // Heads = sessions no one continues from (the latest task of each chain).
    const heads = picker
      .filter((s) => !referenced.has(s.id) && !open.has(s.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const head of heads) emit(head);
    // Fallback: any session not reached from a head (pure cycle / orphan, or a
    // predecessor whose head is currently open) — emit so nothing is silently
    // dropped (codex P2 F3).
    for (const s of picker) {
      if (!visited.has(s.id) && !open.has(s.id)) emit(s);
    }
    return rows;
  };

  const createNewSession = () => {
    const name = newName.trim() || "Claude";
    setPicker(null);
    // Give the new session a stable UUID up front so it's saved in the layout
    // immediately → resumes the same session after restart (create-or-resume in
    // claude_start handles the not-yet-chatted case). #6
    addPanel("claudeterm", { title: name, loadSessionId: crypto.randomUUID() });
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

  // Ctrl+B from the already-focused tree asks to focus the open tab (App bumps
  // focusMainRequest). dockview's focus() focuses the active panel if one exists.
  // Skip the initial 0 so a fresh mount doesn't steal focus.
  useEffect(() => {
    if (focusMainRequest === 0) return;
    apiRef.current?.focus();
  }, [focusMainRequest]);

  return (
    <div className="main-area">
      <div className="main-toolbar">
        <button className="toolbar-btn" onClick={() => addPanel("terminal")}>
          + Terminal
        </button>
        <button className="toolbar-btn" onClick={() => openPicker()}>
          + Claude
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
            {(() => {
              const rows = pickerRows();
              if (rows.length === 0) return null;
              return (
                <>
                  <div className="claude-picker-sep">저장된 task</div>
                  {rows.map(({ s, depth, hasPrev }) => (
                    <div
                      key={`${s.project}:${s.id}`}
                      className="claude-picker-row"
                      style={{ paddingLeft: 4 + depth * 16 }}
                    >
                      <span
                        className="claude-picker-caret"
                        onClick={(e) => {
                          if (!hasPrev) return;
                          e.stopPropagation();
                          toggleChain(s.id);
                        }}
                        style={{ visibility: hasPrev ? "visible" : "hidden" }}
                        title={expandedChains.has(s.id) ? "이전 task 접기" : "이전 task 펼치기"}
                      >
                        {expandedChains.has(s.id) ? "▾" : "▸"}
                      </span>
                      <button
                        className="claude-picker-item"
                        onClick={() => {
                          setPicker(null);
                          addPanel("claudeterm", {
                            loadSessionId: s.id,
                            project: s.project,
                            title: s.name || s.title?.slice(0, 24) || s.date,
                          });
                        }}
                      >
                        <span className="claude-picker-title">
                          {depth > 0 ? "↳ " : ""}
                          {s.name || "(이름 없음)"}
                        </span>
                        <span className="claude-picker-meta">
                          {s.title ? `${s.title.slice(0, 40)} · ` : ""}
                          {s.date} · 변경 {s.count}
                        </span>
                      </button>
                    </div>
                  ))}
                </>
              );
            })()}
            <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
              취소
            </button>
          </div>
        )}
      </div>
      <DockviewReact
        key={activeProject ?? "none"}
        className={`dockview-theme-${theme === "light" ? "light" : "dark"} main-dock`}
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
