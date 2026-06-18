import { useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ProjectTabs } from "./components/ProjectTabs";
import { FolderTree } from "./components/FolderTree";
import { useAppStore } from "./state/store";
import "./App.css";

export default function App() {
  const init = useAppStore((s) => s.init);
  const activeProject = useAppStore((s) => s.activeProject);

  const treePanelRef = useRef<ImperativePanelHandle>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const toggleTree = () => {
    const panel = treePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  };

  return (
    <div className="app">
      <ProjectTabs />
      <div className="toolbar">
        <button className="toolbar-btn" onClick={toggleTree}>
          {collapsed ? "Show tree" : "Hide tree"}
        </button>
        <span className="toolbar-title">
          {activeProject ?? "multi-terminal"}
        </span>
      </div>
      <PanelGroup direction="horizontal" className="panes">
        <Panel
          ref={treePanelRef}
          defaultSize={20}
          minSize={10}
          collapsible
          collapsedSize={0}
          onCollapse={() => setCollapsed(true)}
          onExpand={() => setCollapsed(false)}
          className="pane-left"
        >
          <FolderTree />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={80} minSize={30} className="pane-main">
          <div className="placeholder">
            <p>Main area placeholder</p>
            <p className="placeholder-sub">
              Terminal and editor arrive in later phases.
            </p>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
