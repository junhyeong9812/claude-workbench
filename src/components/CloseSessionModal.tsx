/**
 * Claude 세션 닫기/삭제 확인 모달 (P5 F-e1 — MainArea ↔ PopoutWorkbench의
 * 문자단위 동일 JSX 단일 출처. 실행 로직은 P4의 sessionClose가 이미 공용).
 *
 * **렌더 가드는 호출부 소유**(조사 §4-C 계약): MainArea는
 * `apiReady && getPanel(...)`로 소유 surface만 모달을 띄우고(dual-surface 이중
 * 소비 방지, 리뷰 D3) primary 전용 고아 백스톱을 별도로 갖는다 — 이 컴포넌트로
 * 옮기면 안 된다.
 */
export function CloseSessionModal({
  onClose,
  onDelete,
  onCancel,
}: {
  /** 닫기 — 세션 히스토리 보존. */
  onClose: () => void;
  /** 삭제 — 히스토리까지 영구 삭제. */
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="claude-modal-backdrop" onClick={onCancel}>
      <div className="claude-modal" onClick={(e) => e.stopPropagation()}>
        <div className="claude-modal-title">이 Claude 세션을 어떻게 할까요?</div>
        <button className="claude-modal-opt" onClick={onClose}>
          닫기 <span className="claude-modal-hint">세션 히스토리 보존 (나중에 다시 열기)</span>
        </button>
        <button className="claude-modal-opt claude-modal-del" onClick={onDelete}>
          삭제 <span className="claude-modal-hint">히스토리까지 영구 삭제</span>
        </button>
        <button className="claude-modal-opt claude-modal-cancel" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
