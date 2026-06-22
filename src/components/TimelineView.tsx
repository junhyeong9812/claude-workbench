/** One Claude session's change timeline (B3/B4) — the right column of a Claude
 * tab: one continuous list of every tool call grouped by turn. Clicking an item
 * calls `onSelect`; the owning ClaudeTermPanel shows that item's content in a viewer
 * that splits the chat area (left), keeping this list as a single column.
 * Presentational; ClaudeTermPanel feeds it the items/turns for *its* session. */

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
  question: "❓",
  plan: "📋",
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
  subagents,
  selectedId,
  selectedTurn,
  onSelect,
  onSelectTurn,
}: {
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
  dates: Map<number, string>;
  /** [agentId, parentToolCallId|null, turn, items] per subagent (B1). Nested
   * under its parent Agent item (recursive tree); orphans nest under their turn. */
  subagents?: [string, string | null, number, TimelineItem[]][];
  selectedId: string | null;
  /** The turn whose question/answer is selected (highlights its head), or null.
   * Distinct from `selectedId` (a tool item) — they are mutually exclusive. */
  selectedTurn?: number | null;
  onSelect: (item: TimelineItem) => void;
  /** Select a turn (Q&A): view its prompt + full answer in the detail pane.
   * Used by ↑/↓ landing on a question head and by clicking the head/answer. */
  onSelectTurn?: (turn: number) => void;
}) {
  // Collapsed subagent groups (B1), keyed by agentId.
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());
  const toggleAgent = (key: string) =>
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Subagents indexed by parent tool-call id (for nesting) and, for those with
  // no known parent, by turn (fallback).
  const agentsByParent = new Map<string, [string, TimelineItem[]][]>();
  const orphanAgentsByTurn = new Map<number, [string, TimelineItem[]][]>();
  for (const [aid, parent, turn, its] of subagents ?? []) {
    if (parent) {
      const arr = agentsByParent.get(parent) ?? [];
      arr.push([aid, its]);
      agentsByParent.set(parent, arr);
    } else {
      const arr = orphanAgentsByTurn.get(turn) ?? [];
      arr.push([aid, its]);
      orphanAgentsByTurn.set(turn, arr);
    }
  }

  // One tool item + (recursively) any subagent groups spawned by it.
  const renderItem = (it: TimelineItem, sub: boolean): React.ReactNode => (
    <Fragment key={it.tool_call_id}>
      <div
        data-tcid={it.tool_call_id}
        className={`timeline-item ${sub ? "timeline-item-sub" : ""} ts-${it.agent_status} ${
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
        <span className={`timeline-status ts-${it.agent_status}`}>
          {AGENT_BADGE[it.agent_status] ?? ""}
        </span>
      </div>
      {(agentsByParent.get(it.tool_call_id) ?? []).map(([aid, its]) => renderAgent(aid, its))}
    </Fragment>
  );

  // A collapsible subagent group; its items render recursively (agent-in-agent).
  const renderAgent = (aid: string, its: TimelineItem[]): React.ReactNode => {
    const collapsed = collapsedAgents.has(aid);
    return (
      <div key={aid} className="timeline-agent">
        <div
          className="timeline-agent-head"
          onClick={() => toggleAgent(aid)}
          title={collapsed ? "펼치기" : "접기"}
        >
          <span className="timeline-date-caret">{collapsed ? "▸" : "▾"}</span>
          서브에이전트 {aid.slice(0, 8)}
          <span className="timeline-agent-count">{its.length}</span>
        </div>
        {!collapsed && its.map((it) => renderItem(it, true))}
      </div>
    );
  };
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

  // Unified ↑/↓ navigation order (matches the rendered order exactly: newest turn
  // first; within a turn the question head, then each tool item, then the subagent
  // items nested under it — recursively). Skips collapsed date groups (B8) and
  // collapsed subagent groups (B1), mirroring what is actually on screen. A turn
  // head is a `turn` entry; tool/agent items are `item` entries.
  type Nav = { kind: "turn"; turn: number } | { kind: "item"; item: TimelineItem };
  const navEntries: Nav[] = [];
  // Push an item then (recursively) the items of any non-collapsed subagent it spawned.
  const pushItemTree = (it: TimelineItem) => {
    navEntries.push({ kind: "item", item: it });
    for (const [aid, its] of agentsByParent.get(it.tool_call_id) ?? []) pushAgentItems(aid, its);
  };
  function pushAgentItems(aid: string, its: TimelineItem[]) {
    if (collapsedAgents.has(aid)) return; // collapsed group hides its rows
    for (const it of its) pushItemTree(it);
  }
  for (const turn of turnNos) {
    if (collapsedDates.has(dates.get(turn) ?? "")) continue;
    navEntries.push({ kind: "turn", turn });
    for (const it of items.filter((x) => x.turn === turn).sort((a, b) => a.seq - b.seq)) {
      pushItemTree(it);
    }
    for (const [aid, its] of orphanAgentsByTurn.get(turn) ?? []) pushAgentItems(aid, its);
  }

  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row (a tool item or a question head) scrolled into view as
  // the user arrows through it.
  useEffect(() => {
    if (!listRef.current) return;
    const sel = selectedId
      ? `[data-tcid="${CSS.escape(selectedId)}"]`
      : selectedTurn != null
        ? `[data-turn="${selectedTurn}"]`
        : null;
    if (sel) listRef.current.querySelector(sel)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, selectedTurn]);

  // A new question arrives at the top — scroll there so the current Q is in view (B5).
  const newestTurn = turnNos[0] ?? 0;
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [newestTurn]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (navEntries.length === 0) return;
    e.preventDefault();
    const idx = navEntries.findIndex((n) =>
      n.kind === "item"
        ? n.item.tool_call_id === selectedId
        : selectedTurn != null && n.turn === selectedTurn,
    );
    let next: number;
    if (idx === -1) next = e.key === "ArrowDown" ? 0 : navEntries.length - 1;
    else if (e.key === "ArrowDown") next = Math.min(idx + 1, navEntries.length - 1);
    else next = Math.max(idx - 1, 0);
    const n = navEntries[next];
    if (n.kind === "item") onSelect(n.item);
    else onSelectTurn?.(n.turn);
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
            <div
              data-turn={turn}
              className={`timeline-turn-head${
                selectedTurn === turn ? " timeline-turn-head-sel" : ""
              }`}
              title={prompt ?? ""}
              onClick={() => {
                onSelectTurn?.(turn);
                listRef.current?.focus();
              }}
              style={{ cursor: onSelectTurn ? "pointer" : undefined }}
            >
              <span className="timeline-turn-q">Q{turn}</span>
              {prompt ?? "(질문)"}
            </div>
            {answer && (
              <div
                className="timeline-answer"
                title="클릭하면 전체 답변 보기"
                onClick={() => onSelectTurn?.(turn)}
                style={{ cursor: onSelectTurn ? "pointer" : undefined }}
              >
                {answer.length > 140 ? `${answer.slice(0, 140)}…` : answer}
              </div>
            )}
            {turnItems.map((it) => renderItem(it, false))}
            {(orphanAgentsByTurn.get(turn) ?? []).map(([aid, its]) => renderAgent(aid, its))}
          </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

interface QOption {
  label?: string;
  description?: string;
}
interface QQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: QOption[];
}

/** Detail body for an `AskUserQuestion` item: each question with its full option
 * list, and the option(s) the user chose highlighted (matched against the tool
 * result text). The raw result is shown below as ground truth. */
function QuestionDetail({ item }: { item: TimelineItem }) {
  const raw = (item.raw_input ?? null) as { questions?: QQuestion[] } | null;
  const questions = Array.isArray(raw?.questions) ? (raw!.questions as QQuestion[]) : [];
  const chosen = item.content_text ?? "";
  // Best-effort: an option is "selected" if its label appears in the result text.
  const isSel = (label?: string) => !!label && label.trim() !== "" && chosen.includes(label);
  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON.question} {item.title || "질문"}
      </div>
      {questions.length === 0 && (
        <div className="timeline-detail-empty">질문 내용을 해석할 수 없습니다.</div>
      )}
      {questions.map((q, qi) => (
        <div key={qi} className="timeline-diff-block">
          {q.header && <div className="timeline-detail-label">{q.header}</div>}
          {q.question && <div className="tl-question-text">{q.question}</div>}
          <div className="tl-options">
            {(q.options ?? []).map((o, oi) => (
              <div key={oi} className={`tl-option${isSel(o.label) ? " tl-option-sel" : ""}`}>
                <div className="tl-option-label">
                  {isSel(o.label) ? "✓ " : ""}
                  {o.label}
                </div>
                {o.description && <div className="tl-option-desc">{o.description}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {chosen !== "" && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">선택 (응답)</div>
          <pre className="timeline-detail-text">{chosen}</pre>
        </div>
      )}
    </div>
  );
}

/** Detail body for an `ExitPlanMode` item: the proposed plan text. */
function PlanDetail({ item }: { item: TimelineItem }) {
  const raw = (item.raw_input ?? null) as { plan?: string } | null;
  const plan = typeof raw?.plan === "string" ? raw.plan : null;
  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON.plan} {item.title || "계획"}
      </div>
      <div className="timeline-diff-block">
        <div className="timeline-detail-label">계획</div>
        {plan != null ? (
          <pre className="timeline-detail-text">{plan}</pre>
        ) : (
          <div className="timeline-detail-empty">계획 내용이 없습니다.</div>
        )}
      </div>
      {item.content_text && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">응답</div>
          <pre className="timeline-detail-text">{item.content_text}</pre>
        </div>
      )}
    </div>
  );
}

/** The viewer body for the selected item (B4): the tool input (명령/경로), file
 * diffs (이전→이후), its text content (read result, output, 작성 내용), and — for
 * a read with no inline content — the file itself, fetched on demand. */
export function ItemDetail({ item }: { item: TimelineItem }) {
  // Bash (execute): show the command from raw_input prominently, then the output
  // (content_text), instead of a raw JSON dump.
  const bashCmd =
    item.kind === "execute"
      ? ((item.raw_input as { command?: string } | null)?.command ?? null)
      : null;
  const rawInput =
    item.raw_input != null && bashCmd == null ? JSON.stringify(item.raw_input, null, 2) : null;
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

  if (item.kind === "question") return <QuestionDetail item={item} />;
  if (item.kind === "plan") return <PlanDetail item={item} />;

  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON[item.kind] ?? "•"} {item.title || item.kind}
      </div>
      {bashCmd != null && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">명령</div>
          <pre className="timeline-detail-text">{bashCmd}</pre>
        </div>
      )}
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
