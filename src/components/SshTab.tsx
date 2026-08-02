import type { IDockviewPanelHeaderProps } from "dockview";
import { useAppStore } from "../state/store";
import { RenameTab } from "./RenameTab";

/**
 * Custom dockview tab for SSH panels. 골격은 RenameTab(P5 F-e1) — rename은
 * 저장 연결 라벨 갱신, ×는 즉시 패널 close(`onDidRemovePanel`이 SSH 세션을
 * 닫는다 — Claude와 달리 보존할 히스토리가 없다). 배지 슬롯 없음(세션 상태
 * store 구독을 SSH 탭으로 끌어들이지 않는다).
 */
export function SshTab(props: IDockviewPanelHeaderProps) {
  const title = (props.params.title as string) ?? "SSH";
  const connectionId = props.params.connectionId as string | undefined;

  return (
    <RenameTab
      title={title}
      closeTitle="닫기"
      onCommit={(next) => {
        props.api.setTitle(next);
        props.api.updateParameters({ ...props.params, title: next });
        // Persist the new label onto the saved connection, if this is one.
        if (connectionId) {
          const conn = useAppStore.getState().savedConnections.find((c) => c.id === connectionId);
          if (conn) useAppStore.getState().upsertConnection({ ...conn, label: next });
        }
      }}
      onClose={() => props.api.close()}
    />
  );
}
