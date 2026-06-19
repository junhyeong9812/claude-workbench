import { useState } from "react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";

/**
 * Custom dockview tab for Claude panels (P2b-2 B3-1): the × opens a small menu
 * so the user chooses **닫기**(keep the saved history) or **삭제**(also remove
 * it) — the default dockview close gives no such choice.
 */
export function ClaudeTab(props: IDockviewPanelHeaderProps) {
  const [menu, setMenu] = useState(false);
  const title = (props.params.title as string) ?? "Claude";
  // Adapter session id: written to params on connect (live) or known up-front
  // for a reopened read-only session.
  const sessionId =
    (props.params.sessionId as string) ?? (props.params.loadSessionId as string) ?? null;

  const close = () => {
    setMenu(false);
    props.api.close();
  };

  const del = () => {
    setMenu(false);
    const project = useAppStore.getState().activeProject ?? null;
    if (sessionId && project) {
      invoke("acp_delete_session", { project, sessionId }).catch(() => {});
    }
    props.api.close();
  };

  return (
    <div className="claude-tab">
      <span className="claude-tab-title">{title}</span>
      <span
        className="claude-tab-x"
        title="닫기 / 삭제"
        onClick={(e) => {
          e.stopPropagation();
          setMenu((v) => !v);
        }}
      >
        ×
      </span>
      {menu && (
        <>
          <div className="claude-tab-backdrop" onClick={() => setMenu(false)} />
          <div className="claude-tab-menu" onClick={(e) => e.stopPropagation()}>
            <button className="claude-tab-opt" onClick={close}>
              닫기 <span className="claude-tab-hint">세션 보존</span>
            </button>
            <button className="claude-tab-opt claude-tab-del" onClick={del}>
              삭제 <span className="claude-tab-hint">히스토리까지</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
