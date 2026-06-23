import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";
import { isTransferring } from "../state/panelTransfer";
import { closePanelSession, sessionsInLayout } from "../state/panelSession";
import { installDragOut, hasInFlight } from "../state/windowTransfer";
import { installTransferTarget } from "../state/panelTransferTarget";
import { DropTargetOverlay } from "./DropTargetOverlay";
import { components, AppTab } from "./panelRegistry";

const AUTOCLOSE_DEBOUNCE_MS = 1500;

/**
 * Root of a popped-out panel window (`#popout` hash). A minimal workbench: a
 * thin toolbar showing the cross-window-synced active project, over a dockview
 * that holds the panels docked into this window.
 *
 * Docking works in every direction (review P4): this window both RECEIVES
 * panels (installTransferTarget) and lets its own tabs be dragged out to other
 * windows or the desktop (installDragOut). The dockview is keyed by the active
 * project (like the main window) so a project switch swaps it.
 *
 * Lifecycle: a transferred panel re-creates with the same backend session.
 * Closing this window closes every session it owns — current panels AND ones
 * detached into other projects' layouts (review R1-5/R1-7). When its last panel
 * is dragged away it auto-closes, but only once no transfer is in flight so a
 * rejected move can be re-inserted first (review R4-4).
 */
export function PopoutWorkbench() {
  const label = getCurrentWindow().label;
  const init = useAppStore((s) => s.init);
  const initProjectSync = useAppStore((s) => s.initProjectSync);
  const activeProject = useAppStore((s) => s.activeProject);
  const theme = useAppStore((s) => s.theme);

  const apiRef = useRef<DockviewApi | null>(null);
  const dockDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const processedRef = useRef<Set<string>>(new Set());
  const everHadPanelRef = useRef(false);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [listenerReady, setListenerReady] = useState(false);
  const announcedRef = useRef(false);
  // True once the MAIN window is quitting (app-shutdown). Distinguishes a quit —
  // where this popout's layout must survive to reopen next launch — from a
  // genuine close (user X / empty auto-close), which must NOT reopen (P2).
  const shuttingDownRef = useRef(false);

  // Claude 닫기/삭제 modal — each window has its own useClaudeUi instance, so the
  // popout must handle its own Claude tab × (review R1-6).
  const closeRequest = useClaudeUi((s) => s.closeRequest);
  const clearClose = useClaudeUi((s) => s.clearClose);

  // Close every session this window owns (current panels + ones detached into
  // other projects' saved layouts) — review R1-5/R1-7.
  const closeOwnedSessions = async () => {
    const seen = new Set<number>();
    const tasks: Promise<void>[] = [];
    const add = (params: { kind?: unknown; sessionId?: unknown } | undefined) => {
      const sid = params?.sessionId;
      if (typeof sid === "number" && !seen.has(sid)) {
        seen.add(sid);
        tasks.push(closePanelSession(params));
      }
    };
    for (const p of apiRef.current?.panels ?? []) add(p.params as never);
    const layouts = useAppStore.getState().popoutLayouts[label] ?? {};
    for (const layout of Object.values(layouts)) {
      for (const s of sessionsInLayout(layout)) add({ kind: s.kind, sessionId: s.sessionId });
    }
    await Promise.all(tasks);
  };

  // Load the workspace (for the synced active project) + follow cross-window
  // project switches (review R0-4).
  useEffect(() => {
    void init();
    let un: (() => void) | undefined;
    initProjectSync()
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, [init, initProjectSync]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Dispose dock listeners on unmount (window close).
  useEffect(
    () => () => {
      dockDisposablesRef.current.forEach((d) => d.dispose());
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    },
    [],
  );

  // Receive panels docked INTO this window (shared with the main window).
  useEffect(() => {
    let un: (() => void) | undefined;
    installTransferTarget(label, () => apiRef.current, processedRef.current)
      .then((f) => {
        un = f;
        setListenerReady(true);
      })
      .catch(() => {});
    return () => un?.();
  }, [label]);

  // Announce readiness AFTER the dock + transfer listener are up AND the project
  // has settled, so the source detaches only into a window that can accept the
  // panel and the transfer's project matches ours (review R1-4).
  useEffect(() => {
    if (announcedRef.current || !apiReady || !listenerReady || !activeProject) return;
    announcedRef.current = true;
    emit("popout-ready", { label, project: activeProject }).catch(() => {});
  }, [apiReady, listenerReady, activeProject, label]);

  // Close-by-X: tear down owned sessions, then destroy (review R1-7). A genuine
  // close (not an app quit) drops this popout's persisted layout so it won't
  // reopen next launch (P2) — the shutdown path sets shuttingDownRef to skip this.
  useEffect(() => {
    const win = getCurrentWindow();
    const unP = win.onCloseRequested(async (event) => {
      event.preventDefault();
      await closeOwnedSessions();
      if (!shuttingDownRef.current) {
        useAppStore.getState().removePopoutLayout(label);
      }
      await win.destroy();
    });
    return () => {
      void unP.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Main-window shutdown: close our sessions, then ACK so main only destroys us
  // after teardown actually ran (no 250ms race — review P4-impl #2).
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("app-shutdown", async () => {
      // App quit: keep this popout's layout (it reopens next launch) and capture
      // its geometry so it lands in place. Mark shutting-down so the close handler
      // doesn't drop the entry if destroy() routes through onCloseRequested (P2).
      shuttingDownRef.current = true;
      const win = getCurrentWindow();
      try {
        const [pos, size, scale] = await Promise.all([
          win.outerPosition(),
          win.outerSize(),
          win.scaleFactor(),
        ]);
        useAppStore.getState().setPopoutGeometry(label, {
          x: Math.round(pos.x / scale),
          y: Math.round(pos.y / scale),
          width: Math.round(size.width / scale),
          height: Math.round(size.height / scale),
        });
      } catch {
        /* geometry best-effort — reopen falls back to default placement */
      }
      await closeOwnedSessions();
      void emit("app-shutdown-ack", { label });
    })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Auto-close once this window's last panel is dragged away — but only in a
  // stable empty state (no transfer in flight), debounced, and only if it ever
  // held a panel, so a brand-new window or a mid-transfer reject can't trigger a
  // close that loses a panel (review R4-4).
  const maybeAutoClose = () => {
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = setTimeout(() => {
      autoCloseTimerRef.current = null;
      const empty = (apiRef.current?.panels.length ?? 0) === 0;
      if (!everHadPanelRef.current || !empty) return;
      // A move is still settling — re-evaluate after it resolves so a rejected
      // last-tab move (re-inserted) doesn't get the window closed, and a
      // successful one still closes it (review P4-impl #3).
      if (hasInFlight()) {
        maybeAutoClose();
        return;
      }
      void getCurrentWindow().close();
    }, AUTOCLOSE_DEBOUNCE_MS);
  };

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    // Restore this window's saved layout for the current project (swap).
    const proj = useAppStore.getState().activeProject;
    if (proj) {
      const saved = useAppStore.getState().getPopoutLayout(label, proj);
      if (saved != null) {
        try {
          api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
        } catch (err) {
          console.error("[popout] fromJSON failed; starting empty", err);
        }
      }
    }
    if (api.panels.length > 0) everHadPanelRef.current = true;
    // Dispose listeners from a previous mount (project-keyed remount) so a stale
    // dock can't save the wrong project's layout (review P2-impl #4).
    for (const d of dockDisposablesRef.current) d.dispose();
    dockDisposablesRef.current = [
      installDragOut(api),
      api.onDidAddPanel(() => {
        everHadPanelRef.current = true;
      }),
      api.onDidLayoutChange(() => {
        const p = useAppStore.getState().activeProject;
        if (p) useAppStore.getState().setPopoutLayout(label, p, api.toJSON());
      }),
      api.onDidRemovePanel((panel) => {
        const params = panel.params as { kind?: string; sessionId?: number } | undefined;
        const transferring = isTransferring(panel.id);
        // Claude sessions are refcounted: detach this window (closeIfLast=false on
        // transfer). Terminals are single-owner: a transfer skips their close.
        if (typeof params?.sessionId === "number") {
          if (params.kind === "claudeterm") {
            void closePanelSession(params as never, { closeIfLast: !transferring });
          } else if (!transferring) {
            void closePanelSession(params as never);
          }
        }
        if (api.panels.length === 0) maybeAutoClose();
      }),
    ];
    setApiReady(true);
  };

  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    const project = req.project ?? activeProject;
    // 삭제: force-close the whole session before deleting history. 닫기: close the
    // panel → onDidRemovePanel detaches this window (refcount, P6).
    if (req.kind === "claudeterm" && deleteHistory && typeof req.ptyId === "number") {
      await invoke("claude_close", { id: req.ptyId }).catch(() => {});
      if (req.sessionId && project) {
        await invoke("claude_delete", { project, uuid: req.sessionId }).catch(() => {});
      }
    }
    apiRef.current?.getPanel(req.panelId)?.api.close();
  };

  return (
    <div className="popout-workbench" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <DropTargetOverlay />
      <div className="toolbar">
        <span className="toolbar-title" title="공유 활성 프로젝트">
          🪟 {activeProject ?? "(프로젝트 없음)"}
        </span>
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
            <button className="claude-modal-opt claude-modal-del" onClick={() => resolveClose(true)}>
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
