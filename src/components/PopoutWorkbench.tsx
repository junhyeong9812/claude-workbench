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
import type { TransferEnvelope } from "../state/windowTransfer";
import { components, AppTab } from "./panelRegistry";

/**
 * Root of a popped-out panel window (`#popout` hash). A minimal workbench: a
 * thin toolbar showing the cross-window-synced active project, over a dockview
 * that holds the panels transferred into this window.
 *
 * Per the "전 창 같이 swap" decision the dockview IS keyed by the active project
 * (like the main window): switching the shared project remounts it and restores
 * that project's layout for THIS window (in-memory `popoutLayouts`, review R1-5).
 * Panels detach on switch (sessions survive) and re-attach on return.
 *
 * Lifecycle: a transferred panel re-creates with the same backend session
 * (params.sessionId → snapshot re-attach). Closing this window closes every
 * session it owns — current panels AND ones detached into other projects'
 * layouts (review R1-5/R1-7) — so nothing leaks.
 */
export function PopoutWorkbench() {
  const label = getCurrentWindow().label;
  const init = useAppStore((s) => s.init);
  const initProjectSync = useAppStore((s) => s.initProjectSync);
  const activeProject = useAppStore((s) => s.activeProject);
  const theme = useAppStore((s) => s.theme);

  const apiRef = useRef<DockviewApi | null>(null);
  const dockDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const [apiReady, setApiReady] = useState(false);
  const [listenerReady, setListenerReady] = useState(false);
  const announcedRef = useRef(false);
  const processedRef = useRef<Set<string>>(new Set());

  // Claude 닫기/삭제 modal — each window has its own useClaudeUi instance, so the
  // popout must handle its own Claude tab × (review R1-6).
  const closeRequest = useClaudeUi((s) => s.closeRequest);
  const clearClose = useClaudeUi((s) => s.clearClose);

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
  useEffect(() => () => dockDisposablesRef.current.forEach((d) => d.dispose()), []);

  // Receive a transferred panel and re-create it with the same backend session.
  // Acknowledge accept/reject so the source can recover a failed add instead of
  // losing the panel (review P2-impl #3); only mark processed on success.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<TransferEnvelope>("panel-transfer", (e) => {
      const env = e.payload;
      if (env.targetLabel !== label) return; // addressed to another window
      if (processedRef.current.has(env.transferId)) return; // de-dup late delivery
      const api = apiRef.current;
      // Only accept if we're on the panel's project — our dockview is keyed by
      // project, so a mismatch would attach it under the wrong layout (#2).
      const sameProject = env.project === useAppStore.getState().activeProject;
      let ok = false;
      if (api && sameProject) {
        try {
          api.addPanel({
            id: env.panel.id,
            component: env.panel.component,
            title: env.panel.title,
            params: env.panel.params,
          });
          ok = true;
        } catch (err) {
          console.error("[popout] addPanel failed", err);
        }
      }
      if (ok) processedRef.current.add(env.transferId);
      void emit("transfer-result", { transferId: env.transferId, ok });
    })
      .then((f) => {
        un = f;
        setListenerReady(true);
      })
      .catch(() => {});
    return () => un?.();
  }, [label]);

  // Announce readiness AFTER the dock + transfer listener are up AND the project
  // has settled — so the source detaches only into a window that can accept the
  // panel, and the transfer's project matches ours (review R1-4).
  useEffect(() => {
    if (announcedRef.current || !apiReady || !listenerReady || !activeProject) return;
    announcedRef.current = true;
    emit("popout-ready", { label, project: activeProject }).catch(() => {});
  }, [apiReady, listenerReady, activeProject, label]);

  // Close every session this window owns before it is destroyed (review R1-7).
  useEffect(() => {
    const win = getCurrentWindow();
    const unP = win.onCloseRequested(async (event) => {
      event.preventDefault();
      const seen = new Set<number>();
      const tasks: Promise<void>[] = [];
      const add = (params: { kind?: unknown; sessionId?: unknown } | undefined) => {
        const sid = params?.sessionId;
        if (typeof sid === "number" && !seen.has(sid)) {
          seen.add(sid);
          tasks.push(closePanelSession(params));
        }
      };
      // Current panels + sessions detached into other projects' saved layouts.
      for (const p of apiRef.current?.panels ?? []) add(p.params as never);
      const layouts = useAppStore.getState().popoutLayouts[label] ?? {};
      for (const layout of Object.values(layouts)) {
        for (const s of sessionsInLayout(layout)) add({ kind: s.kind, sessionId: s.sessionId });
      }
      await Promise.all(tasks);
      await win.destroy();
    });
    return () => {
      void unP.then((f) => f());
    };
  }, [label]);

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
    // Dispose any listeners from a previous mount (project-keyed remount) so a
    // stale dock can't save the wrong project's layout (review P2-impl #4).
    for (const d of dockDisposablesRef.current) d.dispose();
    dockDisposablesRef.current = [
      api.onDidLayoutChange(() => {
        const p = useAppStore.getState().activeProject;
        if (p) useAppStore.getState().setPopoutLayout(label, p, api.toJSON());
      }),
      api.onDidRemovePanel((panel) => {
        // A transfer-out detaches (session survives); a real tab close ends it.
        if (isTransferring(panel.id)) return;
        void closePanelSession(panel.params as never);
      }),
    ];
    setApiReady(true);
  };

  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    const project = req.project ?? activeProject;
    if (req.kind === "claudeterm") {
      if (typeof req.ptyId === "number") {
        await invoke("claude_close", { id: req.ptyId }).catch(() => {});
      }
      if (deleteHistory && req.sessionId && project) {
        await invoke("claude_delete", { project, uuid: req.sessionId }).catch(() => {});
      }
    }
    apiRef.current?.getPanel(req.panelId)?.api.close();
  };

  return (
    <div className="popout-workbench" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
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
