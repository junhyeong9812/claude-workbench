import { useState } from "react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { useAppStore } from "../state/store";

/**
 * Custom dockview tab for SSH panels. Double-click the title to rename inline
 * (Enter saves, Esc cancels); the rename also updates the saved connection's
 * label (so it sticks across restarts). The × closes the panel — which closes
 * the SSH session via `onDidRemovePanel` (no history to keep, unlike Claude).
 */
export function SshTab(props: IDockviewPanelHeaderProps) {
  const title = (props.params.title as string) ?? "SSH";
  const connectionId = props.params.connectionId as string | undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    props.api.setTitle(next);
    props.api.updateParameters({ ...props.params, title: next });
    // Persist the new label onto the saved connection, if this is one.
    if (connectionId) {
      const conn = useAppStore.getState().savedConnections.find((c) => c.id === connectionId);
      if (conn) useAppStore.getState().upsertConnection({ ...conn, label: next });
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
        title="닫기"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
      >
        ×
      </span>
    </div>
  );
}
