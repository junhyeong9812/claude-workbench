/** One Claude session's change timeline (B3/B4) — the right column of a Claude
 * tab: one continuous list of every tool call grouped by turn. Clicking an item
 * calls `onSelect`; the owning ClaudeTermPanel shows that item's content in a viewer
 * that splits the chat area (left), keeping this list as a single column.
 * Presentational; ClaudeTermPanel feeds it the items/turns for *its* session. */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { isMarkdownPath } from "./markdown";

/** Render text as sanitized markdown (뷰모드). Same marked+DOMPurify pipeline as
 * the study viewer — the content is local session text, sanitized before inject. */
export function MarkdownText({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
        // Tool output / read results are rendered here — block media tags so a
        // `![x](https://attacker/…)` can't make the webview fetch a remote URL
        // just by opening the detail pane (codex).
        FORBID_TAGS: ["img", "picture", "source", "video", "audio", "iframe", "object", "embed"],
      }),
    [text],
  );
  return <div className="study-md tl-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

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
  selectedScope,
  scope = "live",
  followBottom = false,
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
  /** Which timeline owns the turn selection. Turn numbers repeat across the live
   * session and each previous task, so a turn is "selected here" only when this
   * view's `scope` matches `selectedScope` — otherwise the same number would
   * highlight/anchor nav in the wrong list. (Tool ids are globally unique, so
   * `selectedId` needs no scope.) */
  selectedScope?: string;
  scope?: string;
  /** When true, scroll the shared container to the bottom as new content arrives
   * (the live timeline). Previous-task lists leave this false. */
  followBottom?: boolean;
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
  // turn list from the union of prompts, answers, and items (B3). Chronological —
  // oldest at top, newest at the bottom (chat-like); the view follows new content
  // downward so the latest is always at the bottom.
  const turnNos = [
    ...new Set<number>([...turns.keys(), ...answers.keys(), ...items.map((it) => it.turn)]),
  ].sort((a, b) => a - b);

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

  // A turn is selected *in this view* only when this view owns the turn selection
  // (scope match) — turn numbers repeat across the live session and prior tasks.
  const turnSelected = (turn: number) => selectedTurn === turn && selectedScope === scope;

  // Keep the selected row (a tool item or a question head) scrolled into view as
  // the user arrows through it.
  useEffect(() => {
    if (!listRef.current) return;
    const sel = selectedId
      ? `[data-tcid="${CSS.escape(selectedId)}"]`
      : selectedTurn != null && selectedScope === scope
        ? `[data-turn="${selectedTurn}"]`
        : null;
    if (sel) listRef.current.querySelector(sel)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, selectedTurn, selectedScope, scope]);

  // New content arrives at the bottom — follow it down so the latest is in view.
  // Only the live timeline follows (followBottom). The stacked lists share one
  // scroll container, so we scroll that container (the first overflow ancestor),
  // not the content-sized inner list. Fires on *any* content growth (items stream
  // within a turn too), via rAF so layout is settled. Behavior: jump to bottom on
  // first load; afterwards stick to bottom only when already near it, so a manual
  // scroll-up to read history isn't yanked back down.
  // stickBottomRef starts true so a freshly opened (or reopened) timeline lands at
  // the bottom; the scroll listener flips it off when the user scrolls up to read
  // history and back on when they return near the bottom.
  const stickBottomRef = useRef(true);
  // Attach a scroll listener to the shared scroll container to track stickiness.
  useEffect(() => {
    if (!followBottom) return;
    let sc: HTMLElement | null = listRef.current?.parentElement ?? null;
    while (sc) {
      const oy = getComputedStyle(sc).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      sc = sc.parentElement;
    }
    if (!sc) return;
    const el = sc;
    const onScroll = () => {
      stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [followBottom]);
  // On any content growth (new turn or items streaming within a turn), follow to
  // the bottom while sticking. rAF so layout (heights) is settled first.
  useEffect(() => {
    if (!followBottom || !stickBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      let sc: HTMLElement | null = listRef.current?.parentElement ?? null;
      while (sc) {
        const oy = getComputedStyle(sc).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        sc = sc.parentElement;
      }
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [items, turnNos.length, followBottom]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (navEntries.length === 0) return;
    e.preventDefault();
    const idx = navEntries.findIndex((n) =>
      n.kind === "item" ? n.item.tool_call_id === selectedId : turnSelected(n.turn),
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
  // are oldest-first, so dates read oldest→newest down the list.
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
                turnSelected(turn) ? " timeline-turn-head-sel" : ""
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
  // Whether an option was chosen, matched against the result text. Precise on
  // purpose: a bare substring would mark "auto" selected when the answer is
  // "autonomous". Accept a quoted label (the AskUserQuestion result wraps answers
  // in quotes) or a whole line equal to the label.
  const isSel = (label?: string) => {
    const l = label?.trim();
    if (!l) return false;
    if (chosen.includes(`"${l}"`)) return true;
    return chosen.split(/\r?\n/).some((line) => line.trim() === l);
  };
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
        <div className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-label">선택 (응답)</div>
          <pre className="timeline-detail-text">{chosen}</pre>
        </div>
      )}
    </div>
  );
}

/** Detail body for an `ExitPlanMode` item: the proposed plan text (markdown). */
function PlanDetail({ item, markdown }: { item: TimelineItem; markdown: boolean }) {
  const raw = (item.raw_input ?? null) as { plan?: string } | null;
  const plan = typeof raw?.plan === "string" ? raw.plan : null;
  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON.plan} {item.title || "계획"}
      </div>
      <div className="timeline-diff-block" tabIndex={-1}>
        <div className="timeline-detail-label">계획</div>
        {plan != null ? (
          markdown ? (
            <MarkdownText text={plan} />
          ) : (
            <pre className="timeline-detail-text">{plan}</pre>
          )
        ) : (
          <div className="timeline-detail-empty">계획 내용이 없습니다.</div>
        )}
      </div>
      {item.content_text && (
        <div className="timeline-diff-block" tabIndex={-1}>
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
export function ItemDetail({ item, markdown = true }: { item: TimelineItem; markdown?: boolean }) {
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
  if (item.kind === "plan") return <PlanDetail item={item} markdown={markdown} />;

  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON[item.kind] ?? "•"} {item.title || item.kind}
      </div>
      {bashCmd != null && (
        <div className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-label">명령</div>
          <pre className="timeline-detail-text">{bashCmd}</pre>
        </div>
      )}
      {rawInput != null && (
        <div className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-label">입력</div>
          <pre className="timeline-detail-text">{rawInput}</pre>
        </div>
      )}
      {item.diffs.map((d, i) => (
        <div key={i} className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-path">{d.path}</div>
          {d.old_text != null && d.old_text !== "" && (
            <pre className="timeline-diff-old">{d.old_text}</pre>
          )}
          {markdown && isMarkdownPath(d.path) ? (
            <div className="timeline-diff-new-md">
              <MarkdownText text={d.new_text} />
            </div>
          ) : (
            <pre className="timeline-diff-new">{d.new_text}</pre>
          )}
        </div>
      ))}
      {hasContent && (
        <div className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-label">내용</div>
          {markdown ? (
            <MarkdownText text={item.content_text!} />
          ) : (
            <pre className="timeline-detail-text">{item.content_text}</pre>
          )}
        </div>
      )}
      {needsFile && (
        <div className="timeline-diff-block" tabIndex={-1}>
          <div className="timeline-detail-path">{firstPath}</div>
          {fileText != null &&
            (markdown ? (
              <MarkdownText text={fileText} />
            ) : (
              <pre className="timeline-detail-text">{fileText}</pre>
            ))}
          {fileErr != null && <div className="timeline-detail-empty">{fileErr}</div>}
          {fileText == null && fileErr == null && (
            <div className="timeline-detail-empty">불러오는 중…</div>
          )}
        </div>
      )}
    </div>
  );
}
