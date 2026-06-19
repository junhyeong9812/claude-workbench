/** One Claude session's change timeline, grouped by turn (the prompt that
 * produced the changes). Presentational — the owning ClaudePanel feeds it the
 * items/turns it accumulated for *its* session. Clicking an item expands its
 * change content (diff / locations) inline, in timeline order (B4). */

import { useState } from "react";

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
  content_text: string | null;
  raw_input: unknown;
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
  answers,
}: {
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
}) {
  // Which items are expanded to show their change content (B4).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Every turn shows, even one with no tool calls (a plain Q&A): derive the
  // turn list from the union of prompts, answers, and items (B3).
  const turnNos = [
    ...new Set<number>([...turns.keys(), ...answers.keys(), ...items.map((it) => it.turn)]),
  ].sort((a, b) => a - b);

  return (
    <div className="timeline-list">
      {turnNos.length === 0 && (
        <div className="timeline-empty">Claude에게 질문하면 여기에 쌓입니다.</div>
      )}
      {turnNos.map((turn) => {
        const turnItems = items.filter((it) => it.turn === turn).sort((a, b) => a.seq - b.seq);
        const prompt = turns.get(turn);
        const answer = answers.get(turn);
        return (
          <div key={turn} className="timeline-turn">
            <div className="timeline-turn-head" title={prompt ?? ""}>
              <span className="timeline-turn-q">Q{turn}</span>
              {prompt ?? "(질문)"}
            </div>
            {answer && (
              <div className="timeline-answer" title={answer}>
                {answer.length > 140 ? `${answer.slice(0, 140)}…` : answer}
              </div>
            )}
            {turnItems.map((it) => {
              const open = expanded.has(it.tool_call_id);
              return (
                <div key={it.tool_call_id}>
                  <div
                    className={`timeline-item ts-${it.agent_status} ${open ? "timeline-item-open" : ""}`}
                    title={it.locations.join("\n")}
                    onClick={() => toggle(it.tool_call_id)}
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
                  {open && <ItemDetail item={it} />}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** The expanded content for a clicked item (B4): the tool's input (명령/경로),
 * file diffs (이전→이후) for edits, its text content (read result, output,
 * 작성 내용), and touched locations. Monospace, terminal-like. */
function ItemDetail({ item }: { item: TimelineItem }) {
  const rawInput =
    item.raw_input != null ? JSON.stringify(item.raw_input, null, 2) : null;
  const hasAny =
    rawInput != null ||
    item.diffs.length > 0 ||
    (item.content_text != null && item.content_text !== "") ||
    item.locations.length > 0;

  return (
    <div className="timeline-detail">
      {rawInput != null && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">입력</div>
          <pre className="timeline-detail-text">{rawInput}</pre>
        </div>
      )}
      {item.diffs.map((d, i) => (
        <div key={i} className="timeline-diff-block">
          <div className="timeline-detail-path">{d.path}</div>
          {d.old_text != null && d.old_text !== "" && (
            <pre className="timeline-diff-old">{d.old_text}</pre>
          )}
          <pre className="timeline-diff-new">{d.new_text}</pre>
        </div>
      ))}
      {item.content_text != null && item.content_text !== "" && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">내용</div>
          <pre className="timeline-detail-text">{item.content_text}</pre>
        </div>
      )}
      {item.diffs.length === 0 &&
        item.locations.map((p, i) => (
          <div key={i} className="timeline-detail-path">
            {p}
          </div>
        ))}
      {!hasAny && <div className="timeline-detail-empty">표시할 내용이 없습니다.</div>}
    </div>
  );
}
