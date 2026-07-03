import { useState } from "react";
import { AGENT_BADGE, KIND_LABEL, type TimelineItem } from "./TimelineView";

/** Vertical stack of live subagent cards (Claude 패널의 "서브" 칼럼): every
 * agent of the session at once — 진행상황을 탭 전환 없이 나란히 본다. Each card
 * is the agent's item list (KIND rows, same styling as the timeline) with the
 * done/total progress rail; clicking a row opens it in the shared detail
 * viewer. Data is the timeline payload's `subagents` — 순수 렌더링, no extra
 * backend traffic. */
export function SubagentsPane({
  subagents,
  selectedId,
  onSelect,
}: {
  /** [agentId, parentToolCallId|null, turn, items] — the timeline payload shape. */
  subagents: [string, string | null, number, TimelineItem[]][];
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
}) {
  // User fold overrides; without one, a finished agent starts collapsed (the
  // column is about live progress) — bounding the DOM on agent-heavy sessions.
  const [folds, setFolds] = useState<Map<string, boolean>>(new Map());
  const toggle = (aid: string, current: boolean) =>
    setFolds((prev) => new Map(prev).set(aid, !current));

  // Newest spawn first — the agents being watched are almost always the latest.
  const agents = [...subagents].sort((a, b) => b[2] - a[2]);

  if (agents.length === 0) {
    return <div className="claudeterm-agents-empty">서브에이전트가 아직 없습니다.</div>;
  }

  return (
    <div className="claudeterm-agents-list">
      {agents.map(([aid, , turn, its]) => {
        const total = its.length;
        const done = its.filter((it) => it.agent_status === "completed").length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const last = its[its.length - 1];
        const running =
          last?.agent_status === "in_progress" || last?.agent_status === "pending";
        const fold = folds.get(aid) ?? !running; // finished agents start folded
        // Bound each card's DOM — a runaway agent can log thousands of items.
        const MAX_ROWS = 200;
        const rows = its.length > MAX_ROWS ? its.slice(-MAX_ROWS) : its;
        return (
          <div key={aid} className="claudeterm-agent-card">
            <div className="timeline-agent-rail" title={`${done}/${total} 완료`}>
              <div className="timeline-agent-rail-fill" style={{ width: `${pct}%` }} />
            </div>
            <div
              className="claudeterm-agent-card-head"
              onClick={() => toggle(aid, fold)}
              title={fold ? "펼치기" : "접기"}
            >
              <span className="timeline-date-caret">{fold ? "▸" : "▾"}</span>
              <span className={`claudeterm-agent-dot${running ? " on" : ""}`} />
              {aid.slice(0, 8)} · T{turn}
              <span className="timeline-agent-count">
                {done}/{total}
              </span>
            </div>
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
