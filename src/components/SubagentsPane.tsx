import { useState } from "react";
import { AGENT_BADGE, KIND_LABEL, type TimelineItem } from "./TimelineView";
import type { SubagentView } from "../hooks/useClaudeTimeline";

/** Vertical stack of live subagent cards (Claude 패널의 "서브" 칼럼): every
 * agent of the session at once — 진행상황을 탭 전환 없이 나란히 본다. Each card
 * is the agent's item list (KIND rows, same styling as the timeline) with the
 * done/total progress rail; clicking a row opens it in the shared detail
 * viewer. Data is the timeline payload's `subagents`. 진행도·상태는 메타라 항상
 * 있고, **완료 에이전트의 본문은 lazy**다 — 카드를 펼칠 때 `onExpand`가 조회한다
 * (payload 절감 1단계). */
export function SubagentsPane({
  subagents,
  selectedId,
  onSelect,
  onExpand,
}: {
  subagents: SubagentView[];
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
  /** 완료 에이전트 본문 요청(펼침·재시도). */
  onExpand?: (agentId: string, force?: boolean) => void;
}) {
  // User fold overrides; without one, a finished agent starts collapsed (the
  // column is about live progress) — bounding the DOM on agent-heavy sessions.
  const [folds, setFolds] = useState<Map<string, boolean>>(new Map());
  const toggle = (a: SubagentView, current: boolean) => {
    setFolds((prev) => new Map(prev).set(a.id, !current));
    if (current && !a.loaded) onExpand?.(a.id); // 접힘→펼침 = 본문 요청
  };

  // Newest spawn first — the agents being watched are almost always the latest.
  const agents = [...subagents].sort((a, b) => b.turn - a.turn);

  if (agents.length === 0) {
    return <div className="claudeterm-agents-empty">서브에이전트가 아직 없습니다.</div>;
  }

  return (
    <div className="claudeterm-agents-list">
      {agents.map((a) => {
        // 카운트·진행 여부는 **메타**에서 — 본문이 lazy라 없어도 같은 값이다.
        const { id: aid, turn, total, completed: done } = a;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const running = a.lastStatus === "in_progress" || a.lastStatus === "pending";
        const fold = folds.get(aid) ?? !running; // finished agents start folded
        // Bound each card's DOM — a runaway agent can log thousands of items.
        const MAX_ROWS = 200;
        const its = a.items;
        const rows = its.length > MAX_ROWS ? its.slice(-MAX_ROWS) : its;
        return (
          <div key={aid} className="claudeterm-agent-card">
            <div className="timeline-agent-rail" title={`${done}/${total} 완료`}>
              <div className="timeline-agent-rail-fill" style={{ width: `${pct}%` }} />
            </div>
            <div
              className="claudeterm-agent-card-head"
              onClick={() => toggle(a, fold)}
              title={fold ? "펼치기" : "접기"}
            >
              <span className="timeline-date-caret">{fold ? "▸" : "▾"}</span>
              <span className={`claudeterm-agent-dot${running ? " on" : ""}`} />
              {aid.slice(0, 8)} · T{turn}
              <span className="timeline-agent-count">
                {done}/{total}
              </span>
            </div>
            {/* 본문 lazy — 도착 전/실패를 명시(빈 카드로 보이면 안 된다).
                조회 중이 아닌 미도착은 클릭 가능한 안내로 둔다(영영 오지 않는
                "불러오는 중" 금지 — 타임라인 그룹과 같은 규칙). */}
            {!fold && !a.loaded && (
              <div
                className="claudeterm-agents-empty"
                onClick={a.loading ? undefined : () => onExpand?.(aid, true)}
                title={a.loading ? undefined : "본문 불러오기"}
              >
                {a.loading
                  ? "불러오는 중…"
                  : a.failed
                    ? "불러오지 못했습니다 — 클릭해 다시 시도"
                    : "본문 불러오기 (클릭)"}
              </div>
            )}
            {!fold && its.length > MAX_ROWS && (
              <div className="claudeterm-agents-empty">…앞 {its.length - MAX_ROWS}개 생략</div>
            )}
            {!fold &&
              rows.map((it) => (
                <div
                  key={it.tool_call_id}
                  className={`timeline-item ${
                    it.kind === "think" ? "timeline-item-think" : ""
                  } ts-${it.agent_status} ${
                    selectedId === it.tool_call_id ? "timeline-item-sel" : ""
                  }`}
                  title={it.locations.join("\n")}
                  onClick={() => onSelect(it)}
                >
                  <span
                    className={`timeline-kind${it.kind === "delete" ? " timeline-kind-del" : ""}`}
                  >
                    {KIND_LABEL[it.kind] ?? "·"}
                  </span>
                  <span className="timeline-title">{it.title || it.kind}</span>
                  {it.diffs.length > 0 && <span className="timeline-diff">±{it.diffs.length}</span>}
                  <span className={`timeline-status ts-${it.agent_status}`}>
                    {AGENT_BADGE[it.agent_status] ?? ""}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
