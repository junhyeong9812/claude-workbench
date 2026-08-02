/**
 * 인라인 이름변경 탭 골격 (P5 F-e1 — ClaudeTab ↔ SshTab의 33줄 문자단위 동일
 * 블록 단일 출처). 더블클릭 → input(Enter 저장 / Esc 취소 / blur 저장).
 *
 * 창별 차이는 슬롯으로 보존한다(조사 §4-B-1 계약):
 * - `leading`: ClaudeTab의 attention 배지 자리 — SSH에는 없다(세션 상태 store
 *   구독을 SSH 탭으로 끌어들이지 않는다).
 * - `onCommit`: rename 부수효과(Claude=claude_rename invoke / SSH=저장 연결
 *   라벨 갱신)는 호출부 소유.
 * - `closeTitle`/`onClose`: ×의 의미가 다르다 — Claude=앱레벨 close 요청(닫기/
 *   삭제 모달), SSH=즉시 패널 close.
 */
import { useState, type ReactNode } from "react";

export function RenameTab({
  title,
  onCommit,
  onClose,
  closeTitle,
  leading,
}: {
  title: string;
  /** 트림된 새 이름(비어있지 않고 기존과 다를 때만 호출). */
  onCommit: (next: string) => void;
  onClose: () => void;
  closeTitle: string;
  leading?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    onCommit(next);
  };

  return (
    <div className="claude-tab">
      {leading}
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
        title={closeTitle}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </span>
    </div>
  );
}
