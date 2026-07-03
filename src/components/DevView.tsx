import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { StudyFileView } from "./StudyFileView";
import { useAppStore } from "../state/store";

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
  const editorOpenRequest = useAppStore((s) => s.editorOpenRequest);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);

  // Open tabs, MRU-first; in-memory per mount (the durable continuity is the
  // dev session itself, whose uuid persists).
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const apiRef = useRef<DockviewApi | null>(null);

  // Consume tree/peek file-open requests while this view owns the main area.
  useEffect(() => {
    if (!editorOpenRequest) return;
    const path = editorOpenRequest;
    requestEditorOpen(null);
    setTabs((prev) => (prev.includes(path) ? prev : [path, ...prev]));
    setActive(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest]);

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

  // Embedded dev session dock (StudySession 선례): seed once with the project's
  // persisted dev-session uuid so it resumes across restarts; a re-entry within
  // a run re-attaches to the still-live PTY.
  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    if (api.panels.length === 0) {
      const uuid = useAppStore.getState().ensureDevUuid(project);
      api.addPanel({
        id: "dev-claude",
        component: "claudeterm",
        title: "개발 세션",
        params: { kind: "claudeterm", title: "개발 세션", project, loadSessionId: uuid },
      });
    }
    // Explicit close of the dev session → stop its PTY (the pane stays empty
    // until the dev mode is re-entered, which re-seeds the same uuid).
    api.onDidRemovePanel((panel) => {
      const p = panel.params as { sessionId?: number } | undefined;
      if (typeof p?.sessionId === "number") {
        invoke("claude_close", { id: p.sessionId }).catch(() => {});
      }
    });
  };

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
