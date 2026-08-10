import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { TerminalPanel } from "./TerminalPanel";
import { useAppStore } from "../state/store";
import { loadAgentOptions, spawnOptionFields } from "../state/agentOptions";

// 스터디 세션 + (트리 "여기서 터미널 열기"로 열리는) 일반 터미널 탭.
const components = { claudeterm: ClaudeTermPanel, terminal: TerminalPanel };

/**
 * The bottom pane of the study view (P3): a single pinned Claude session +
 * timeline for recording questions/thoughts. Hosted in a tiny dockview so the
 * existing claudeterm panel (real CLI + JSONL timeline + session lifecycle) is
 * reused as-is. The layout is kept in the store so switching modes within a run
 * re-attaches the same session (full app restart re-seeds — P4 persists it).
 *
 * Working dir = the left study folder (falls back to the right).
 */
export function StudySession() {
  const theme = useAppStore((s) => s.theme);
  const cwd = useAppStore((s) => s.studyFolders.left ?? s.studyFolders.right);
  const layout = useAppStore((s) => s.studySessionLayout);
  const setLayout = useAppStore((s) => s.setStudySessionLayout);
  const apiRef = useRef<DockviewApi | null>(null);
  // 트리 "여기서 터미널 열기" — 스터디 모드에서는 MainArea가 언마운트라 이
  // dock이 유일한 소비자다. dockReady는 마운트 직후 도착한 요청을 재발화시킨다.
  const terminalOpenRequest = useAppStore((s) => s.terminalOpenRequest);
  const [dockReady, setDockReady] = useState(0);
  // Read layout once at onReady (avoid re-seeding on every render).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setDockReady((n) => n + 1);

    if (layoutRef.current != null) {
      try {
        api.fromJSON(layoutRef.current as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch {
        /* corrupt layout — fall through to seeding */
      }
    }
    if (api.panels.length === 0 && cwd) {
      // Seed with the stable study session UUID so it resumes the same session
      // across restarts (create-or-resume in claude_start) even before any chat.
      const uuid = useAppStore.getState().ensureStudySessionUuid();
      api.addPanel({
        id: "study-claude",
        component: "claudeterm",
        title: "스터디 세션",
        params: {
          kind: "claudeterm",
          title: "스터디 세션",
          project: cwd,
          loadSessionId: uuid,
          // 모델·강도는 마지막에 고른 설정을 상속한다 (옵션 UI는 주 표면 2곳에만).
          ...spawnOptionFields(loadAgentOptions("claude")),
        },
      });
    }

    api.onDidLayoutChange(() => setLayout(api.toJSON()));

    // Explicit close of the study session → stop its PTY + clear layout so the
    // next entry re-seeds a fresh one (study always has exactly one session).
    // 폴더 터미널 탭은 그 계약 밖이다 — 자기 PTY만 닫고 레이아웃은 건드리지
    // 않는다(터미널 하나 닫았다고 스터디 세션 레이아웃을 버리면 안 된다).
    api.onDidRemovePanel((panel) => {
      const p = panel.params as { kind?: string; sessionId?: number } | undefined;
      if (p?.kind === "terminal") {
        if (typeof p.sessionId === "number") {
          invoke("terminal_close", { id: p.sessionId }).catch(() => {});
        }
        return;
      }
      if (typeof p?.sessionId === "number") {
        invoke("claude_close", { id: p.sessionId }).catch(() => {});
      }
      setLayout(null);
    });
  };

  // 폴더 터미널 요청 소비 (스터디 모드에서만 이 컴포넌트가 마운트된다).
  useEffect(() => {
    if (!terminalOpenRequest) return;
    const api = apiRef.current;
    if (!api) return; // dock 준비 전 — 요청 보존
    const { cwd: dir, title } = terminalOpenRequest;
    useAppStore.getState().requestTerminalOpen(null);
    api.addPanel({
      id: `terminal-study-${crypto.randomUUID()}`, // 연타해도 id 충돌 없음
      component: "terminal",
      title,
      params: { kind: "terminal", title, cwd: dir },
    });
  }, [terminalOpenRequest, dockReady]);

  if (!cwd) {
    return <div className="study-ph study-ph-term">좌/우 폴더를 선택하면 스터디 세션이 열립니다.</div>;
  }

  return (
    <DockviewReact
      className={`dockview-theme-${theme === "light" ? "light" : "dark"} study-session-dock`}
      components={components}
      onReady={onReady}
    />
  );
}
