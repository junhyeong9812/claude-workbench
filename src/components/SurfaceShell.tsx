import { useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useAppStore } from "../state/store";
import { useSurfaceId, useSurfaceProject } from "../state/surfaceContext";
import { FolderTree } from "./FolderTree";
import { GitPanel } from "./GitPanel";
import { WorktreePanel } from "./WorktreePanel";
import { ArchivePanel } from "./ArchivePanel";
import { GraphPanel } from "./GraphPanel";
import { RunMenu } from "./RunMenu";
import { AgentOptionsPopover } from "./AgentOptionsPopover";
import { spawnOptionFields } from "../state/agentOptions";

/**
 * SurfaceShell (멀티프로젝트 P5) — **부 표면**이 자기 사이드바 클러스터+툴바를
 * 완전 소유하도록 인프레임 셸을 준다. 주 표면(primary)은 앱 좌측 컬럼+상단 툴바가
 * 그 역할을 하므로(위치 무변경, 회귀 0) 부 표면만 이 셸로 대칭 소유를 **가산**한다.
 *
 * 이 셸의 자식(FolderTree·Git·Worktree·Archive·Graph·툴바·RunMenu)은 모두 상위
 * `<SurfaceProvider surfaceId="secondary">` 안에서 렌더되므로 `useSurfaceId()`가
 * "secondary"를, `useSurfaceProject()`가 우측 프로젝트를 준다 → 요청은 origin
 * "secondary"로 stamp되어 이 표면 dock에만 열린다(표면-로컬 소유·무음 유실 0).
 */

const SIDE_TABS = [
  { key: "files", ico: "🗂", label: "파일" },
  { key: "git", ico: "⎇", label: "Git" },
  { key: "worktree", ico: "🌿", label: "워크트리" },
  { key: "archive", ico: "📦", label: "아카이브" },
  { key: "graph", ico: "◉", label: "그래프" },
] as const;

type SideTab = (typeof SIDE_TABS)[number]["key"];

function SurfaceSidebarBody({ tab }: { tab: SideTab }) {
  if (tab === "files") return <FolderTree />;
  if (tab === "git") return <GitPanel />;
  if (tab === "worktree") return <WorktreePanel />;
  if (tab === "archive") return <ArchivePanel />;
  return <GraphPanel />;
}

/** 부 표면 사이드바 — 5탭 아이콘 스트립 + 본문. 상하 분할은 주 표면 전용(P6에서
 * 통일 고려). 탭 상태는 표면-로컬(자기 useState — 모듈 단일 상태 공유 없음). */
function SurfaceSidebar() {
  const [tab, setTab] = useState<SideTab>("files");
  const reloadTreeFor = useAppStore((s) => s.reloadTreeFor);
  const project = useSurfaceProject();
  return (
    <div className="surface-sidebar">
      <div className="surface-sidebar-head">
        <div className="seg sidebar-seg" role="group" aria-label="사이드바 탭">
          {SIDE_TABS.map((t) => (
            <button
              key={t.key}
              className={`seg-item sidebar-seg-item${tab === t.key ? " seg-on" : ""}`}
              aria-pressed={tab === t.key}
              aria-label={t.label}
              title={t.label}
              onClick={() => setTab(t.key)}
            >
              <span aria-hidden="true">{t.ico}</span>
            </button>
          ))}
        </div>
        {tab === "files" && (
          <button
            className="tree-refresh"
            title="디스크에서 새로고침"
            onClick={() => project && void reloadTreeFor(project)}
          >
            ↻
          </button>
        )}
      </div>
      <div className="surface-sidebar-body">
        <SurfaceSidebarBody tab={tab} />
      </div>
    </div>
  );
}

/** 부 표면 툴바 — 세션 컨트롤(터미널·에이전트+옵션·메모)+실행 메뉴. dev/study
 * 오버레이는 주 표면 전용이라 부 표면은 integrated 고정 → dev 게이팅 없음. SSH·
 * 분리는 주 표면 전용(전역 알림/전송 envelope). 모든 발행은 origin surfaceId를
 * 실어 이 표면 dock에 연다. */
function SurfaceToolbar() {
  const surfaceId = useSurfaceId(); // "secondary"
  const project = useSurfaceProject();
  const requestTerminalOpen = useAppStore((s) => s.requestTerminalOpen);
  const requestClaudePicker = useAppStore((s) => s.requestClaudePicker);
  const requestClaudeOpen = useAppStore((s) => s.requestClaudeOpen);
  const requestCodexOpen = useAppStore((s) => s.requestCodexOpen);
  const requestMemo = useAppStore((s) => s.requestMemo);
  const [optsOpen, setOptsOpen] = useState(false);
  const optsBtnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="surface-toolbar" role="group" aria-label="세션/실행 (이 표면)">
      <button
        className="toolbar-btn"
        title="이 표면에 터미널 열기"
        disabled={!project}
        onClick={() => project && requestTerminalOpen({ cwd: project, title: "Terminal" }, surfaceId)}
      >
        <span className="toolbar-ico">▣</span> 터미널
      </button>
      <div className="agent-opt-menu">
        <button
          className="toolbar-btn"
          title="이 표면에 에이전트 세션 열기 (새 세션 또는 저장된 세션)"
          disabled={!project}
          onClick={() => requestClaudePicker(surfaceId)}
        >
          <span className="toolbar-ico">✦</span> 에이전트
        </button>
        <button
          ref={optsBtnRef}
          className={`toolbar-btn${optsOpen ? " toolbar-btn-on" : ""}`}
          title="새 세션 옵션 — 에이전트 · 모델 · 강도"
          aria-label="새 세션 옵션"
          aria-haspopup="dialog"
          aria-expanded={optsOpen}
          disabled={!project}
          onClick={() => setOptsOpen((v) => !v)}
        >
          <span className="toolbar-caret">▾</span>
        </button>
        {optsOpen && (
          <AgentOptionsPopover
            float
            triggerRef={optsBtnRef}
            disabledReason={project ? undefined : "프로젝트를 연 뒤 세션을 시작할 수 있습니다"}
            onClose={() => setOptsOpen(false)}
            onStart={(agent, opts) => {
              setOptsOpen(false);
              if (!project) return;
              const req = { project, ...spawnOptionFields(opts) };
              if (agent === "codex") requestCodexOpen(req, surfaceId);
              else requestClaudeOpen(req, surfaceId);
            }}
          />
        )}
      </div>
      <button
        className="toolbar-btn"
        title="이 표면 프로젝트의 메모장 열기"
        disabled={!project}
        onClick={() => requestMemo(surfaceId)}
      >
        <span className="toolbar-ico">▤</span> 메모
      </button>
      <RunMenu />
    </div>
  );
}

/** 부 표면 셸: 툴바 + [사이드바 | 본문] 가로 분할. children = <MainArea secondary/>.
 * 상위에서 `<SurfaceProvider surfaceId="secondary" project={...}>`로 감싼다. */
export function SurfaceShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="surface-shell">
      <SurfaceToolbar />
      <PanelGroup direction="horizontal" autoSaveId="surface-secondary" className="surface-shell-row">
        <Panel id="surface-sidebar" order={1} defaultSize={26} minSize={12} collapsible collapsedSize={0}>
          <SurfaceSidebar />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel id="surface-main" order={2} defaultSize={74} minSize={30}>
          {children}
        </Panel>
      </PanelGroup>
    </div>
  );
}
