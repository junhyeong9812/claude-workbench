import { useState } from "react";
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
 * 팝오버가 이 관례를 따른다). 열고 닫는 것과 바깥 클릭 처리는 **호출자 소유**다:
 * 툴바(절대 배치)와 피커(흐름 배치)의 앵커가 서로 달라서, 이 컴포넌트가 배치를
 * 들고 있으면 둘 중 하나는 반드시 틀린다.
 */
export function AgentOptionsPopover({
  float = false,
  disabledReason,
  onStart,
  onClose,
}: {
  /** true = 앵커 기준 절대 배치(툴바 버튼 아래). false = 흐름 배치(피커 안). */
  float?: boolean;
  /** 지금 세션을 시작할 수 없는 이유(예: 열린 프로젝트 없음). 있으면 [시작] 비활성. */
  disabledReason?: string;
  onStart: (agent: AgentId, opts: AgentOptions) => void;
  onClose: () => void;
}) {
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
      className={`agent-opt-pop${float ? " agent-opt-pop-float" : ""}`}
      role="dialog"
      aria-label="새 세션 옵션"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
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
