import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { TerminalPanel } from "./TerminalPanel";
import { StudyFileView } from "./StudyFileView";
import { useAppStore } from "../state/store";
import { fileReviewSeed } from "../state/seedPrompts";
import { loadAgentOptions, spawnOptionFields } from "../state/agentOptions";
import {
  resolveLayerMode,
  devIsFront,
  routeDevReview,
  nextDevReviewAction,
} from "../state/layerRouting";

// 개발 세션 + (트리 "여기서 터미널 열기"로 열리는) 일반 터미널 탭.
const components = { claudeterm: ClaudeTermPanel, terminal: TerminalPanel };
const basename = (p: string) => p.split("/").pop() ?? p;

/**
 * 개발 모드 화면 (프로젝트별 통합↔개발 토글의 "개발" 쪽): the main area swaps to
 * an editor-first layout — editable file tabs (left) beside the project's pinned
 * dev Claude session (right), the review-dev-modes Phase B 원안. Tree/peek file
 * opens land here as tabs while this view owns the main area (MainArea is
 * unmounted, so its request consumers can't race this one).
 *
 *   [파일 탭 스트립 + ✓확인]  |  [개발 세션 (persist uuid — 재시작 후 재개)]
 *   [StudyFileView editable]  |
 *
 * The dev session is hosted in a tiny embedded dockview (StudySession 선례) so
 * the real claudeterm panel — CLI + timeline + lifecycle — is reused as-is.
 */
export function DevView({ project }: { project: string }) {
  const theme = useAppStore((s) => s.theme);
  const projectModes = useAppStore((s) => s.projectModes);
  // DevView stays mounted behind MainArea after a toggle back to integrated
  // (mount latch), so it must only consume editorOpen while it is the front
  // (dev) layer — symmetric with MainArea's gate.
  const layerMode = resolveLayerMode(projectModes, project);
  const editorOpenRequest = useAppStore((s) => s.editorOpenRequest);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  // ✓확인/🧪 (EditorPanel or the DevView button) hands a review/test prompt to
  // this project's dev session — this view (not MainArea) owns delivery now. A
  // FIFO queue: this DevView drains only its own project's entries, in order.
  const devReviewQueue = useAppStore((s) => s.devReviewQueue);
  // The single inject slot's occupancy paces the drain (B2): the queue flows one
  // entry per slot vacancy — when ClaudeTermPanel consumes an inject (slot →
  // null), this subscription re-fires the deliver effect for the next entry.
  const claudeInjectRequest = useAppStore((s) => s.claudeInjectRequest);
  // Ctrl+B focus request: when the dev layer is in front, DevView (not MainArea)
  // owns the focus target (its editor or its dev dock).
  const focusMainRequest = useAppStore((s) => s.focusMainRequest);
  // 트리 "여기서 터미널 열기" — 개발 레이어가 앞이면 이 dock이 소비한다.
  const terminalOpenRequest = useAppStore((s) => s.terminalOpenRequest);

  // Open tabs, MRU-first; in-memory per mount (the durable continuity is the
  // dev session itself, whose uuid persists).
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // dock 준비 신호 — 마운트 직후 도착한 터미널 요청이 api 없이 흘러가지 않도록
  // (onReady에서 1로 올려 소비 효과를 재발화시킨다).
  const [dockReady, setDockReady] = useState(0);
  const apiRef = useRef<DockviewApi | null>(null);

  // Consume tree/peek file-open requests only while the dev layer is in front.
  // In integrated mode this view is still mounted (latch) but behind MainArea,
  // so it must leave the request untouched for MainArea (유실≠소비).
  useEffect(() => {
    if (!devIsFront(layerMode)) return; // integrated layer's request — leave it
    // 요청버스 표면 슬롯(P5 F1): DevView는 **주 표면(primary)** dev 레이어 단일
    // 인스턴스라 primary 슬롯만 읽는다 — 표면별 dev 레이어는 P6 몫.
    const req = editorOpenRequest.primary;
    if (!req) return;
    const path = req.path;
    // Clear only AFTER the tab actually opens (side effect before clear, T1) so a
    // dropped request can't read as "consumed".
    setTabs((prev) => (prev.includes(path) ? prev : [path, ...prev]));
    setActive(path);
    requestEditorOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest, layerMode]);

  const closeTab = (p: string) => {
    setTabs((prev) => {
      const next = prev.filter((x) => x !== p);
      setActive((a) => (a === p ? (next[0] ?? null) : a));
      return next;
    });
  };

  // ✓확인 — ask the always-mounted dev session to review the active file
  // (Ctrl+S saves in the editor; claude reads the file from disk). Injection is
  // matched by session uuid in ClaudeTermPanel.
  const review = () => {
    if (!active) return;
    const uuid = useAppStore.getState().ensureDevUuid(project);
    const prompt = fileReviewSeed(active);
    useAppStore.getState().requestClaudeInject({ id: crypto.randomUUID(), uuid, text: prompt });
  };

  // Open the embedded dev session panel with the project's persisted uuid (so it
  // resumes across restarts), optionally carrying a review/test prompt as the
  // session's one-shot seed. Shared by onReady (fresh/empty dock) and the
  // devReview effect (pane emptied by a user close).
  const seedDevSession = (api: DockviewApi, prompt?: string) => {
    const uuid = useAppStore.getState().ensureDevUuid(project);
    api.addPanel({
      id: "dev-claude",
      component: "claudeterm",
      title: "개발 세션",
      params: {
        kind: "claudeterm",
        title: "개발 세션",
        project,
        loadSessionId: uuid,
        ...(prompt ? { seed: prompt } : {}),
        // 모델·강도는 마지막에 고른 설정을 상속한다 (옵션 UI는 주 표면 2곳에만).
        ...spawnOptionFields(loadAgentOptions("claude")),
      },
    });
  };

  // Drain this project's devReview (✓확인/🧪) entries from the FIFO queue. Delivery
  // follows a CAS discipline: re-read the LATEST store each step (never a
  // captured snapshot), decide via nextDevReviewAction (pending/inject/seed/wait
  // — ③·#6·F4·B2), deliver, then consume BY ID. So the two delivery paths (this
  // effect and onReady's child effect, which runs first) can't double-deliver:
  // whichever consumes an id first, the other re-reads and no longer finds it.
  // "wait" covers both blockers: dock not ready (onReady will seed the head) and
  // the single inject slot still occupied — at most ONE inject per pass; the
  // queue flows one entry per slot vacancy (the claudeInjectRequest subscription
  // re-runs this when ClaudeTermPanel consumes the slot → null). If the panel
  // never goes live the slot never clears and the queue waits (no loss) — same
  // root as the pre-existing live-race.
  const deliverDevReviews = () => {
    const api = apiRef.current;
    for (;;) {
      const s = useAppStore.getState();
      const route = routeDevReview(api != null, api != null && api.getPanel("dev-claude") != null);
      const action = nextDevReviewAction(
        s.devReviewQueue,
        project,
        route,
        s.claudeInjectRequest !== null,
      );
      if (action.kind === "none" || action.kind === "wait") return; // done / blocked — queue keeps the rest
      if (action.kind === "inject") {
        const uuid = useAppStore.getState().ensureDevUuid(project);
        useAppStore.getState().requestClaudeInject({
          id: crypto.randomUUID(),
          uuid,
          text: action.prompt,
        });
      } else {
        seedDevSession(api!, action.prompt); // "seed": pane was emptied — re-open it seeded
      }
      useAppStore.getState().consumeDevReview(action.id); // consume by id (idempotent)
    }
  };

  useEffect(() => {
    deliverDevReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devReviewQueue, claudeInjectRequest]);

  // 트리 폴더 터미널: 개발 레이어가 앞일 때만 이 dock에 연다(뒤면 요청을 그대로
  // 두어 통합 레이어의 MainArea가 소비한다 — 유실≠소비).
  useEffect(() => {
    if (!devIsFront(layerMode)) return;
    const req = terminalOpenRequest.primary; // P5 F1: 주 표면 슬롯만(dev=primary 전용)
    if (!req) return;
    const api = apiRef.current;
    if (!api) return; // dock 준비 전 — 요청 보존
    const { cwd, title } = req;
    // 소비는 패널이 열린 뒤 (실패 시 요청 보존 — MainArea와 같은 계약).
    try {
      api.addPanel({
        id: `terminal-dev-${crypto.randomUUID()}`, // 연타해도 id 충돌 없음
        component: "terminal",
        title,
        params: { kind: "terminal", title, cwd },
      });
      useAppStore.getState().requestTerminalOpen(null);
    } catch (err) {
      console.error("terminalOpen failed; keeping request", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpenRequest, layerMode, dockReady]);

  // Embedded dev session dock (StudySession 선례): seed once with the project's
  // persisted dev-session uuid so it resumes across restarts; a re-entry within
  // a run re-attaches to the still-live PTY. If a devReview is already pending
  // (the ✓확인 flip mounted us this same tick), carry its prompt as the seed so
  // the very first prompt isn't lost to a not-yet-live inject (F4).
  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setDockReady((n) => n + 1);
    if (api.panels.length === 0) {
      // CAS: grab our project's head devReview (if any) to seed the fresh session
      // with, and consume it by id — so the devReview effect (parent, runs after
      // this child effect) re-reads and won't re-deliver it.
      const head = useAppStore.getState().devReviewQueue.find((r) => r.project === project);
      seedDevSession(api, head?.prompt);
      if (head) useAppStore.getState().consumeDevReview(head.id);
    }
    // Explicit close of the dev session → stop its PTY (the pane stays empty
    // until the dev mode is re-entered, which re-seeds the same uuid).
    // 폴더 터미널 탭은 단일 소유라 자기 PTY만 닫는다 — claude_close에 터미널 id를
    // 넘기지 않도록 kind로 갈라 둔다.
    api.onDidRemovePanel((panel) => {
      const p = panel.params as { kind?: string; sessionId?: number } | undefined;
      if (typeof p?.sessionId !== "number") return;
      if (p.kind === "terminal") {
        invoke("terminal_close", { id: p.sessionId }).catch(() => {});
        return;
      }
      invoke("claude_close", { id: p.sessionId }).catch(() => {});
    });
    // Deliver any remaining same-project entries now that the dock is live (a
    // rapid double ✓확인 before mount leaves >1 queued).
    deliverDevReviews();
  };

  // Ctrl+B focus: when the dev layer is in front, focus this view's active area —
  // the open editor tab's CodeMirror if one is active, else the dev dock's active
  // panel content (xterm/timeline). Symmetric with MainArea's focusMainRequest
  // consumer, which stays gated to the integrated (front) layer. Retries across a
  // few frames in case content is still laying out. Skip the initial 0.
  const lastFocusHandledRef = useRef(0);
  useEffect(() => {
    if (focusMainRequest.nonce === 0 || focusMainRequest.nonce === lastFocusHandledRef.current) return;
    lastFocusHandledRef.current = focusMainRequest.nonce;
    if (!devIsFront(layerMode)) return; // integrated layer in front — MainArea focuses
    const wantEditor = active != null;
    let tries = 0;
    const tick = () => {
      const root = document.querySelector(".dev-view");
      if (root) {
        const editor = root.querySelector(".dev-editor-body .cm-content") as HTMLElement | null;
        if (wantEditor && editor && editor.offsetParent !== null) {
          editor.focus();
          return;
        }
        const group = root.querySelector(".dev-session-dock .dv-active-group");
        const content = (group ?? root).querySelector(
          ".xterm-helper-textarea, .cm-content, textarea, input, [tabindex]",
        ) as HTMLElement | null;
        if (content && content.offsetParent !== null) {
          content.focus();
          return;
        }
      }
      if (tries++ < 10) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMainRequest, layerMode]);

  return (
    <PanelGroup direction="horizontal" className="dev-view" autoSaveId="dev-cols">
      <Panel defaultSize={55} minSize={25} className="dev-col">
        <div className="dev-editor">
          <div className="dev-tabs">
            <div className="dev-tabs-list">
              {tabs.map((p) => (
                <div
                  key={p}
                  className={`dev-tab${p === active ? " active" : ""}`}
                  title={p}
                  onClick={() => setActive(p)}
                >
                  <span className="dev-tab-name">{basename(p)}</span>
                  <span
                    className="dev-tab-x"
                    title="닫기"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(p);
                    }}
                  >
                    ×
                  </span>
                </div>
              ))}
            </div>
            {active && (
              <button
                className="dev-review-btn"
                title="저장(Ctrl+S)된 파일을 개발 세션이 검토 — 지적만, 수정 안 함"
                onClick={review}
              >
                ✓ 확인
              </button>
            )}
          </div>
          <div className="dev-editor-body">
            {active ? (
              <StudyFileView key={active} path={active} editable project={project} />
            ) : (
              <div className="dev-empty">
                좌측 트리에서 파일을 열면 에디터 탭으로 열립니다.
                <br />
                Ctrl+S 저장 · ✓확인 = 개발 세션 검토
              </div>
            )}
          </div>
        </div>
      </Panel>
      <PanelResizeHandle className="resize-handle" />
      <Panel defaultSize={45} minSize={20} className="dev-col">
        <DockviewReact
          className={`dockview-theme-${theme === "light" ? "light" : "dark"} dev-session-dock`}
          components={components}
          onReady={onReady}
        />
      </Panel>
    </PanelGroup>
  );
}
