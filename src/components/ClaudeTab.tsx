import type { IDockviewPanelHeaderProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";
import { useClaudeStatus, attentionOf } from "../state/claudeStatus";
import { isRefineParams } from "../state/promptRefine";
import { RenameTab } from "./RenameTab";

/** Attention dot for a Claude tab (agent-status-badges P3). A color dot (never
 * color-only — every state carries a `title`, F3 a11y) at the priority the store
 * resolved: 🔴 blocked > 🔵 done-unseen > 🟡 working > none. */
function TabBadge({ sessionId }: { sessionId: string | null }) {
  const level = useClaudeStatus((s) => {
    const e = sessionId ? s.entries[sessionId] : undefined;
    return e ? attentionOf(e.status, e.unseen) : 0;
  });
  if (level === 0) return null; // idle / unknown — no dot
  const [cls, label] =
    level === 3
      ? ["is-blocked", "입력 대기 중"]
      : level === 2
        ? ["is-done", "완료 — 확인 안 함"]
        : ["is-working", "작업 중"];
  return <span className={`claude-tab-badge ${cls}`} title={label} aria-label={label} />;
}

/**
 * Custom dockview tab for Claude panels (B3-1/B3-5). 골격은 RenameTab(P5 F-e1)
 * — 배지 슬롯 + rename 부수효과(claude_rename) + ×=앱레벨 close 요청(닫기/삭제
 * 모달, 탭 로컬 메뉴는 overflow:hidden에 잘린다)만 이 파일 소유.
 */
export function ClaudeTab(props: IDockviewPanelHeaderProps) {
  const title = (props.params.title as string) ?? "에이전트";
  // The architecture-A terminal keys by `sessionUuid` (its Claude session id).
  const sessionId =
    (props.params.sessionUuid as string) ?? (props.params.loadSessionId as string) ?? null;

  return (
    <RenameTab
      title={title}
      leading={<TabBadge sessionId={sessionId} />}
      closeTitle="닫기 / 삭제"
      onCommit={(next) => {
        props.api.setTitle(next);
        props.api.updateParameters({ ...props.params, title: next });
        // The panel's own project — fall back to the active project.
        const project =
          (props.params.project as string | undefined) ??
          useAppStore.getState().activeProject ??
          null;
        if (sessionId && project) {
          invoke("claude_rename", { project, uuid: sessionId, name: next }).catch(() => {});
        }
      }}
      onClose={() => {
        // 프롬프트 정리 세션은 닫기 = 아카이브다 — 닫기/삭제 모달의 선택지가
        // 여기엔 의미가 없고(스크래치 스냅샷은 어떤 피커에도 뜨지 않는다),
        // 대신 아카이브가 성공해야만 닫혀야 한다. 그 판단·실패 표시·메모 동봉은
        // 전부 패널이 들고 있으므로 여기서는 요청만 올린다(state/claudeUi).
        // 배경 탭이면 패널이 언마운트돼 있으니 먼저 활성화해 마운트시킨다.
        if (isRefineParams(props.params)) {
          props.api.setActive();
          useClaudeUi.getState().requestRefineClose(props.api.id);
          return;
        }
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
    />
  );
}
