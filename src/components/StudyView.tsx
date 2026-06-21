import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { StudySidebar } from "./StudySidebar";
import { StudyViewer } from "./StudyViewer";
import { StudySession } from "./StudySession";
import { useAppStore } from "../state/store";

/** Focusable element ids for the four study columns, left→right. Ctrl+←/→ moves
 * focus across them (mouse-free). */
const FOCUS_IDS = ["study-focus-0", "study-focus-1", "study-focus-2", "study-focus-3"];

/**
 * Study-view workspace mode: two folders side by side, each with a sidebar +
 * multi-tab viewer, over a single pinned Claude study session.
 *
 *   [좌 사이드바][좌 뷰어][우 뷰어][우 사이드바]   ← all resizable
 *   [        스터디 Claude 세션 + 타임라인        ]
 *
 * Keyboard: Ctrl+←/→ moves between the four columns (here); each column then has
 * its own keys (tree ↑↓/Enter, viewer Alt+←/→ tabs).
 */
export function StudyView() {
  // Ctrl+←/→ moves focus across the four columns; Alt+←/→ cycles the focused
  // side's viewer tabs (works from the sidebar too — codex SF-5). No-op if focus
  // is elsewhere (e.g. the study session, which keeps its own pane navigation).
  const onKeyDown = (e: React.KeyboardEvent) => {
    const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (!isArrow || (!e.ctrlKey && !e.altKey)) return;
    const ae = document.activeElement;
    const cur = FOCUS_IDS.findIndex((id) => {
      const el = document.getElementById(id);
      return !!el && (el === ae || el.contains(ae));
    });
    if (cur === -1) return;
    e.preventDefault();
    if (e.ctrlKey) {
      const ni = e.key === "ArrowRight" ? Math.min(cur + 1, 3) : Math.max(cur - 1, 0);
      document.getElementById(FOCUS_IDS[ni])?.focus();
    } else {
      const side = cur < 2 ? "left" : "right";
      useAppStore.getState().cycleStudyTab(side, e.key === "ArrowRight" ? 1 : -1);
    }
  };

  return (
    <div className="study-view-root" onKeyDown={onKeyDown}>
      <PanelGroup direction="vertical" className="study-view" autoSaveId="study-vert">
        <Panel defaultSize={70} minSize={30}>
          <PanelGroup direction="horizontal" className="study-cols" autoSaveId="study-cols">
            <Panel defaultSize={18} minSize={8} className="study-col">
              <StudySidebar side="left" focusId={FOCUS_IDS[0]} />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={32} minSize={15} className="study-col">
              <StudyViewer side="left" focusId={FOCUS_IDS[1]} />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={32} minSize={15} className="study-col">
              <StudyViewer side="right" focusId={FOCUS_IDS[2]} />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={18} minSize={8} className="study-col">
              <StudySidebar side="right" focusId={FOCUS_IDS[3]} />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="resize-handle resize-handle-v" />
        <Panel defaultSize={30} minSize={10} className="study-col">
          <StudySession />
        </Panel>
      </PanelGroup>
    </div>
  );
}
