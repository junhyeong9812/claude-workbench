import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { useAppStore } from "../state/store";

const components = { claudeterm: ClaudeTermPanel };

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
  // Read layout once at onReady (avoid re-seeding on every render).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;

    if (layoutRef.current != null) {
      try {
        api.fromJSON(layoutRef.current as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch {
        /* corrupt layout — fall through to seeding */
      }
    }
    if (api.panels.length === 0 && cwd) {
      api.addPanel({
        id: "study-claude",
        component: "claudeterm",
        title: "스터디 세션",
        params: { kind: "claudeterm", title: "스터디 세션", project: cwd },
      });
    }

    api.onDidLayoutChange(() => setLayout(api.toJSON()));

    // Explicit close of the study session → stop its PTY + clear layout so the
    // next entry re-seeds a fresh one (study always has exactly one session).
    api.onDidRemovePanel((panel) => {
      const p = panel.params as { sessionId?: number } | undefined;
      if (typeof p?.sessionId === "number") {
        invoke("claude_close", { id: p.sessionId }).catch(() => {});
      }
      setLayout(null);
    });
  };

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
