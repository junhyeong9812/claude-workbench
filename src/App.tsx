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
import { ArchivePanel } from "./components/ArchivePanel";
import { GraphPanel } from "./components/GraphPanel";
import { MainArea } from "./components/MainArea";
import { DevView } from "./components/DevView";
import { FilePeekViewer } from "./components/FilePeekViewer";
import { CommitFilesSidebar } from "./components/CommitFilesSidebar";
import { CommitFileView } from "./components/CommitFileView";
import { TerminalSettings } from "./components/TerminalSettings";
import { SearchPanel } from "./components/SearchPanel";
import { RunMenu } from "./components/RunMenu";
import { StudyView } from "./components/StudyView";
import { PopoutWorkbench } from "./components/PopoutWorkbench";
import { DropZoneWindow } from "./components/DropZoneWindow";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows } from "@tauri-apps/api/window";
import { useAppStore } from "./state/store";
import {
  useClaudeStatus,
  attentionUuids,
  nextCycleTarget,
  shouldShowRollup,
} from "./state/claudeStatus";
import { initClaudeStatusGlobal } from "./state/claudeStatusGlobal";
import { initNotify } from "./state/notify";
import { resolveLayerMode, devLayerMounted, shouldFlipToIntegrated } from "./state/layerRouting";
import "./App.css";

/**
 * Toolbar attention roll-up (agent-status-badges P3): a compact `●n` for the
 * sessions currently needing attention — red for blocked, blue for done-unseen.
 * Nothing renders when both are zero. Clicking a group cycles activation through
 * that group's session tabs (in this window's dock; another window's session is a
 * no-op, a documented roll-up limitation). Idle/working never count.
 */
function ToolbarRollup() {
  const entries = useClaudeStatus((s) => s.entries);
  // The dock-active Claude panel is the cycle cursor (S12): clicking a group
  // steps to the session *after* whatever you're currently on, so the cycle
  // advances relative to the real active tab (not a private "last click" ref that
  // drifts when you navigate by other means). Not in the group → restart at its
  // first member (nextCycleTarget handles an absent/foreign current).
  const activeClaudeUuid = useClaudeStatus((s) => s.activeClaudeUuid);
  const requestFocusSession = useAppStore((s) => s.requestFocusSession);
  const { blocked, doneUnseen } = attentionUuids(entries);
  const counts = { blocked: blocked.length, doneUnseen: doneUnseen.length };
  if (!shouldShowRollup(counts)) return null;
  const cycle = (uuids: string[]) => {
    const next = nextCycleTarget(uuids, activeClaudeUuid);
    if (next) requestFocusSession(next);
  };
  return (
    <div className="toolbar-rollup" role="group" aria-label="주의가 필요한 세션">
      {counts.blocked > 0 && (
        <button
          className="toolbar-rollup-item is-blocked"
          title={`입력 대기 중인 세션 ${counts.blocked}개 — 클릭해 차례로 이동`}
          onClick={() => cycle(blocked)}
        >
          <span className="toolbar-rollup-dot" />
          {counts.blocked}
        </button>
      )}
      {counts.doneUnseen > 0 && (
        <button
          className="toolbar-rollup-item is-done"
          title={`완료(미확인) 세션 ${counts.doneUnseen}개 — 클릭해 차례로 이동`}
          onClick={() => cycle(doneUnseen)}
        >
          <span className="toolbar-rollup-dot" />
          {counts.doneUnseen}
        </button>
      )}
    </div>
  );
}

export default function App() {
  // A popped-out panel window loads the same frontend with the `#popout` hash
  // and renders only the minimal panel workbench (multiwindow).
  if (window.location.hash.startsWith("#popout")) return <PopoutWorkbench />;
  // OS 파일 반입 드롭 존 보조 창 (파일트리 "파일 가져오기") — 이 창만
  // dragDropEnabled:true로 열린다.
  if (window.location.hash.startsWith("#dropzone=")) return <DropZoneWindow />;
  return <AppMain />;
}

function AppMain() {
  const init = useAppStore((s) => s.init);
  const initProjectSync = useAppStore((s) => s.initProjectSync);
  const activeProject = useAppStore((s) => s.activeProject);
  const peekFile = useAppStore((s) => s.peekFile);
  const peekLine = useAppStore((s) => s.peekLine);
  const setPeekFile = useAppStore((s) => s.setPeekFile);
  const [searchOpen, setSearchOpen] = useState(false);
  const gitHistory = useAppStore((s) => s.gitHistory);
  const gitHistoryFile = useAppStore((s) => s.gitHistoryFile);
  const closeGitHistoryFile = useAppStore((s) => s.closeGitHistoryFile);

  const treePanelRef = useRef<ImperativePanelHandle>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [sideTab, setSideTab] = useState<"files" | "git" | "worktree" | "archive" | "graph">(
    "files",
  );
  const [termSettingsOpen, setTermSettingsOpen] = useState(false);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const projectModes = useAppStore((s) => s.projectModes);
  const setProjectMode = useAppStore((s) => s.setProjectMode);

  // Which main-area layer is in front for the active project.
  const layerMode = resolveLayerMode(projectModes, activeProject);
  // Dev-layer mount latch for the CURRENT active project: has it entered dev this
  // active period? Stored as the single project that has (`visitedProject`), and
  // read as a render-time boolean scoped to the active project — so switching to a
  // never-dev project reads false immediately (no stale-latch window that could
  // spuriously mount a dev PTY for it). Non-persistent, and it does NOT govern
  // restart: a persisted projectModes="dev" still mounts via the mode path in
  // devLayerMounted, the intentional dev-session resume. DevView is keyed by
  // project, so nothing is preserved across a switch anyway.
  const [visitedProject, setVisitedProject] = useState<string | null>(null);
  // Actually RELEASE the latch when the active project changes away from the
  // visited one — otherwise returning to it later (in integrated mode) would
  // remount its DevView and spin the dev PTY back up in the background.
  // Adjust-state-during-render (no stale frame: React restarts this render
  // immediately), instead of an effect whose reset lands a frame late.
  const prevProjectRef = useRef(activeProject);
  if (prevProjectRef.current !== activeProject) {
    prevProjectRef.current = activeProject;
    if (visitedProject !== null && visitedProject !== activeProject) setVisitedProject(null);
  }
  const devVisited = !!activeProject && visitedProject === activeProject;
  useEffect(() => {
    if (activeProject && layerMode === "dev" && visitedProject !== activeProject) {
      setVisitedProject(activeProject);
    }
  }, [activeProject, layerMode, visitedProject]);
  const devMounted = !!activeProject && devLayerMounted(layerMode, devVisited);

  // Symmetric auto-flip (B4): while the dev layer is in front, a VIEW-ROW request
  // (diff·claudeOpen·run) for the ACTIVE project would otherwise open behind the
  // dev layer (invisible). Flip that project back to integrated so the front
  // integrated consumer renders it immediately (the consumers re-evaluate on the
  // layerMode change). A request for a different project stays pending for its own
  // consumer. devReview is a SESSION-ROW request and is intentionally NOT flipped
  // (DevView consumes it whether front or hidden — layerRouting docstring).
  const diffRequest = useAppStore((s) => s.diffRequest);
  const claudeOpenRequest = useAppStore((s) => s.claudeOpenRequest);
  const runRequest = useAppStore((s) => s.runRequest);
  useEffect(() => {
    if (layerMode !== "dev" || !activeProject) return;
    const flip = () => useAppStore.getState().setProjectMode(activeProject, "integrated");
    if (shouldFlipToIntegrated(layerMode, diffRequest?.cwd, activeProject)) return flip();
    if (shouldFlipToIntegrated(layerMode, claudeOpenRequest?.project, activeProject)) return flip();
    if (shouldFlipToIntegrated(layerMode, runRequest?.project, activeProject)) return flip();
  }, [diffRequest, claudeOpenRequest, runRequest, layerMode, activeProject]);

  useEffect(() => {
    void init();
  }, [init]);

  // App-level attention listener (P3): keeps every session's badge updating even
  // while its panel is a backgrounded (unmounted) tab. Module-guarded to once per
  // window, so this is the single init point for the main window.
  useEffect(() => initClaudeStatusGlobal(), []);

  // Attention notifications + tones (P4): subscribe to the status store and fire
  // an OS notification / tone on a session's rising edge into blocked/done-unseen
  // (best-effort, suppressed while watching). Idempotent per window.
  useEffect(() => initNotify(), []);

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

  // Ctrl+F opens the project-wide search overlay (file name / content). Needs an
  // active project to search under.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && (e.key === "f" || e.key === "F")) || e.shiftKey) return;
      e.preventDefault();
      if (useAppStore.getState().activeProject) setSearchOpen(true);
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
        {mode === "workspace" && activeProject && (
          <button
            className={`toolbar-btn${projectModes[activeProject] === "dev" ? " toolbar-btn-on" : ""}`}
            title="현재 프로젝트의 통합 ↔ 개발 모드 전환 — 개발 모드에서는 트리 파일이 에디터 탭+개발 세션(우측) 레이아웃으로 열립니다"
            onClick={() =>
              setProjectMode(
                activeProject,
                projectModes[activeProject] === "dev" ? "integrated" : "dev",
              )
            }
          >
            {projectModes[activeProject] === "dev" ? "개발" : "통합"}
          </button>
        )}
        <ToolbarRollup />
        <RunMenu />
        <span className="toolbar-title">
          {activeProject ?? "claude-workbench"}
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
            <button
              className={`sidebar-tab${sideTab === "archive" ? " active" : ""}`}
              onClick={() => setSideTab("archive")}
            >
              아카이브
            </button>
            <button
              className={`sidebar-tab${sideTab === "graph" ? " active" : ""}`}
              onClick={() => setSideTab("graph")}
            >
              그래프
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
            ) : sideTab === "worktree" ? (
              <WorktreePanel />
            ) : sideTab === "archive" ? (
              <ArchivePanel />
            ) : (
              <GraphPanel />
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
          {/* Both layers stay mounted; the front/back swap is z-index +
              visibility (not conditional render) so toggling modes preserves
              each view's terminal scrollback and editor tabs (불변식 ②). The
              back layer is visibility:hidden — display:none would zero xterm's
              measured size. DevView only mounts once its project has entered dev
              (mount latch, 불변식 ④). */}
          <div className={`main-layer${layerMode === "dev" ? " main-layer-back" : ""}`}>
            <MainArea />
          </div>
          {devMounted && activeProject && (
            <div className={`main-layer${layerMode === "dev" ? "" : " main-layer-back"}`}>
              {/* keyed by project so switching projects resets its tabs. */}
              <DevView key={activeProject} project={activeProject} />
            </div>
          )}
          {peekFile && (
            <FilePeekViewer
              path={peekFile}
              line={peekLine ?? undefined}
              onClose={() => setPeekFile(null)}
            />
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
      {searchOpen && activeProject && (
        <SearchPanel
          root={activeProject}
          onClose={() => setSearchOpen(false)}
          onOpen={(path, line) => {
            setPeekFile(path, line);
            setSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}
