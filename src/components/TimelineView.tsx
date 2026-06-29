/** One Claude session's change timeline (B3/B4) — the right column of a Claude
 * tab: one continuous list of every tool call grouped by turn. Clicking an item
 * calls `onSelect`; the owning ClaudeTermPanel shows that item's content in a viewer
 * that splits the chat area (left), keeping this list as a single column.
 * Presentational; ClaudeTermPanel feeds it the items/turns for *its* session. */

import { Fragment, useEffect, useRef, useState } from "react";
import { isMarkdownPath, Markdown } from "./markdown";
import { useFileText } from "../hooks/useFileText";

/** Sanitized markdown for tool/session 뷰모드. Media tags are blocked here (unlike
 * the study viewer, which renders local images) — tool output may contain remote
 * `![](https://…)` that would make the webview fetch a URL on open. */
export function MarkdownText({ text }: { text: string }) {
  return <Markdown text={text} className="study-md tl-markdown" blockMedia />;
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
  /** Directory this call ran in (JSONL cwd). Differs from the session cwd when a
   * subagent works in an isolation worktree — used to label "another worktree". */
  cwd?: string | null;
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

/** Short uppercase work-type label shown in the timeline row's fixed-width first
 * column (P3) — replaces the emoji so rows read like an aligned activity log. The
 * detail pane keeps the emoji (KIND_ICON). */
export const KIND_LABEL: Record<string, string> = {
  read: "READ",
  edit: "EDIT",
  delete: "DEL",
  move: "MOVE",
  search: "FIND",
  execute: "RUN",
  think: "THINK",
  fetch: "WEB",
  question: "ASK",
  plan: "PLAN",
  other: "·",
};

export const AGENT_BADGE: Record<string, string> = {
  pending: "…",
  in_progress: "▶",
  completed: "✓",
  failed: "✗",
  canceled: "⊘",
};

/** Light path normalization for the worktree-label compare — strips trailing
 * slashes so `/repo` and `/repo/` don't read as different worktrees. (Symlink
 * canonicalization isn't available in the webview; same-spelling absolute paths,
 * which is the normal case, compare correctly.) */
const normPath = (p: string) => p.replace(/\/+$/, "");

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
  sessionCwd,
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
  /** The session's own cwd (project). An item whose `cwd` differs ran in another
   * worktree (a subagent isolation worktree) — labeled in the row. */
  sessionCwd?: string;
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

  // Collapsed turns: fold a whole Q&A (question + answer + its tool items) to its
  // head. The head stays as a ↑/↓ stop (unlike a collapsed *date*, which hides its
  // turns entirely). Keyed by turn number.
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  // The turn a tool item belongs to (searches top-level items and every subagent
  // group). Used to keep keyboard selection valid when a turn is collapsed.
  const itemTurn = (id: string): number | null => {
    for (const it of items) if (it.tool_call_id === id) return it.turn;
    for (const [, , turn, its] of subagents ?? [])
      for (const it of its) if (it.tool_call_id === id) return turn;
    return null;
  };
  const toggleTurn = (turn: number) => {
    const collapsing = !collapsedTurns.has(turn);
    // If the selected item is about to be hidden, promote selection to the turn
    // head so ↑/↓ keeps a valid anchor (else findIndex→-1 jumps to the list end).
    if (collapsing && selectedId && itemTurn(selectedId) === turn) onSelectTurn?.(turn);
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  };

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

  // Render-pass cycle/dup guards: the same self-referential subagent graph that
  // could overflow the nav builder would overflow the recursive render below — and
  // also duplicate React keys. Each item/agent renders at most once per pass.
  const renderSeenItem = new Set<string>();
  const renderSeenAgent = new Set<string>();
  // One tool item + (recursively) any subagent groups spawned by it.
  const renderItem = (it: TimelineItem, sub: boolean): React.ReactNode => {
    if (renderSeenItem.has(it.tool_call_id)) return null;
    renderSeenItem.add(it.tool_call_id);
    return (
    <Fragment key={it.tool_call_id}>
      <div
        data-tcid={it.tool_call_id}
        className={`timeline-item ${sub ? "timeline-item-sub" : ""} ${
          it.kind === "think" ? "timeline-item-think" : ""
        } ts-${it.agent_status} ${selectedId === it.tool_call_id ? "timeline-item-sel" : ""}`}
        title={it.locations.join("\n")}
        onClick={() => {
          onSelect(it);
          listRef.current?.focus();
        }}
      >
        <span className={`timeline-kind${it.kind === "delete" ? " timeline-kind-del" : ""}`}>
          {KIND_LABEL[it.kind] ?? "·"}
        </span>
        <span className="timeline-title">{it.title || it.kind}</span>
        {it.project_label && <span className="timeline-label">{it.project_label}</span>}
        {it.cwd && sessionCwd && normPath(it.cwd) !== normPath(sessionCwd) && (
          <span className="timeline-worktree" title={`다른 워크트리에서 실행:\n${it.cwd}`}>
            ⌥ {it.cwd.replace(/\/$/, "").split("/").pop()}
          </span>
        )}
        {it.diffs.length > 0 && <span className="timeline-diff">±{it.diffs.length}</span>}
        {it.write_status === "written" && <span className="timeline-write">💾</span>}
        <span className={`timeline-status ts-${it.agent_status}`}>
          {AGENT_BADGE[it.agent_status] ?? ""}
        </span>
      </div>
      {(agentsByParent.get(it.tool_call_id) ?? []).map(([aid, its]) => renderAgent(aid, its))}
    </Fragment>
    );
  };

  // A collapsible subagent group; its items render recursively (agent-in-agent).
  const renderAgent = (aid: string, its: TimelineItem[]): React.ReactNode => {
    if (renderSeenAgent.has(aid)) return null;
    renderSeenAgent.add(aid);
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
  // Cycle/dup guards: a corrupt or self-referential subagent graph (an item whose
  // spawned agent's items lead back to it) would otherwise recurse forever and
  // overflow the stack — crashing the whole panel to a black screen. Each item and
  // each agent is visited at most once.
  const seenItem = new Set<string>();
  const seenAgent = new Set<string>();
  // Push an item then (recursively) the items of any non-collapsed subagent it spawned.
  const pushItemTree = (it: TimelineItem) => {
    if (seenItem.has(it.tool_call_id)) return;
    seenItem.add(it.tool_call_id);
    navEntries.push({ kind: "item", item: it });
    for (const [aid, its] of agentsByParent.get(it.tool_call_id) ?? []) pushAgentItems(aid, its);
  };
  function pushAgentItems(aid: string, its: TimelineItem[]) {
    if (collapsedAgents.has(aid)) return; // collapsed group hides its rows
    if (seenAgent.has(aid)) return; // cycle guard
    seenAgent.add(aid);
    for (const it of its) pushItemTree(it);
  }
  for (const turn of turnNos) {
    if (collapsedDates.has(dates.get(turn) ?? "")) continue;
    navEntries.push({ kind: "turn", turn });
    if (collapsedTurns.has(turn)) continue; // folded turn: head is the only stop
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
  // Follow content growth to the bottom while sticking. A ResizeObserver on the
  // content catches EVERY height change — new turns, items streaming within a turn,
  // answer text growing, detail rows expanding, async/font layout — not just the
  // [items, turnNos] deps a plain effect would see (which miss text/async growth,
  // the cause of the timeline not scrolling down as content streams). It also fires
  // once on observe, so a freshly opened timeline lands at the bottom. Setting
  // scrollTop doesn't change content size, so there's no observer feedback loop.
  useEffect(() => {
    if (!followBottom) return;
    const content = listRef.current;
    if (!content) return;
    let sc: HTMLElement | null = content.parentElement;
    while (sc) {
      const oy = getComputedStyle(sc).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      sc = sc.parentElement;
    }
    if (!sc) return;
    const el = sc;
    const ro = new ResizeObserver(() => {
      if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [followBottom]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter/Space folds the selected turn head (keyboard reach for the caret).
    if (e.key === "Enter" || e.key === " ") {
      if (selectedTurn != null && selectedScope === scope) {
        e.preventDefault();
        toggleTurn(selectedTurn);
      }
      return;
    }
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
            {!collapsed && (() => {
              const tCollapsed = collapsedTurns.has(turn);
              const diffCount = turnItems.reduce((a, it) => a + it.diffs.length, 0);
              return (
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
              <span
                className="timeline-turn-caret"
                role="button"
                aria-expanded={!tCollapsed}
                title={tCollapsed ? "펼치기" : "접기"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleTurn(turn);
                }}
              >
                {tCollapsed ? "▸" : "▾"}
              </span>
              <span className="timeline-turn-q">Q{turn}</span>
              <span className="timeline-turn-prompt">{prompt ?? "(질문)"}</span>
              {tCollapsed && (turnItems.length > 0 || diffCount > 0) && (
                <span className="timeline-turn-sum">
                  {diffCount > 0 ? `±${diffCount} · ` : ""}
                  {turnItems.length} tools
                </span>
              )}
            </div>
            {!tCollapsed && answer && (
              <div
                className="timeline-answer"
                title="클릭하면 전체 답변 보기"
                onClick={() => onSelectTurn?.(turn)}
                style={{ cursor: onSelectTurn ? "pointer" : undefined }}
              >
                {answer.length > 140 ? `${answer.slice(0, 140)}…` : answer}
              </div>
            )}
            {!tCollapsed && turnItems.map((it) => renderItem(it, false))}
            {!tCollapsed &&
              (orphanAgentsByTurn.get(turn) ?? []).map(([aid, its]) => renderAgent(aid, its))}
          </div>
              );
            })()}
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

  // Fetch the file only for a location-only item (read with no inline content).
  // refreshKey = tool_call_id so selecting a different item re-reads even when it
  // points at the same path (matches the original per-item reset/re-fetch).
  const { text: fileText, err: fileErr } = useFileText(
    needsFile ? firstPath : null,
    "읽기 실패",
    item.tool_call_id,
  );

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
            (markdown && !!firstPath && isMarkdownPath(firstPath) ? (
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
