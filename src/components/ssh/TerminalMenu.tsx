/**
 * "+ Terminal" 드롭다운 — 로컬 터미널 / 새 SSH 연결 / 저장된 연결 / 출력 저장
 * 설정 (MainArea에서 순수 이동, P5 F-c). 저장된 연결 목록·삭제·스크롤백 설정은
 * store를 직접 구독한다(원본과 같은 값·같은 시점).
 */
import { useAppStore } from "../../state/store";

export function TerminalMenu({
  onClose,
  onLocalTerminal,
  onNewSsh,
  onConnectSaved,
}: {
  onClose: () => void;
  onLocalTerminal: () => void;
  onNewSsh: () => void;
  /** 저장된 연결 접속 — 메뉴 닫기는 이쪽이 담당한다(원 동작). */
  onConnectSaved: (id: string) => void;
}) {
  const savedConnections = useAppStore((s) => s.savedConnections);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const persistScrollback = useAppStore((s) => s.persistScrollback);
  const setPersistScrollback = useAppStore((s) => s.setPersistScrollback);

  return (
    <div className="claude-picker" onMouseLeave={onClose}>
      <button
        className="claude-picker-item"
        onClick={() => {
          onClose();
          onLocalTerminal();
        }}
      >
        <span className="claude-picker-title">로컬 터미널</span>
      </button>
      <button
        className="claude-picker-item"
        onClick={() => {
          onClose();
          onNewSsh();
        }}
      >
        <span className="claude-picker-title">+ 새 SSH 연결</span>
      </button>
      {savedConnections.length > 0 && (
        <>
          <div className="claude-picker-sep">저장된 연결</div>
          {savedConnections.map((c) => (
            <div key={c.id} className="claude-picker-row" style={{ paddingLeft: 4 }}>
              <button className="claude-picker-item" onClick={() => onConnectSaved(c.id)}>
                <span className="claude-picker-title">{c.label}</span>
                <span className="claude-picker-meta">
                  {c.username}@{c.host}:{c.port} · {c.auth_kind}
                </span>
              </button>
              <span
                className="claude-tab-x"
                title="연결 삭제"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`'${c.label}' 연결을 삭제할까요? (키체인 비밀번호도 삭제)`)) return;
                  const ok = await deleteConnection(c.id);
                  if (!ok)
                    alert(
                      "키체인 비밀번호 삭제에 실패해 연결을 삭제하지 못했습니다. 다시 시도해 주세요.",
                    );
                }}
              >
                ×
              </span>
            </div>
          ))}
        </>
      )}
      <div className="claude-picker-sep">설정</div>
      <button
        className="claude-picker-item"
        onClick={() => setPersistScrollback(!persistScrollback)}
      >
        <span className="claude-picker-title">
          출력 저장(재시작 복원): {persistScrollback ? "ON" : "OFF"}
        </span>
        <span className="claude-picker-meta">출력에 비밀번호가 섞일 수 있어 기본 OFF</span>
      </button>
    </div>
  );
}
