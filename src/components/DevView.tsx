import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { StudyFileView } from "./StudyFileView";
import { useAppStore } from "../state/store";
import {
  resolveLayerMode,
  devIsFront,
  routeDevReview,
  nextDevReviewAction,
} from "../state/layerRouting";

const components = { claudeterm: ClaudeTermPanel };
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

  // Open tabs, MRU-first; in-memory per mount (the durable continuity is the
  // dev session itself, whose uuid persists).
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);

  // Consume tree/peek file-open requests only while the dev layer is in front.
  // In integrated mode this view is still mounted (latch) but behind MainArea,
  // so it must leave the request untouched for MainArea (유실≠소비).
  useEffect(() => {
    if (!devIsFront(layerMode)) return; // integrated layer's request — leave it
    if (!editorOpenRequest) return;
    const path = editorOpenRequest;
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
    const prompt =
      `방금 \`${active}\` 를 편집·저장했어. 그 파일을 읽고 검토해줘 — ` +
      `오타·빠진 import·들여쓰기/포맷·맥락 적합성 위주로. ` +
      `직접 수정하지 말고 무엇을 어떻게 고치면 되는지 지적·설명만 해줘.`;
    useAppStore.getState().requestClaudeInject({ uuid, text: prompt });
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
        useAppStore.getState().requestClaudeInject({ uuid, text: action.prompt });
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

  // Embedded dev session dock (StudySession 선례): seed once with the project's
  // persisted dev-session uuid so it resumes across restarts; a re-entry within
  // a run re-attaches to the still-live PTY. If a devReview is already pending
  // (the ✓확인 flip mounted us this same tick), carry its prompt as the seed so
  // the very first prompt isn't lost to a not-yet-live inject (F4).
  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
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
    api.onDidRemovePanel((panel) => {
      const p = panel.params as { sessionId?: number } | undefined;
      if (typeof p?.sessionId === "number") {
        invoke("claude_close", { id: p.sessionId }).catch(() => {});
      }
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
    if (focusMainRequest === 0 || focusMainRequest === lastFocusHandledRef.current) return;
    lastFocusHandledRef.current = focusMainRequest;
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
