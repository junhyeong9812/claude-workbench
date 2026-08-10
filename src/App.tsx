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
import { TermSettingsButton, TermSettingsLayer } from "./components/TermSettingsButton";
import { SearchPanel } from "./components/SearchPanel";
import { RunMenu } from "./components/RunMenu";
import { AgentOptionsPopover } from "./components/AgentOptionsPopover";
import { spawnOptionFields } from "./state/agentOptions";
import { StudyView } from "./components/StudyView";
import { PopoutWorkbench } from "./components/PopoutWorkbench";
import { DropZoneWindow } from "./components/DropZoneWindow";
import {
  classifyDrops,
  decodeStrict,
  DROP_MAX_BYTES,
  DROP_MAX_FILES,
  type DroppedFileView,
} from "./components/droppedFiles";
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
import { resolveVisibleDual } from "./state/dualSurface";
import { SurfaceProvider } from "./state/surfaceContext";
import {
  applyActivityPick,
  applyTabPick,
  ctrlBAction,
  loadSidebarView,
  mountedTabs,
  saveSidebarView,
  toggleSplit,
  type SidebarHalf,
  type SidebarTab,
  type SidebarView,
} from "./state/sidebarView";
import "./App.css";

/** 사이드바 탭 5종의 표시 메타 — 액티비티 바와 반쪽 헤더 seg가 공유한다. */
const SIDE_TABS = [
  { key: "files", ico: "🗂", label: "파일" },
  { key: "git", ico: "⎇", label: "Git" },
  { key: "worktree", ico: "🌿", label: "워크트리" },
  { key: "archive", ico: "📦", label: "아카이브" },
  { key: "graph", ico: "◉", label: "그래프" },
] as const satisfies readonly { key: SidebarTab; ico: string; label: string }[];

/** 사이드바 탭 하나의 본문 — 분할 ON/OFF가 같은 렌더를 공유한다. */
function SidebarTabBody({ tab }: { tab: SidebarTab }) {
  if (tab === "files") return <FolderTree />;
  if (tab === "git") return <GitPanel />;
  if (tab === "worktree") return <WorktreePanel />;
  if (tab === "archive") return <ArchivePanel />;
  return <GraphPanel />;
}

/**
 * 분할 ON일 때의 반쪽 하나: 미니 아이콘 seg 헤더(탭 선택 — 상대 반쪽과 겹치면
 * 스왑) + 본문. files 반쪽에는 기존 ↻(새로고침)를 seg 우측에 병치한다.
 * 반쪽 개별 접기는 없다(접기는 전체 단위 — 설계 §A-4).
 */
function SidebarHalfHead({
  half,
  tab,
  otherTab,
  onPick,
}: {
  half: SidebarHalf;
  tab: SidebarTab;
  /** 상대 반쪽의 현재 탭 — 선택 시 스왑됨을 title로 예고(리뷰 a11y). */
  otherTab: SidebarTab;
  onPick: (t: SidebarTab) => void;
}) {
  const halfLabel = half === "top" ? "위쪽 칸" : "아래쪽 칸";
  return (
    <div className="sidebar-half-head">
      {/* aria-pressed 토글 버튼 묶음(.seg idiom) — tablist가 아니다(액티비티
          바와 같은 이유: tabpanel/roving tabindex 계약을 만족하지 않는다). */}
      <div className="seg sidebar-seg" role="group" aria-label={`${halfLabel}에 표시할 탭`}>
        {SIDE_TABS.map((t) => (
          <button
            key={t.key}
            className={`seg-item sidebar-seg-item${tab === t.key ? " seg-on" : ""}`}
            aria-pressed={tab === t.key}
            aria-label={t.label}
            title={t.key === otherTab ? `${t.label} — 위아래 맞바꾸기` : t.label}
            onClick={() => onPick(t.key)}
          >
            <span aria-hidden="true">{t.ico}</span>
          </button>
        ))}
      </div>
      {tab === "files" && (
        <button
          className="tree-refresh"
          title="디스크에서 새로고침"
          onClick={() => void useAppStore.getState().reloadActiveTree()}
        >
          ↻
        </button>
      )}
    </div>
  );
}

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
  // project-dual-surface: 우측 분할에 열린 프로젝트.
  const projects = useAppStore((s) => s.projects);
  const dualProject = useAppStore((s) => s.dualProject);
  const setDualProject = useAppStore((s) => s.setDualProject);
  // **렌더는 파생값으로 그린다** (리뷰 D1): 이펙트(커밋 후) 정리에만 맡기면
  // setActive 직후 1프레임 동안 같은 프로젝트 dock 두 개가 공존한다. 파생값은
  // 동일 프로젝트·비멤버십(닫힘/hydration 전)을 렌더 시점에 즉시 숨긴다.
  const visibleDual = resolveVisibleDual(
    dualProject,
    activeProject,
    projects.map((p) => p.path),
  );
  // 이펙트는 persist 정리만: ① 동일 프로젝트로 전환되면 dual 해제 ② 닫힌
  // 프로젝트 정리(hydration 전 오판 방지로 목록이 채워진 뒤에만).
  useEffect(() => {
    if (dualProject && dualProject === activeProject) setDualProject(null);
  }, [dualProject, activeProject, setDualProject]);
  useEffect(() => {
    if (dualProject && projects.length > 0 && !projects.some((p) => p.path === dualProject)) {
      setDualProject(null);
    }
  }, [dualProject, projects, setDualProject]);
  // 작업 영역에 드롭된 OS 파일들의 메모리 뷰 (workarea-drop-view — 완전 읽기
  // 전용, 디스크에 아무것도 쓰지 않음). 첫 파일 활성 + 탭 전환.
  const [droppedPeek, setDroppedPeek] = useState<{
    files: DroppedFileView[];
    active: number;
  } | null>(null);
  // 드롭 처리 직렬화 — 연속 드롭이 겹쳐 절반 상태를 만들지 않게.
  const dropBusyRef = useRef(false);

  // P3: droppedPeek 이미지의 objectURL 수명 관리 — 뷰가 교체/닫힐 때 이전
  // URL들을 revoke(누수 방지). 표시 중 URL은 절대 revoke하지 않는다(집합
  // 차이만 해제 — 조기 revoke 금지 불변식).
  const droppedUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    const current = (droppedPeek?.files ?? [])
      .map((f) => f.imageUrl)
      .filter((u): u is string => !!u && u.startsWith("blob:"));
    for (const u of droppedUrlsRef.current) {
      if (!current.includes(u)) URL.revokeObjectURL(u);
    }
    droppedUrlsRef.current = current;
  }, [droppedPeek]);
  // 언마운트(팝아웃 창 닫힘 등) 시 잔여 revoke — 위 diff effect에 cleanup을
  // 달면 매 실행 전에 표시 중 URL을 조기 revoke하므로 mount-only로 분리(리뷰).
  useEffect(
    () => () => {
      for (const u of droppedUrlsRef.current) URL.revokeObjectURL(u);
      droppedUrlsRef.current = [];
    },
    [],
  );

  // 상호 배타(리뷰 W5): 경로 peek이 어떤 경로(트리 클릭·검색 점프)로든 열리면
  // 드롭 peek을 닫는다 — 오버레이 이중 적층 방지. (역방향은 드롭 처리부의
  // setPeekFile(null)이 담당.)
  useEffect(() => {
    if (peekFile != null) setDroppedPeek(null);
  }, [peekFile]);

  // ①전역 네비게이션 가드: OS 파일 드래그가 앱 어디에 떨어져도 웹뷰가 그
  // 파일로 이동해버리는 기본 동작을 막는다. `Files` 타입에만 개입 — 앱 내부
  // HTML5 드래그(트리 DnD·탭 정렬·창 분리)는 Files가 없어 무관 (spec §2).
  // ②작업 영역(.pane-main) 드롭 수집: 내용을 읽어 peek 뷰어로 연다.
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const guard = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const pane = document.querySelector(".pane-main");
      if (!pane || !(e.target instanceof Node) || !pane.contains(e.target)) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (dropBusyRef.current) {
        alert("이전 드롭을 처리하는 중입니다 — 잠시 후 다시 시도하세요."); // 무음 폐기 금지 (리뷰 W3)
        return;
      }
      dropBusyRef.current = true;
      void (async () => {
        try {
          const plans = classifyDrops(files.map((f) => ({ name: f.name, size: f.size })));
          const notes: string[] = [];
          const loaded: DroppedFileView[] = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const kind = plans[i].kind;
            if (kind === "too-large") {
              notes.push(`${f.name}: ${DROP_MAX_BYTES / 1024 / 1024}MB 초과 — 건너뜀`);
              continue;
            }
            if (kind === "over-limit") {
              notes.push(`${f.name}: 한 번에 최대 ${DROP_MAX_FILES}개 — 건너뜀`);
              continue;
            }
            try {
              if (kind === "image") {
                // P3: base64 data URL(파일 크기 ×1.33이 상태에 상주 — 최대
                // 수십 MB) 대신 objectURL — Blob은 브라우저가 관리, 뷰가
                // 바뀔 때 revoke(아래 effect)로 즉시 해제.
                loaded.push({ name: f.name, imageUrl: URL.createObjectURL(f) });
              } else {
                // 엄격 디코드 — File.text()는 바이너리도 조용히 치환해버린다 (리뷰 W1).
                const text = decodeStrict(await f.arrayBuffer());
                if (text == null) {
                  notes.push(`${f.name}: 텍스트로 표시할 수 없는 파일 — 건너뜀`);
                  continue;
                }
                loaded.push({ name: f.name, text });
              }
            } catch {
              notes.push(`${f.name}: 읽기 실패`);
            }
          }
          if (loaded.length > 0) {
            useAppStore.getState().setPeekFile(null); // 경로 기반 peek과 겹치지 않게
            setDroppedPeek({ files: loaded, active: 0 });
          }
          if (notes.length > 0) alert(notes.join("\n"));
        } finally {
          dropBusyRef.current = false; // 예기치 못한 throw에도 영구 잠금 금지 (리뷰 W3)
        }
      })();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  // 사이드바 뷰(분할 여부 + 탭 3종) — 규칙·검증 파서는 state/sidebarView.ts,
  // 비율은 PanelGroup autoSaveId="sidebar-vert"가 담당한다.
  const [sidebarView, setSidebarView] = useState<SidebarView>(loadSidebarView);
  useEffect(() => saveSidebarView(sidebarView), [sidebarView]);
  // 액티비티 바가 가리키는 탭: 분할 OFF면 단일 탭, ON이면 위쪽 반쪽.
  const activeSideTab = sidebarView.split ? sidebarView.topTab : sidebarView.tab;
  // Ctrl+B 핸들러([] deps effect)가 최신 분할 상태를 읽도록 ref 미러.
  const sidebarViewRef = useRef(sidebarView);
  sidebarViewRef.current = sidebarView;
  const pickHalfTab = (half: SidebarHalf, tab: SidebarTab) =>
    setSidebarView((v) => applyTabPick(v, half, tab));
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
    // 재오픈 대상 열거 전에 고아 geometry(레이아웃 없는 라벨) 정리 — P5 F-h.
    useAppStore.getState().pruneOrphanPopoutGeometry();
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

  // Remember the last focused element OUTSIDE the sidebar (timeline list,
  // terminal, editor…), updated on every focus change — mouse click or keyboard —
  // so Ctrl+B returns to exactly where you were, however you got there. 사이드바
  // 전체를 제외한다: 접히는 순간 그 안의 요소는 복귀 대상이 될 수 없다(분할
  // 이후로는 트리 말고도 사이드바 안 포커스 가능 요소가 여럿이다).
  const lastFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === document.body) return;
      if (t.closest(".pane-left")) return; // 사이드바는 "복귀" 대상이 아니다
      lastFocusRef.current = t;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Ctrl+B = 사이드바 접기/펴기 — **어떤 탭이 떠 있든 항상** 동작한다(설계
  // §A-6). 이전에는 트리가 마운트된 files 탭에서만 의미가 있어 git·아카이브
  // 탭에서는 아무 일도 일어나지 않았다(조사 결함 ①). 펼칠 때 트리가 있으면
  // 그리로 포커스, 접을 때 포커스가 사이드바 안이었다면 마지막 작업 지점으로
  // 되돌린다(접힌 패널 안에 포커스가 갇히지 않게).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && (e.key === "b" || e.key === "B"))) return;
      e.preventDefault();
      const panel = treePanelRef.current;
      if (!panel) return;
      const sidebar = document.querySelector(".pane-left");
      const action = ctrlBAction(
        panel.isCollapsed(),
        !!sidebar && sidebar.contains(document.activeElement),
        mountedTabs(sidebarViewRef.current).includes("files"),
      );
      if (action.kind === "expand") {
        panel.expand();
        // 펼침이 반영된 뒤에 포커스 — 트리가 보이는 반쪽에 없으면 이동 생략.
        requestAnimationFrame(() => document.getElementById("folder-tree")?.focus());
        return;
      }
      if (action.kind === "focusTree") {
        // 하이브리드(리뷰): 펼쳐져 있고 트리가 보이면 구 동작(트리로 진입).
        document.getElementById("folder-tree")?.focus();
        return;
      }
      panel.collapse();
      if (!action.restoreFocus) return;
      const prev = lastFocusRef.current;
      if (prev && document.contains(prev) && !sidebar?.contains(prev)) prev.focus();
      else useAppStore.getState().requestFocusMain();
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

  // Activity-bar tab click (IntelliJ-style left stripe): clicking the active
  // tab folds the sidebar; clicking any tab while folded unfolds onto it.
  // 분할 ON일 때는 **위쪽 반쪽**을 제어한다(설계 §A-3) — 상대 반쪽과 겹치는
  // 선택은 applyActivityPick이 스왑으로 흡수하므로 같은 탭 2개가 될 수 없다.
  const activityClick = (tab: SidebarTab) => {
    if (activeSideTab === tab && !collapsed) {
      treePanelRef.current?.collapse();
      return;
    }
    setSidebarView((v) => applyActivityPick(v, tab));
    if (collapsed) treePanelRef.current?.expand();
  };

  // The 3-way view mode the segment control shows: 스터디(app-global) vs the
  // active project's 통합/개발 flavor. Selecting 통합/개발 also leaves study.
  const segMode: "study" | "integrated" | "dev" =
    mode === "study" ? "study" : layerMode === "dev" ? "dev" : "integrated";
  const pickSegMode = (v: "study" | "integrated" | "dev") => {
    if (v === "study") {
      setMode("study");
      return;
    }
    if (mode !== "workspace") setMode("workspace");
    if (activeProject) setProjectMode(activeProject, v === "dev" ? "dev" : "integrated");
  };

  // 테마 팝오버 (테마 + 글자 크기) — outside-click closes it. 터미널 색상은
  // T3에서 터미널 탭 안의 ⚙(TermSettingsButton)로 옮겼다. 내부 식별자는
  // `appearance*` 그대로 둔다 — CSS 클래스(.appearance-*)와 짝이고, 라벨만
  // 바뀐 것에 파일 전체 rename을 얹으면 diff가 이유 없이 넓어진다.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const appearanceBtnRef = useRef<HTMLButtonElement>(null);
  const appearancePopRef = useRef<HTMLDivElement>(null);
  // 열릴 때 1회만 다이얼로그로 포커스 이동 (A10 감사 보완). 콜백 ref로 하면
  // 매 렌더 재실행되어 인풋 타이핑 중 포커스를 훔친다.
  useEffect(() => {
    if (appearanceOpen) appearancePopRef.current?.focus();
  }, [appearanceOpen]);
  useEffect(() => {
    if (!appearanceOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (appearanceRef.current && !appearanceRef.current.contains(e.target as Node)) {
        setAppearanceOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [appearanceOpen]);
  // Font-size input draft: null follows the store; committed on Enter/blur.
  // Only a plain integer commits — empty/whitespace/hex/decimal drafts revert
  // to the previous value (review A1: Number("") is 0, not NaN, so an
  // isFinite check alone would silently clamp an emptied input to 9px).
  const [fontDraft, setFontDraft] = useState<string | null>(null);
  const commitFontDraft = () => {
    if (fontDraft === null) return;
    const t = fontDraft.trim();
    if (/^\d+$/.test(t)) setFontSize(Number(t));
    setFontDraft(null);
  };

  // 새 세션 옵션 팝오버(툴바 ▾). 바깥 클릭·Escape·포커스 복원은 팝오버가 소유한다
  // (호출자 2곳이 각자 들고 있으면 갈라진다) — 여기서는 열림 상태와 트리거 ref만.
  const [agentOptsOpen, setAgentOptsOpen] = useState(false);
  const agentOptsBtnRef = useRef<HTMLButtonElement>(null);

  const requestTermMenu = useAppStore((s) => s.requestTermMenu);
  const requestClaudePicker = useAppStore((s) => s.requestClaudePicker);
  const requestClaudeOpen = useAppStore((s) => s.requestClaudeOpen);
  const requestCodexOpen = useAppStore((s) => s.requestCodexOpen);
  const requestDetachPanel = useAppStore((s) => s.requestDetachPanel);
  const requestMemo = useAppStore((s) => s.requestMemo);

  return (
    <div className="app">
      <ProjectTabs />
      <div className="toolbar">
        <div className="seg" role="group" aria-label="화면 모드">
          <button
            className={`seg-item${segMode === "study" ? " seg-on" : ""}`}
            aria-pressed={segMode === "study"}
            title="스터디 모드 — 두 폴더 나란히 읽기/학습"
            onClick={() => pickSegMode("study")}
          >
            스터디
          </button>
          <button
            className={`seg-item${segMode === "integrated" ? " seg-on" : ""}`}
            aria-pressed={segMode === "integrated"}
            title="통합 모드 — 기본 워크스페이스"
            onClick={() => pickSegMode("integrated")}
          >
            통합
          </button>
          <button
            className={`seg-item${segMode === "dev" ? " seg-on" : ""}`}
            aria-pressed={segMode === "dev"}
            title={
              activeProject
                ? "개발 모드 — 트리 파일이 에디터 탭+개발 세션(우측) 레이아웃으로 열립니다 (현재 프로젝트에만 적용)"
                : "개발 모드는 프로젝트를 연 뒤 선택할 수 있습니다"
            }
            disabled={!activeProject}
            onClick={() => pickSegMode("dev")}
          >
            개발
          </button>
        </div>
        {mode === "workspace" && (
          <div className="toolbar-group" role="group" aria-label="세션/실행">
            {/* 세 버튼 모두 dev 레이어에서는 disabled — 변경 전에도 이 버튼들은
                통합 레이어 안에 있어 dev 모드에선 접근 불가였다(동작 보존, 리뷰
                A3: 소비자가 projectModes를 조용히 플립하지 않는다). */}
            <button
              className="toolbar-btn"
              title={
                layerMode === "dev"
                  ? "터미널 열기는 통합 모드에서 사용할 수 있습니다"
                  : "터미널/SSH 세션 열기"
              }
              disabled={layerMode === "dev"}
              onClick={() => requestTermMenu()}
            >
              <span className="toolbar-ico">▣</span> 터미널 <span className="toolbar-caret">▾</span>
            </button>
            <div className="agent-opt-menu">
              <button
                className="toolbar-btn"
                title={
                  layerMode === "dev"
                    ? "에이전트 세션 열기는 통합 모드에서 사용할 수 있습니다"
                    : "에이전트 세션 열기 (새 세션 또는 저장된 세션)"
                }
                disabled={layerMode === "dev"}
                onClick={() => requestClaudePicker()}
              >
                <span className="toolbar-ico">✦</span> 에이전트
              </button>
              <button
                ref={agentOptsBtnRef}
                className={`toolbar-btn${agentOptsOpen ? " toolbar-btn-on" : ""}`}
                title={
                  layerMode === "dev"
                    ? "세션 옵션은 통합 모드에서 사용할 수 있습니다"
                    : "새 세션 옵션 — 에이전트 · 모델 · 강도"
                }
                aria-label="새 세션 옵션"
                aria-haspopup="dialog"
                aria-expanded={agentOptsOpen}
                disabled={layerMode === "dev"}
                onClick={() => setAgentOptsOpen((v) => !v)}
              >
                <span className="toolbar-caret">▾</span>
              </button>
              {agentOptsOpen && (
                <AgentOptionsPopover
                  float
                  triggerRef={agentOptsBtnRef}
                  disabledReason={
                    activeProject ? undefined : "프로젝트를 연 뒤 세션을 시작할 수 있습니다"
                  }
                  onClose={() => setAgentOptsOpen(false)}
                  onStart={(agent, opts) => {
                    setAgentOptsOpen(false);
                    if (!activeProject) return;
                    const req = { project: activeProject, ...spawnOptionFields(opts) };
                    if (agent === "codex") requestCodexOpen(req);
                    else requestClaudeOpen(req);
                  }}
                />
              )}
            </div>
            <button
              className="toolbar-btn"
              title={
                layerMode === "dev"
                  ? "분리는 통합 모드에서 사용할 수 있습니다"
                  : "활성 패널을 새 창으로 분리 (또는 탭을 창 밖으로 드래그)"
              }
              disabled={layerMode === "dev"}
              onClick={() => requestDetachPanel()}
            >
              <span className="toolbar-ico">⤢</span> 분리
            </button>
            <button
              className="toolbar-btn"
              title={
                layerMode === "dev"
                  ? "메모는 통합 모드에서 사용할 수 있습니다"
                  : !activeProject
                    ? "메모는 프로젝트를 연 뒤 사용할 수 있습니다"
                    : "이 프로젝트의 메모장 열기 (자동 저장 · 프로젝트당 1개)"
              }
              disabled={layerMode === "dev" || !activeProject}
              onClick={() => requestMemo()}
            >
              <span className="toolbar-ico">▤</span> 메모
            </button>
          </div>
        )}
        <RunMenu />
        <div
          className="appearance-menu"
          ref={appearanceRef}
          onKeyDown={(e) => {
            // 키보드 닫기 경로 (리뷰 A10): Escape는 팝오버를 닫고 트리거로
            // 포커스를 돌린다 — 아웃사이드 클릭만으로는 키보드 사용자가 못 닫는다.
            if (e.key === "Escape" && appearanceOpen) {
              setAppearanceOpen(false);
              appearanceBtnRef.current?.focus();
            }
          }}
        >
          <button
            ref={appearanceBtnRef}
            className={`toolbar-btn${appearanceOpen ? " toolbar-btn-on" : ""}`}
            title="테마 설정 — 테마 · 글자 크기"
            aria-haspopup="dialog"
            aria-expanded={appearanceOpen}
            onClick={() => setAppearanceOpen((v) => !v)}
          >
            <span className="toolbar-ico">◐</span> 테마
          </button>
          {appearanceOpen && (
            <div
              className="appearance-pop"
              role="dialog"
              aria-label="테마 설정"
              tabIndex={-1}
              ref={appearancePopRef}
            >
              <div className="appearance-row">
                <span className="appearance-label">테마</span>
                <div className="seg" role="group" aria-label="테마">
                  <button
                    className={`seg-item${theme === "light" ? " seg-on" : ""}`}
                    aria-pressed={theme === "light"}
                    onClick={() => setTheme("light")}
                  >
                    ☀ 라이트
                  </button>
                  <button
                    className={`seg-item${theme === "dark" ? " seg-on" : ""}`}
                    aria-pressed={theme === "dark"}
                    onClick={() => setTheme("dark")}
                  >
                    🌙 다크
                  </button>
                </div>
              </div>
              <div className="appearance-row">
                <span className="appearance-label">글자 크기</span>
                <div className="font-stepper">
                  {/* 스테퍼는 스토어 최신값 기준(±1) — 렌더 시점 캡처값을 쓰면
                      미커밋 인풋 blur 커밋과 경합해 한 스텝을 잃을 수 있다(A9).
                      9/28은 clampFontSize의 상하한. */}
                  <button
                    className="font-step"
                    title="작게"
                    disabled={fontSize <= 9}
                    onClick={() => setFontSize(useAppStore.getState().fontSize - 1)}
                  >
                    −
                  </button>
                  <input
                    className="font-input"
                    value={fontDraft ?? String(fontSize)}
                    inputMode="numeric"
                    aria-label="글자 크기 (px)"
                    onChange={(e) => setFontDraft(e.target.value)}
                    onBlur={commitFontDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitFontDraft();
                      else if (e.key === "Escape" && fontDraft !== null) {
                        // draft가 있을 때만: 1차 Esc = 되돌림(전파 차단), draft
                        // 없으면 버블시켜 팝오버 닫힘(post-fix A10 — 항상
                        // 차단하면 인풋 포커스에서 Esc로 못 닫는다).
                        e.stopPropagation();
                        setFontDraft(null);
                      }
                    }}
                  />
                  <span className="font-unit">px</span>
                  <button
                    className="font-step"
                    title="크게"
                    disabled={fontSize >= 28}
                    onClick={() => setFontSize(useAppStore.getState().fontSize + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              {/* 전역 진입 1개 (리뷰 V3). 주 진입점은 각 터미널·claude 탭의 ⚙
                  이지만, 탭이 하나도 없는 상태(개발 모드·빈 레이아웃)에서는
                  같은 모달 안에 있는 **세션 알림 설정**에 닿을 길이 사라진다.
                  같은 모달을 열 뿐이라 색상까지 전역에서 열리는 건 무해하다. */}
              <div className="appearance-row">
                <span className="appearance-label">터미널·알림</span>
                <TermSettingsButton
                  className="toolbar-btn"
                  label="설정 열기…"
                  title="터미널 색상 · 세션 알림 — 터미널 탭 안의 ⚙과 같은 설정입니다"
                />
              </div>
            </div>
          )}
        </div>
        <ToolbarRollup />
        <span className="toolbar-title">
          {activeProject ?? "claude-workbench"}
        </span>
      </div>
      {mode === "study" ? (
        <StudyView />
      ) : (
        <div className="workspace-row">
        {/* IntelliJ-style left activity stripe: the sidebar tabs as vertical
            icons. Clicking the active icon folds the tree panel; the chevron
            toggles it too. Always visible, so a folded sidebar stays reachable. */}
        <div className="activity-bar" role="group" aria-label="사이드바">
          {/* role=toolbar + aria-pressed (탭 패턴 아님 — 리뷰 A6: tablist는
              tabpanel/roving tabindex 계약을 요구하고 spacer·셰브론이 섞여
              규격 위반이 된다. 접힌 상태에선 눌린 탭 0개가 정상 표현). */}
          {SIDE_TABS.map((t) => (
            <button
              key={t.key}
              aria-pressed={activeSideTab === t.key && !collapsed}
              className={`activity-item${activeSideTab === t.key && !collapsed ? " activity-on" : ""}`}
              title={
                activeSideTab === t.key && !collapsed
                  ? `${t.label} — 클릭해 사이드바 접기`
                  : sidebarView.split
                    ? `${t.label} — 위쪽 칸에 표시`
                    : t.label
              }
              onClick={() => activityClick(t.key)}
            >
              <span className="activity-ico">{t.ico}</span>
              <span className="activity-label">{t.label}</span>
            </button>
          ))}
          <div className="activity-spacer" />
          <button
            className={`activity-item activity-split${sidebarView.split ? " activity-on" : ""}`}
            aria-pressed={sidebarView.split}
            title={sidebarView.split ? "상하 분할 해제" : "사이드바 상하 분할"}
            aria-label={sidebarView.split ? "상하 분할 해제" : "사이드바 상하 분할"}
            onClick={() => {
              if (collapsed) treePanelRef.current?.expand(); // 접힘 중 ⊟ = 펼침 동반(리뷰)
              setSidebarView(toggleSplit);
            }}
          >
            <span className="activity-ico">⊟</span>
          </button>
          <button
            className="activity-item activity-chevron"
            title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
            aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
            onClick={toggleTree}
          >
            <span className="activity-ico">{collapsed ? "❯" : "❮"}</span>
          </button>
        </div>
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
          {/* P1: 사이드바 클러스터를 표면 컨텍스트로 감싼다. 사이드바는 dual-row
              밖 단일 인스턴스라 P0 배선(MainArea만 감쌈)에 포함되지 않았다 —
              활성 표면(현재는 primary)의 프로젝트를 주입해 FolderTree·GitPanel·
              WorktreePanel·GraphPanel이 useSurfaceProject()를 읽게 한다. 값은
              activeProject 반사라 완전 무동작(P5에서 표면별 사이드바로 실체화). */}
          <SurfaceProvider surfaceId="primary" project={activeProject}>
          <div className="sidebar-content">
            {/* PanelGroup은 분할 여부와 무관하게 **상시** 렌더 — ⊟ 토글이 위쪽
                본문(keyed "body")의 identity를 보존해 GitPanel 커밋 메시지 등
                로컬 상태가 소실되지 않는다(리뷰 P2). 아래 반쪽·핸들만 조건부
                (commit-files 조건부 Panel 선례). 두 반쪽이 같은 탭이 되는
                상태는 sidebarView 규칙(total 정규화)이 막는다. */}
            <PanelGroup direction="vertical" autoSaveId="sidebar-vert" className="sidebar-split">
              <Panel id="sidebar-top" order={1} minSize={15} className="sidebar-half">
                {sidebarView.split ? (
                  <SidebarHalfHead
                    key="head"
                    half="top"
                    tab={sidebarView.topTab}
                    otherTab={sidebarView.bottomTab}
                    onPick={(t) => pickHalfTab("top", t)}
                  />
                ) : sidebarView.tab === "files" ? (
                  <div key="head" className="tree-hint">
                    <span>Ctrl+B 트리/사이드바 · ↑↓ 이동 · Enter 열기 · Ctrl+E 에디터</span>
                    <button
                      className="tree-refresh"
                      title="디스크에서 새로고침"
                      onClick={() => void useAppStore.getState().reloadActiveTree()}
                    >
                      ↻
                    </button>
                  </div>
                ) : null}
                <div key="body" className="sidebar-half-body">
                  <SidebarTabBody tab={sidebarView.split ? sidebarView.topTab : sidebarView.tab} />
                </div>
              </Panel>
              {sidebarView.split && (
                <>
                  <PanelResizeHandle className="resize-handle resize-handle-v" />
                  <Panel id="sidebar-bottom" order={2} minSize={15} className="sidebar-half">
                    <SidebarHalfHead
                      half="bottom"
                      tab={sidebarView.bottomTab}
                      otherTab={sidebarView.topTab}
                      onPick={(t) => pickHalfTab("bottom", t)}
                    />
                    <div className="sidebar-half-body">
                      <SidebarTabBody tab={sidebarView.bottomTab} />
                    </div>
                  </Panel>
                </>
              )}
            </PanelGroup>
          </div>
          </SurfaceProvider>
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
            {/* project-dual-surface: 주 dock + (열려 있으면) 우측 수동 dock.
                주 Panel은 항상 마운트 — 분할 토글이 주 dock을 리마운트하지
                않도록 조건부는 우측 쌍에만 둔다. */}
            <PanelGroup direction="horizontal" autoSaveId="dual-surface" className="dual-row">
              <Panel id="dual-primary" order={1} minSize={25}>
                {/* P0 무동작 인프라: 주 표면 서브트리에 자기 프로젝트를 주입한다
                    (값은 현행 그대로 — MainArea는 여전히 activeProject 직독). */}
                <SurfaceProvider surfaceId="primary" project={activeProject}>
                  <MainArea />
                </SurfaceProvider>
              </Panel>
              {visibleDual && (
                <>
                  <PanelResizeHandle className="resize-handle" />
                  <Panel id="dual-secondary" order={2} minSize={20} defaultSize={40}>
                    <div className="dual-secondary">
                      <div
                        className="dual-secondary-head"
                        title={`${visibleDual}\n수동 dock — 툴바 버튼·단축키·요청은 좌측(주) 작업 영역 기준입니다`}
                      >
                        <span className="dual-secondary-name">
                          {projects.find((p) => p.path === visibleDual)?.name ?? visibleDual}
                        </span>
                        <span className="dual-secondary-hint">보조</span>
                        <button
                          className="dual-secondary-close"
                          title="우측 분할 닫기"
                          onClick={() => setDualProject(null)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="dual-secondary-body">
                        {/* 내부 DockviewReact가 surfaceProject로 키잉되어
                            프로젝트 교체 시 dock만 리마운트된다(외부 key 불요 — D11). */}
                        {/* P0 무동작 인프라: 부 표면 서브트리에 우측 분할이
                            표시 중인 프로젝트(visibleDual)를 주입한다 — MainArea가
                            받는 project prop과 동일 값(반사만, 소비 변경 0). */}
                        <SurfaceProvider surfaceId="secondary" project={visibleDual}>
                          <MainArea project={visibleDual} secondary />
                        </SurfaceProvider>
                      </div>
                    </div>
                  </Panel>
                </>
              )}
            </PanelGroup>
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
          {droppedPeek && (
            <FilePeekViewer
              memory={droppedPeek.files[droppedPeek.active]}
              tabs={
                droppedPeek.files.length > 1
                  ? {
                      names: droppedPeek.files.map((f) => f.name),
                      active: droppedPeek.active,
                      onSelect: (i) =>
                        setDroppedPeek((prev) => (prev ? { ...prev, active: i } : prev)),
                    }
                  : undefined
              }
              onClose={() => setDroppedPeek(null)}
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
        </div>
      )}
      {/* 설정 모달 레이어 — 창에 하나. 어느 탭의 ⚙에서 열든, 팝오버의 전역
          링크에서 열든 여기서 그린다(트리거가 사라져도 모달이 살아남는다). */}
      <TermSettingsLayer />
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
