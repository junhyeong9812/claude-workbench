/** One Claude session's change timeline (B3/B4) — the right column of a Claude
 * tab: one continuous list of every tool call grouped by turn. Clicking an item
 * calls `onSelect`; the owning ClaudePanel shows that item's content in a viewer
 * that splits the chat area (left), keeping this list as a single column.
 * Presentational; ClaudePanel feeds it the items/turns for *its* session. */

import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

export const KIND_ICON: Record<string, string> = {
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

export const AGENT_BADGE: Record<string, string> = {
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
  dates,
  selectedId,
  onSelect,
}: {
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
  dates: Map<number, string>;
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
}) {
  // Every turn shows, even one with no tool calls (a plain Q&A): derive the
  // turn list from the union of prompts, answers, and items (B3). Newest turn
  // first — the current question sits at the top, older history below (B5).
  const turnNos = [
    ...new Set<number>([...turns.keys(), ...answers.keys(), ...items.map((it) => it.turn)]),
  ].sort((a, b) => b - a);

  // Collapsed date groups (B8): clicking a date header folds/unfolds its turns.
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(new Set());
  const toggleDate = (date: string) =>
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });

  // Flat display order (matches the rendered order: newest turn first, then seq
  // asc within a turn) for ↑/↓ navigation (B4). Skips collapsed date groups (B8).
  const orderedItems = turnNos
    .filter((turn) => !collapsedDates.has(dates.get(turn) ?? ""))
    .flatMap((turn) => items.filter((it) => it.turn === turn).sort((a, b) => a.seq - b.seq));

  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row scrolled into view as the user arrows through it.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-tcid="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // A new question arrives at the top — scroll there so the current Q is in view (B5).
  const newestTurn = turnNos[0] ?? 0;
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [newestTurn]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (orderedItems.length === 0) return;
    e.preventDefault();
    const idx = orderedItems.findIndex((it) => it.tool_call_id === selectedId);
    let next: number;
    if (idx === -1) next = e.key === "ArrowDown" ? 0 : orderedItems.length - 1;
    else if (e.key === "ArrowDown") next = Math.min(idx + 1, orderedItems.length - 1);
    else next = Math.max(idx - 1, 0);
    onSelect(orderedItems[next]);
  };

  // Insert a date divider whenever the date changes between turns (B6). Turns
  // are newest-first, so dates read newest→oldest down the list.
  let prevDate: string | null = null;
  const turnRows = turnNos.map((turn) => {
    const date = dates.get(turn) ?? "";
    const showDate = date !== "" && date !== prevDate;
    prevDate = date;
    return { turn, date, showDate };
  });

  return (
    <div className="timeline-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
      {turnNos.length === 0 && (
        <div className="timeline-empty">Claude에게 질문하면 여기에 쌓입니다.</div>
      )}
      {turnRows.map(({ turn, date, showDate }) => {
        const collapsed = collapsedDates.has(date);
        const turnItems = items.filter((it) => it.turn === turn).sort((a, b) => a.seq - b.seq);
        const prompt = turns.get(turn);
        const answer = answers.get(turn);
        return (
          <Fragment key={turn}>
            {showDate && (
              <div
                className="timeline-date"
                onClick={() => toggleDate(date)}
                title={collapsed ? "펼치기" : "접기"}
              >
                <span className="timeline-date-caret">{collapsed ? "▸" : "▾"}</span>
                {date}
              </div>
            )}
            {!collapsed && (
          <div className="timeline-turn">
            <div className="timeline-turn-head" title={prompt ?? ""}>
              <span className="timeline-turn-q">Q{turn}</span>
              {prompt ?? "(질문)"}
            </div>
            {answer && (
              <div className="timeline-answer" title={answer}>
                {answer.length > 140 ? `${answer.slice(0, 140)}…` : answer}
              </div>
            )}
            {turnItems.map((it) => (
              <div
                key={it.tool_call_id}
                data-tcid={it.tool_call_id}
                className={`timeline-item ts-${it.agent_status} ${
                  selectedId === it.tool_call_id ? "timeline-item-sel" : ""
                }`}
                title={it.locations.join("\n")}
                onClick={() => {
                  onSelect(it);
                  listRef.current?.focus();
                }}
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
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** The viewer body for the selected item (B4): the tool input (명령/경로), file
 * diffs (이전→이후), its text content (read result, output, 작성 내용), and — for
 * a read with no inline content — the file itself, fetched on demand. */
export function ItemDetail({ item }: { item: TimelineItem }) {
  const rawInput = item.raw_input != null ? JSON.stringify(item.raw_input, null, 2) : null;
  const firstPath = item.locations[0] ?? null;
  const hasContent = item.content_text != null && item.content_text !== "";
  // A read (or any location-only item) with no diff/content: show the file.
  const needsFile = item.diffs.length === 0 && !hasContent && firstPath != null;

  const [fileText, setFileText] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFileText(null);
    setFileErr(null);
    if (needsFile && firstPath) {
      invoke<string>("acp_read_file", { path: firstPath })
        .then((t) => {
          if (!cancelled) setFileText(t);
        })
        .catch((e) => {
          if (!cancelled) setFileErr(typeof e === "string" ? e : (e?.message ?? "읽기 실패"));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [item.tool_call_id, needsFile, firstPath]);

  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON[item.kind] ?? "•"} {item.title || item.kind}
      </div>
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
      {hasContent && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">내용</div>
          <pre className="timeline-detail-text">{item.content_text}</pre>
        </div>
      )}
      {needsFile && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-path">{firstPath}</div>
          {fileText != null && <pre className="timeline-detail-text">{fileText}</pre>}
          {fileErr != null && <div className="timeline-detail-empty">{fileErr}</div>}
          {fileText == null && fileErr == null && (
            <div className="timeline-detail-empty">불러오는 중…</div>
          )}
        </div>
      )}
    </div>
  );
}
