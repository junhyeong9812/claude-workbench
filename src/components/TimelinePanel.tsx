import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirror of `core::TimelineItem` (serde snake_case) + relay `id` + `turn`. */
interface TimelineItem {
  id: number;
  type: "timeline_item";
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

interface TurnStarted {
  id: number;
  type: "turn_started";
  turn: number;
  prompt: string;
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

/**
 * The change-timeline sidebar (P2b-2 S3), structured **session → turn → change**:
 * each Claude session (AcpHost id) owns its own stream (`seq` is per-session),
 * and within a session every prompt opens a turn whose tool calls are listed
 * beneath it. Persistence + restart-restore land in S3b.
 */
export function TimelinePanel(_props: IDockviewPanelProps) {
  const [items, setItems] = useState<Map<string, TimelineItem>>(new Map());
  // `${id}:${turn}` -> the prompt that opened that turn.
  const [turns, setTurns] = useState<Map<string, string>>(new Map());
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    listen<TimelineItem | TurnStarted>("acp-event", (e) => {
      const p = e.payload;
      if (p.type === "timeline_item") {
        setItems((prev) => {
          const next = new Map(prev);
          next.set(`${p.session_id}:${p.tool_call_id}`, p);
          return next;
        });
      } else if (p.type === "turn_started") {
        setTurns((prev) => {
          const next = new Map(prev);
          next.set(`${p.id}:${p.turn}`, p.prompt);
          return next;
        });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, turns]);

  const all = [...items.values()];
  const sessionIds = [...new Set(all.map((it) => it.id))].sort((a, b) => a - b);

  return (
    <div className="timeline-panel">
      <div className="timeline-head">
        변경 타임라인 · {all.length}
        {sessionIds.length > 1 && ` · 세션 ${sessionIds.length}`}
      </div>
      <div className="timeline-list" ref={logRef}>
        {all.length === 0 && (
          <div className="timeline-empty">Claude가 도구를 실행하면 여기에 쌓입니다.</div>
        )}
        {sessionIds.map((sid) => {
          const sessionItems = all.filter((it) => it.id === sid);
          const turnNos = [...new Set(sessionItems.map((it) => it.turn))].sort((a, b) => a - b);
          return (
            <div key={sid} className="timeline-session">
              {sessionIds.length > 1 && (
                <div className="timeline-session-head">Claude 세션 #{sid}</div>
              )}
              {turnNos.map((turn) => {
                const turnItems = sessionItems
                  .filter((it) => it.turn === turn)
                  .sort((a, b) => a.seq - b.seq);
                const prompt = turns.get(`${sid}:${turn}`);
                return (
                  <div key={turn} className="timeline-turn">
                    <div className="timeline-turn-head" title={prompt ?? ""}>
                      <span className="timeline-turn-q">Q{turn}</span>
                      {prompt ?? "(질문)"}
                    </div>
                    {turnItems.map((it) => (
                      <div
                        key={`${it.session_id}:${it.tool_call_id}`}
                        className={`timeline-item ts-${it.agent_status}`}
                        title={it.locations.join("\n")}
                      >
                        <span className="timeline-icon">{KIND_ICON[it.kind] ?? "•"}</span>
                        <span className="timeline-title">{it.title || it.kind}</span>
                        {it.project_label && (
                          <span className="timeline-label">{it.project_label}</span>
                        )}
                        {it.diffs.length > 0 && (
                          <span className="timeline-diff">±{it.diffs.length}</span>
                        )}
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
        })}
      </div>
    </div>
  );
}
