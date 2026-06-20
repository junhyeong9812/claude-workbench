import { useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ProjectTabs } from "./components/ProjectTabs";
import { FolderTree } from "./components/FolderTree";
import { GitPanel } from "./components/GitPanel";
import { MainArea } from "./components/MainArea";
import { FilePeekViewer } from "./components/FilePeekViewer";
import { useAppStore } from "./state/store";
import "./App.css";

export default function App() {
  const init = useAppStore((s) => s.init);
  const activeProject = useAppStore((s) => s.activeProject);
  const peekFile = useAppStore((s) => s.peekFile);
  const setPeekFile = useAppStore((s) => s.setPeekFile);

  const treePanelRef = useRef<ImperativePanelHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [sideTab, setSideTab] = useState<"files" | "git">("files");

  useEffect(() => {
    void init();
  }, [init]);

  // Ctrl+B focuses the folder tree (so keyboard nav can start without a click).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        document.getElementById("folder-tree")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab${sideTab === "files" ? " active" : ""}`}
              onClick={() => setSideTab("files")}
            >
              파일
            </button>
            <button
              className={`sidebar-tab${sideTab === "git" ? " active" : ""}`}
              onClick={() => setSideTab("git")}
            >
              Git
            </button>
          </div>
          <div className="sidebar-content">
            {sideTab === "files" ? (
              <>
                <div className="tree-hint">
                  Ctrl+B 포커스 · ↑↓ 이동 · Enter 열기 · Ctrl+E 에디터 · Esc 닫기
                </div>
                <FolderTree />
              </>
            ) : (
              <GitPanel />
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={80} minSize={30} className="pane-main">
          <MainArea />
          {peekFile && (
            <FilePeekViewer path={peekFile} onClose={() => setPeekFile(null)} />
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
