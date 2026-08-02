/**
 * 처음 보는 호스트키(TOFU) 확인 모달 (MainArea에서 순수 이동, P5 F-c).
 * 대기열의 [0]만 그린다 — 답할 때마다 다음 것이 올라온다 (P3-R2).
 */
import type { HostKeyPrompt } from "./sshConnect";

export function HostKeyModal({
  prompt,
  onAnswer,
}: {
  prompt: HostKeyPrompt;
  onAnswer: (accept: boolean) => void;
}) {
  return (
    <div className="claude-modal-backdrop">
      <div className="claude-modal" onClick={(e) => e.stopPropagation()}>
        <div className="claude-modal-title">처음 접속하는 호스트입니다</div>
        <div className="ssh-hostkey-body">
          <div>
            {prompt.host}:{prompt.port}
          </div>
          <div className="ssh-fingerprint">{prompt.fingerprint}</div>
          <div className="claude-modal-hint">
            이 호스트키를 신뢰하고 저장할까요? (불일치 시 MITM 위험)
          </div>
        </div>
        <button className="claude-modal-opt" onClick={() => onAnswer(true)}>
          신뢰 <span className="claude-modal-hint">키를 저장하고 접속</span>
        </button>
        <button
          className="claude-modal-opt claude-modal-del"
          onClick={() => onAnswer(false)}
        >
          거부 <span className="claude-modal-hint">접속 취소</span>
        </button>
      </div>
    </div>
  );
}
