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
import { WorktreePanel } from "./components/WorktreePanel";
import { MainArea } from "./components/MainArea";
import { FilePeekViewer } from "./components/FilePeekViewer";
import { CommitFilesSidebar } from "./components/CommitFilesSidebar";
import { CommitFileView } from "./components/CommitFileView";
import { TerminalSettings } from "./components/TerminalSettings";
import { StudyView } from "./components/StudyView";
import { PopoutWorkbench } from "./components/PopoutWorkbench";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows } from "@tauri-apps/api/window";
import { useAppStore } from "./state/store";
import "./App.css";

export default function App() {
  // A popped-out panel window loads the same frontend with the `#popout` hash
  // and renders only the minimal panel workbench (multiwindow).
  if (window.location.hash.startsWith("#popout")) return <PopoutWorkbench />;
  return <AppMain />;
}

function AppMain() {
  const init = useAppStore((s) => s.init);
  const initProjectSync = useAppStore((s) => s.initProjectSync);
  const activeProject = useAppStore((s) => s.activeProject);
  const peekFile = useAppStore((s) => s.peekFile);
  const setPeekFile = useAppStore((s) => s.setPeekFile);
  const gitHistory = useAppStore((s) => s.gitHistory);
  const gitHistoryFile = useAppStore((s) => s.gitHistoryFile);
  const closeGitHistoryFile = useAppStore((s) => s.closeGitHistoryFile);

  const treePanelRef = useRef<ImperativePanelHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [sideTab, setSideTab] = useState<"files" | "git" | "worktree">("files");
  const [termSettingsOpen, setTermSettingsOpen] = useState(false);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);

  useEffect(() => {
    void init();
  }, [init]);

  // Reopen popout windows that were open at the last quit (multiwindow P2). Runs
  // once on main-window startup; each reopened popout self-restores its layout
  // (its own init() loads the active project, onReady → getPopoutLayout) and the
  // panels recreate their sessions like the main window does. Genuinely-closed
  // popouts were dropped from popoutLayouts so they don't come back.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current) return;
    reopenedRef.current = true;
    const { popoutLayouts, popoutGeometry } = useAppStore.getState();
    const labels = Object.keys(popoutLayouts);
    if (labels.length === 0) return;
    void (async () => {
      let existing = new Set<string>();
      try {
        existing = new Set((await getAllWindows()).map((w) => w.label));
      } catch {
        /* enumerate failed — proceed; a duplicate label would just error out */
      }
      for (const label of labels) {
        if (existing.has(label)) continue;
        const geo = popoutGeometry[label];
        new WebviewWindow(label, {
          url: `${window.location.pathname}#popout=${label}`,
          title: "Workbench",
          width: geo?.width ?? 900,
          height: geo?.height ?? 640,
          ...(geo ? { x: geo.x, y: geo.y } : {}),
        });
      }
    })();
  }, []);

  // Follow cross-window project switches (multiwindow, review R0-4).
  useEffect(() => {
    let un: (() => void) | undefined;
    initProjectSync()
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, [initProjectSync]);

  // Apply + persist the color theme (dark default / light).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Apply + persist the code font size (CSS var drives CodeMirror; xterm reads it
  // from the store directly).
  useEffect(() => {
    document.documentElement.style.setProperty("--code-font-size", `${fontSize}px`);
    localStorage.setItem("fontSize", String(fontSize));
  }, [fontSize]);

  // Remember the last focused element OUTSIDE the tree (timeline list, terminal,
  // editor…), updated on every focus change — mouse click or keyboard — so Ctrl+B
  // returns to exactly where you were, however you got there.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === document.body) return;
      const tree = document.getElementById("folder-tree");
      if (tree && (t === tree || tree.contains(t))) return; // tree isn't a "return" target
      lastFocusRef.current = t;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Ctrl+B toggles between the folder tree and your last work spot: from the tree
  // it restores the remembered element (falling back to the active dockview panel
  // when there's none); from anywhere else it focuses the tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && (e.key === "b" || e.key === "B"))) return;
      e.preventDefault();
      const tree = document.getElementById("folder-tree");
      const treeFocused =
        !!tree && (tree === document.activeElement || tree.contains(document.activeElement));
      if (treeFocused) {
        const prev = lastFocusRef.current;
        if (prev && document.contains(prev) && !tree?.contains(prev)) prev.focus();
        else useAppStore.getState().requestFocusMain();
      } else {
        tree?.focus();
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
        <button
          className="toolbar-btn"
          title="라이트/다크 테마 전환"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "☀ 라이트" : "🌙 다크"}
        </button>
        <button className="toolbar-btn" title="폰트 작게" onClick={() => setFontSize(fontSize - 1)}>
          A−
        </button>
        <span className="toolbar-title" title="코드 폰트 크기">
          {fontSize}px
        </span>
        <button className="toolbar-btn" title="폰트 크게" onClick={() => setFontSize(fontSize + 1)}>
          A+
        </button>
        <button
          className="toolbar-btn"
          title="터미널 색상 커스텀"
          onClick={() => setTermSettingsOpen(true)}
        >
          터미널색
        </button>
        <button
          className="toolbar-btn"
          title="워크스페이스 ↔ 스터디 모드 전환"
          onClick={() => setMode(mode === "study" ? "workspace" : "study")}
        >
          {mode === "study" ? "워크스페이스" : "스터디"}
        </button>
        <span className="toolbar-title">
          {activeProject ?? "multi-terminal"}
        </span>
      </div>
      {mode === "study" ? (
        <StudyView />
      ) : (
        <PanelGroup direction="horizontal" className="panes">
        <Panel
          id="sidebar"
          order={1}
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
            <button
              className={`sidebar-tab${sideTab === "worktree" ? " active" : ""}`}
              onClick={() => setSideTab("worktree")}
            >
              워크트리
            </button>
          </div>
          <div className="sidebar-content">
            {sideTab === "files" ? (
              <>
                <div className="tree-hint">
                  <span>Ctrl+B 포커스 · ↑↓ 이동 · Enter 열기 · Ctrl+E 에디터</span>
                  <button
                    className="tree-refresh"
                    title="디스크에서 새로고침"
                    onClick={() => void useAppStore.getState().reloadActiveTree()}
                  >
                    ↻
                  </button>
                </div>
                <FolderTree />
              </>
            ) : sideTab === "git" ? (
              <GitPanel />
            ) : (
              <WorktreePanel />
            )}
          </div>
        </Panel>
        {gitHistory && (
          <>
            <PanelResizeHandle className="resize-handle" />
            <Panel
              id="commit-files"
              order={2}
              defaultSize={20}
              minSize={10}
              className="pane-commit-files"
            >
              <CommitFilesSidebar />
            </Panel>
          </>
        )}
        <PanelResizeHandle className="resize-handle" />
        <Panel id="main" order={3} defaultSize={60} minSize={30} className="pane-main">
          <MainArea />
          {peekFile && (
            <FilePeekViewer path={peekFile} onClose={() => setPeekFile(null)} />
          )}
          {gitHistoryFile && (
            <CommitFileView
              root={gitHistoryFile.root}
              commit={gitHistoryFile.commit}
              path={gitHistoryFile.path}
              onClose={closeGitHistoryFile}
            />
          )}
        </Panel>
        </PanelGroup>
      )}
      {termSettingsOpen && <TerminalSettings onClose={() => setTermSettingsOpen(false)} />}
    </div>
  );
}
