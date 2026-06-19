/** One Claude session's change timeline, grouped by turn (the prompt that
 * produced the changes). Presentational — the owning ClaudePanel feeds it the
 * items/turns it accumulated for *its* session. */

export interface TimelineItem {
  turn: number;
  session_id: string;
  tool_call_id: string;
  seq: number;
  kind: string;
  title: string;
  locations: string[];
  project_label: string | null;
  diffs: { path: string; old_text: string | null; new_text: string }[];
  agent_status: string;
  write_status: string;
  revision: number;
}

const KIND_ICON: Record<string, string> = {
  read: "📖",
  edit: "✎",
  delete: "🗑",
  move: "↪",
  search: "🔍",
  execute: "▶",
  think: "💭",
  fetch: "🌐",
  other: "•",
};

const AGENT_BADGE: Record<string, string> = {
  pending: "…",
  in_progress: "▶",
  completed: "✓",
  failed: "✗",
  canceled: "⊘",
};

export function TimelineView({
  items,
  turns,
}: {
  items: TimelineItem[];
  turns: Map<number, string>;
}) {
  const turnNos = [...new Set(items.map((it) => it.turn))].sort((a, b) => a - b);

  return (
    <div className="timeline-list">
      {items.length === 0 && (
        <div className="timeline-empty">Claude가 도구를 실행하면 여기에 쌓입니다.</div>
      )}
      {turnNos.map((turn) => {
        const turnItems = items.filter((it) => it.turn === turn).sort((a, b) => a.seq - b.seq);
        const prompt = turns.get(turn);
        return (
          <div key={turn} className="timeline-turn">
            <div className="timeline-turn-head" title={prompt ?? ""}>
              <span className="timeline-turn-q">Q{turn}</span>
              {prompt ?? "(질문)"}
            </div>
            {turnItems.map((it) => (
              <div
                key={it.tool_call_id}
                className={`timeline-item ts-${it.agent_status}`}
                title={it.locations.join("\n")}
              >
                <span className="timeline-icon">{KIND_ICON[it.kind] ?? "•"}</span>
                <span className="timeline-title">{it.title || it.kind}</span>
                {it.project_label && <span className="timeline-label">{it.project_label}</span>}
                {it.diffs.length > 0 && <span className="timeline-diff">±{it.diffs.length}</span>}
                {it.write_status === "written" && <span className="timeline-write">💾</span>}
                {it.write_status === "write_failed" && (
                  <span className="timeline-write timeline-write-fail">⚠</span>
                )}
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
