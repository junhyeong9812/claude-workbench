import { create } from "zustand";

/** Per-session attention state for the tab badges + toolbar roll-up (P1 core).
 *
 * This store is a per-window singleton (module scope = one webview context), so a
 * popped-out window derives its own sessions' badges from the same global
 * `claude-timeline` broadcast — matching the "창별 독립" requirement. It never
 * touches the JSONL mapper / PTY: status is *derived* from the timeline snapshot
 * the panel already receives, plus an optional screen-scan blocked signal (P2).
 *
 * Display priority (attentionOf): blocked > done-unseen > working > idle.
 *  - `blocked`   — an open AskUserQuestion, or (P2) a screen-scan chrome match.
 *                  Immediate (no hold), wins over activity.
 *  - done-unseen — work finished (quiet, hold-confirmed) and the panel wasn't
 *                  seen (active + window-focused) at completion. `unseen: true`.
 *  - `working`   — a turn is in flight, or a tool is pending/in_progress.
 *  - `idle`      — quiet and either already seen or never worked.
 */

export type SessionStatus = "blocked" | "working" | "idle";

/** Timeline-derived activity, before the working→quiet hold is applied. */
export type SessionActivity = "working" | "quiet";

/** Minimal shape the pure derivations read off a `TimelineItem` — kept local so
 * this module has no dependency on the React timeline component (vitest-friendly).
 * `TimelineItem` structurally satisfies it. */
export interface ActivityItem {
  kind: string;
  agent_status: string;
}

/** A tool call that is still outstanding (request sent, no result yet). Mirrors
 * core's AgentStatus serde values (see `AGENT_BADGE` in TimelineView). */
function isOpenTool(status: string): boolean {
  return status === "pending" || status === "in_progress";
}

/**
 * Is this session actively working? "working" when the latest turn has a prompt
 * but no assistant answer yet (`answers` holds the assistant text per turn — see
 * core `map.rs` `self.answers.entry(turn)`), OR any tool item is still open.
 * Otherwise "quiet". Pure; `turns`/`answers` are the `[turn, text][]` arrays from
 * the `claude-timeline` payload (ClaudeTermPanel.tsx:691).
 */
export function deriveSessionActivity(
  turns: readonly [number, string][],
  answers: readonly [number, string][],
  items: readonly ActivityItem[],
): SessionActivity {
  let latest = -Infinity;
  for (const [t] of turns) if (t > latest) latest = t;
  const answered = new Set(answers.map(([t]) => t));
  const turnWorking = latest > -Infinity && !answered.has(latest);
  const toolWorking = items.some((it) => isOpenTool(it.agent_status));
  return turnWorking || toolWorking ? "working" : "quiet";
}

/**
 * Is there an open (unanswered) AskUserQuestion? A `question` item is opened at
 * `in_progress` by its tool_use and completed by its tool_result (core `map.rs`
 * spec ①②, verified by `ask_user_question_maps_to_question`), so "open" ==
 * kind "question" with a still-outstanding agent_status. This is a reliable
 * field-based judgment — no need for the turn-position approximation.
 */
export function hasOpenQuestion(items: readonly ActivityItem[]): boolean {
  return items.some((it) => it.kind === "question" && isOpenTool(it.agent_status));
}

/**
 * Attention level for sorting/roll-up and notification edges (higher = louder):
 * 3 blocked, 2 done-unseen, 1 working, 0 idle. `unseen` only elevates a
 * non-blocked entry (blocked already wins), so callers pass the display status
 * plus its unseen flag.
 */
export function attentionOf(status: SessionStatus, unseen: boolean): 0 | 1 | 2 | 3 {
  if (status === "blocked") return 3;
  if (unseen) return 2;
  if (status === "working") return 1;
  return 0;
}

/** Toolbar roll-up: how many sessions currently need attention, by kind. */
export function rollup(
  entries: readonly { status: SessionStatus; unseen: boolean }[],
): { blocked: number; doneUnseen: number } {
  let blocked = 0;
  let doneUnseen = 0;
  for (const e of entries) {
    const a = attentionOf(e.status, e.unseen);
    if (a === 3) blocked++;
    else if (a === 2) doneUnseen++;
  }
  return { blocked, doneUnseen };
}

/** One session's tracked state. `status`/`unseen` are the display fields; the
 * rest are internal bookkeeping the actions maintain. */
export interface SessionEntry {
  /** Display status — blocked overrides activity. */
  status: SessionStatus;
  /** done-unseen: quiet-confirmed work not seen since. Meaningful only when
   * status !== "blocked" (blocked wins in attentionOf). */
  unseen: boolean;
  // ---- internal ----
  /** Hold-confirmed activity (stays "working" during the working→quiet hold). */
  activity: SessionActivity;
  /** Open AskUserQuestion in the timeline. */
  questionBlocked: boolean;
  /** P2 screen-scan blocked chrome (set via setScreenBlocked). */
  screenBlocked: boolean;
  /** Last known "user is looking at this panel" (active + window focused). */
  seen: boolean;
}

/** Payload the panel feeds updateFromTimeline on each `claude-timeline` tick. */
export interface DerivedTimeline {
  activity: SessionActivity;
  /** hasOpenQuestion(items). */
  questionBlocked: boolean;
  /** Panel active AND window focused right now. */
  seenNow: boolean;
}

function emptyEntry(): SessionEntry {
  return {
    status: "idle",
    unseen: false,
    activity: "quiet",
    questionBlocked: false,
    screenBlocked: false,
    seen: false,
  };
}

/** Recompute the display status from the internal fields. Blocked (question or
 * screen) wins; otherwise mirror the (hold-confirmed) activity. */
function statusOf(e: SessionEntry): SessionStatus {
  if (e.questionBlocked || e.screenBlocked) return "blocked";
  return e.activity === "working" ? "working" : "idle";
}

/** working→quiet is confirmed only after this quiet hold, so a micro-pause
 * between tool calls doesn't flash a false "done". A working event during the
 * hold cancels it. */
export const HOLD_MS = 1000;

/** uuid → pending hold timer. Module scope (per-window), one per uuid; re-armed
 * on re-entry, cleared on working / remove. Uses setTimeout so vi.useFakeTimers
 * drives it in tests. */
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface StatusStore {
  entries: Record<string, SessionEntry>;
  /** Record a timeline tick for `uuid`, applying the working→quiet hold and the
   * unseen rule at hold-confirm. Blocked (question) is applied immediately. */
  updateFromTimeline: (uuid: string, d: DerivedTimeline) => void;
  /** P2 hook — set the screen-scan blocked signal (OR'd with question). */
  setScreenBlocked: (uuid: string, blocked: boolean) => void;
  /** The user looked: clear unseen and remember seen. */
  markSeen: (uuid: string) => void;
  /** Panel unmounted / session ended — drop the entry and any hold timer. */
  remove: (uuid: string) => void;
}

export const useClaudeStatus = create<StatusStore>((set) => {
  const clearHold = (uuid: string) => {
    const t = holdTimers.get(uuid);
    if (t !== undefined) {
      clearTimeout(t);
      holdTimers.delete(uuid);
    }
  };

  const scheduleHold = (uuid: string) => {
    clearHold(uuid);
    const t = setTimeout(() => {
      holdTimers.delete(uuid);
      set((s) => {
        const prev = s.entries[uuid];
        if (!prev) return {};
        // Confirm quiet. done-unseen iff the panel wasn't seen at completion
        // (seen was last set from the completion tick's seenNow, or by markSeen
        // if the user looked during the hold).
        const e: SessionEntry = { ...prev, activity: "quiet", unseen: !prev.seen };
        e.status = statusOf(e);
        return { entries: { ...s.entries, [uuid]: e } };
      });
    }, HOLD_MS);
    holdTimers.set(uuid, t);
  };

  return {
    entries: {},

    updateFromTimeline: (uuid, d) => {
      set((s) => {
        const prev = s.entries[uuid] ?? emptyEntry();
        const e: SessionEntry = { ...prev, questionBlocked: d.questionBlocked, seen: d.seenNow };
        if (d.activity === "working") {
          // Real work (again) — cancel any pending hold, drop stale done-unseen.
          clearHold(uuid);
          e.activity = "working";
          e.unseen = false;
        } else if (prev.activity === "working") {
          // working→quiet: don't confirm yet. Keep showing "working" through the
          // hold; if the hold is already running, let it keep ticking.
          if (!holdTimers.has(uuid)) scheduleHold(uuid);
          e.activity = "working";
        } else {
          // Already quiet (or never worked) — nothing to hold.
          e.activity = "quiet";
        }
        e.status = statusOf(e);
        return { entries: { ...s.entries, [uuid]: e } };
      });
    },

    setScreenBlocked: (uuid, blocked) => {
      set((s) => {
        const prev = s.entries[uuid] ?? emptyEntry();
        if (prev.screenBlocked === blocked && uuid in s.entries) return {};
        const e: SessionEntry = { ...prev, screenBlocked: blocked };
        e.status = statusOf(e);
        return { entries: { ...s.entries, [uuid]: e } };
      });
    },

    markSeen: (uuid) => {
      set((s) => {
        const prev = s.entries[uuid];
        if (!prev) return {};
        const e: SessionEntry = { ...prev, seen: true, unseen: false };
        e.status = statusOf(e);
        return { entries: { ...s.entries, [uuid]: e } };
      });
    },

    remove: (uuid) => {
      clearHold(uuid);
      set((s) => {
        if (!(uuid in s.entries)) return {};
        const rest = { ...s.entries };
        delete rest[uuid];
        return { entries: rest };
      });
    },
  };
});
