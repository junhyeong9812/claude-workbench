import { useEffect, useRef, useState } from "react";
import { EffortSelect, ModelSelect } from "./AgentOptionFields";
import {
  AGENT_CHOICES,
  loadAgentOptions,
  loadLastAgent,
  saveAgentOptions,
  saveLastAgent,
  type AgentId,
  type AgentOptions,
} from "../state/agentOptions";

/**
 * 새 세션 옵션 팝오버 — 에이전트 · 모델 · 강도를 고르고 [시작].
 *
 * 세션이 뜬 뒤엔 모델도 강도도 못 바꾼다(스폰 인자 — 바꾸려면 재스폰 = 대화
 * 파기). 그래서 이 UI는 **생성 전**에만 존재하고, 고른 값은 기억된다: 보통
 * 클릭(그냥 "+ 만들기")은 마지막 설정을 그대로 재사용하고, 이 팝오버는 그
 * 설정을 바꾸고 싶을 때만 연다.
 *
 * 렌더는 상태 플래그 + 인라인이다(코드베이스에 createPortal 사용처 0건 — 모든
 * 팝오버가 이 관례를 따른다). **배치만** 호출자 소유다(툴바=절대, 피커=흐름 —
 * 앵커가 달라 한쪽은 반드시 틀린다). 반대로 **포커스·닫힘 계약은 여기 한 곳에
 * 모은다**: 호출자마다 따로 두면 두 벌이 갈라지고, 팝오버가 Escape를 삼키면
 * (stopPropagation) 호출자 쪽 복원 코드는 영영 돌지 않는다.
 *
 * 계약:
 * - 열릴 때 첫 컨트롤로 1회 포커스 이동
 * - 바깥 클릭 → 닫힘 (**트리거는 바깥이 아니다** — 제외하지 않으면 mousedown이
 *   닫고 뒤이은 click이 다시 열어 ▾ 토글이 죽는다)
 * - Escape → 닫으면서 트리거로 포커스 복원. 바깥 클릭과 [시작]은 복원하지
 *   않는다: 전자는 사용자가 이미 다른 곳을 눌렀고, 후자는 새 세션이 포커스를
 *   가져간다. 되돌리면 그게 오히려 포커스를 훔치는 것이 된다.
 */
export function AgentOptionsPopover({
  float = false,
  disabledReason,
  triggerRef,
  onStart,
  onClose,
}: {
  /** true = 앵커 기준 절대 배치(툴바 버튼 아래). false = 흐름 배치(피커 안). */
  float?: boolean;
  /** 지금 세션을 시작할 수 없는 이유(예: 열린 프로젝트 없음). 있으면 [시작] 비활성. */
  disabledReason?: string;
  /** 이 팝오버를 연 ▾ 버튼 — 바깥 클릭 판정에서 제외하고 Escape 때 포커스를 돌려준다. */
  triggerRef?: { current: HTMLButtonElement | null };
  onStart: (agent: AgentId, opts: AgentOptions) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);

  // 열릴 때 1회만 첫 컨트롤로. 콜백 ref로 하면 매 렌더 재실행되어 사용자가
  // select를 고르는 도중 포커스를 훔친다(외관 팝오버 A10의 교훈).
  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>("button:not(:disabled), select")?.focus();
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (triggerRef?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 초기값 = 이 에이전트로 마지막에 연 설정. 함수형 초기화라 매 렌더 읽지 않는다.
  const [agent, setAgent] = useState<AgentId>(loadLastAgent);
  const [opts, setOpts] = useState<AgentOptions>(() => loadAgentOptions(loadLastAgent()));

  // 에이전트를 바꾸면 그 에이전트의 기억을 다시 읽는다 — 값 어휘가 서로 달라서
  // (claude의 xhigh는 codex에 없다) 현재 선택을 들고 넘어가면 안 된다.
  const pickAgent = (id: AgentId) => {
    setAgent(id);
    setOpts(loadAgentOptions(id));
  };

  const start = () => {
    saveLastAgent(agent);
    saveAgentOptions(agent, opts);
    onStart(agent, opts);
  };

  return (
    <div
      ref={popRef}
      className={`agent-opt-pop${float ? " agent-opt-pop-float" : ""}`}
      role="dialog"
      aria-label="새 세션 옵션"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // 삼키는 것이 의도다 — 피커 안에서는 Escape가 피커 전체를 닫는 키라,
        // 옵션만 접으려던 사용자가 목록까지 잃으면 안 된다.
        e.stopPropagation();
        triggerRef?.current?.focus();
        onClose();
      }}
    >
      <div className="agent-opt-row">
        <span className="agent-opt-label">에이전트</span>
        <div className="seg" role="group" aria-label="에이전트">
          {AGENT_CHOICES.map((a) => (
            <button
              key={a.id}
              className={`seg-item${agent === a.id ? " seg-on" : ""}`}
              aria-pressed={agent === a.id}
              disabled={!a.enabled}
              title={a.hint}
              onClick={() => pickAgent(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="agent-opt-row">
        <span className="agent-opt-label">모델</span>
        <ModelSelect
          value={opts.model}
          defaultLabel="기본 (미지정)"
          ariaLabel="모델"
          title="세션의 모델은 스폰될 때 정해집니다 — 나중에 바꾸려면 재스폰(대화 파기)입니다"
          onChange={(v) => setOpts((o) => ({ ...o, model: v }))}
        />
      </div>
      <div className="agent-opt-row">
        <span className="agent-opt-label">강도</span>
        <EffortSelect
          value={opts.effort}
          defaultLabel="기본 (미지정)"
          ariaLabel="추론 강도"
          title="추론 강도(--effort) — 미지정이면 CLI 기본값을 씁니다"
          onChange={(v) => setOpts((o) => ({ ...o, effort: v }))}
        />
      </div>
      <div className="agent-opt-foot">
        <span className="agent-opt-hint">
          {disabledReason ?? "고른 설정은 다음 새 세션의 기본이 됩니다"}
        </span>
        <button
          className="agent-opt-start"
          disabled={disabledReason !== undefined}
          title={disabledReason ?? "이 설정으로 새 세션을 시작합니다"}
          onClick={start}
        >
          시작
        </button>
      </div>
    </div>
  );
}
