import { useState } from "react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";

/**
 * Custom dockview tab for Claude panels (B3-1/B3-5). Double-click the title to
 * rename inline (Enter saves, Esc cancels); the × raises an app-level close
 * request that becomes a 닫기/삭제 modal (a tab-local menu would be clipped by
 * the tab's `overflow:hidden`).
 */
export function ClaudeTab(props: IDockviewPanelHeaderProps) {
  const title = (props.params.title as string) ?? "Claude";
  // The architecture-A terminal keys by `sessionUuid` (its Claude session id).
  const sessionId =
    (props.params.sessionUuid as string) ?? (props.params.loadSessionId as string) ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    props.api.setTitle(next);
    props.api.updateParameters({ ...props.params, title: next });
    // The panel's own project — fall back to the active project.
    const project =
      (props.params.project as string | undefined) ?? useAppStore.getState().activeProject ?? null;
    if (sessionId && project) {
      invoke("claude_rename", { project, uuid: sessionId, name: next }).catch(() => {});
    }
  };

  return (
    <div className="claude-tab">
      {editing ? (
        <input
          className="claude-tab-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(title);
            }
          }}
        />
      ) : (
        <span
          className="claude-tab-title"
          title="더블클릭으로 이름 변경"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(title);
            setEditing(true);
          }}
        >
          {title}
        </span>
      )}
      <span
        className="claude-tab-x"
        title="닫기 / 삭제"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const ptyId =
            typeof props.params.sessionId === "number"
              ? (props.params.sessionId as number)
              : undefined;
          const project =
            (props.params.project as string | undefined) ??
            useAppStore.getState().activeProject ??
            null;
          useClaudeUi
            .getState()
            .requestClose({ panelId: props.api.id, sessionId, kind: "claudeterm", ptyId, project });
        }}
      >
        ×
      </span>
    </div>
  );
}
