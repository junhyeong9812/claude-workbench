import { useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useAppStore } from "../state/store";
import { components, AppTab } from "./panelRegistry";

/**
 * The root of a popped-out panel window (rendered when the URL hash is
 * `#popout`). A minimal workbench: a thin toolbar showing the (cross-window
 * synced) active project + theme, over a dockview that holds only the panels
 * transferred into this window (P2). Unlike the main window, this dockview is
 * NOT keyed by the active project — it is a free panel container, so switching
 * the shared project never wipes transferred panels (P1 decision; the deeper
 * "should a project switch swap popout panels too?" question is settled in P2).
 *
 * Project + theme come from the same store: on boot we `init()` (loads the
 * workspace from the backend) and subscribe to cross-window project sync
 * (review R0-4) so this window follows the active project.
 */
export function PopoutWorkbench() {
  const init = useAppStore((s) => s.init);
  const initProjectSync = useAppStore((s) => s.initProjectSync);
  const activeProject = useAppStore((s) => s.activeProject);
  const theme = useAppStore((s) => s.theme);
  const apiRef = useRef<DockviewApi | null>(null);

  // Load the workspace (for the synced active project) + follow cross-window
  // project switches. Same wiring as the main window (review R0-4).
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

  // Apply the (shared-localStorage) theme to this window's document.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // P2 will use this api (via a window-targeted event) to add the transferred
    // panel. For P1 the dock starts — and stays — empty.
  };

  return (
    <div className="popout-workbench" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div className="toolbar">
        <span className="toolbar-title" title="공유 활성 프로젝트">
          🪟 {activeProject ?? "(프로젝트 없음)"}
        </span>
      </div>
      <DockviewReact
        className={`dockview-theme-${theme === "light" ? "light" : "dark"} main-dock`}
        components={components}
        defaultTabComponent={AppTab}
        onReady={onReady}
      />
    </div>
  );
}
