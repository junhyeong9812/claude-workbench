import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { StudySidebar } from "./StudySidebar";
import { StudyViewer } from "./StudyViewer";
import { StudySession } from "./StudySession";

/**
 * Study-view workspace mode (P1 — layout skeleton).
 *
 * Two folders side by side for comparison, each with its own sidebar + a
 * multi-tab viewer, over a single pinned Claude study session:
 *
 *   [좌 사이드바][좌 뷰어][우 뷰어][우 사이드바]   ← all resizable
 *   [        스터디 Claude 세션 + 타임라인        ]
 *
 * P1 lays out the resizable structure with placeholders; sidebars/viewers (P2)
 * and the study session (P3) fill in next.
 */
export function StudyView() {
  return (
    <PanelGroup direction="vertical" className="study-view">
      <Panel defaultSize={70} minSize={30}>
        <PanelGroup direction="horizontal" className="study-cols">
          <Panel defaultSize={18} minSize={8} className="study-col">
            <StudySidebar side="left" />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={32} minSize={15} className="study-col">
            <StudyViewer side="left" />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={32} minSize={15} className="study-col">
            <StudyViewer side="right" />
          </Panel>
          <PanelResizeHandle className="resize-handle" />
          <Panel defaultSize={18} minSize={8} className="study-col">
            <StudySidebar side="right" />
          </Panel>
        </PanelGroup>
      </Panel>
      <PanelResizeHandle className="resize-handle resize-handle-v" />
      <Panel defaultSize={30} minSize={10} className="study-col">
        <StudySession />
      </Panel>
    </PanelGroup>
  );
}
