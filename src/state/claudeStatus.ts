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

/** Where a status update came from. A `snapshot` seeds a restored/re-attached
 * state (restart, reopen) — the notifier treats a uuid's first `snapshot`
 * observation as a silent baseline (invariant ⑥: restore must not re-alert). A
 * `live` update (a real timeline event or a screen scan) is a genuine edge and
 * alerts normally. Defaults to `live` when unspecified. */
export type TimelineOrigin = "snapshot" | "live";

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

// --- P2: bottom-of-screen scan for a permission/menu prompt (blocked) --------

/** Max non-empty lines from the bottom of the screen we consider. Blank lines
 * don't count toward this cap. A live prompt renders in the last few rows, so a
 * tight window keeps stale scrollback (already answered prompts scrolled up out
 * of the live screen) from producing a false blocked (invariant ②). */
export const PROMPT_SCAN_MAX_LINES = 20;

/** The highlighted menu choice cursor + a number: `❯ 1. Yes`. U+276F (❯) is the
 * selection cursor Claude Code renders on the *active* option of a live picker —
 * it is chrome, not something assistant prose emits, so it is the load-bearing
 * discriminator against a coincidental numbered list. */
const SELECT_CURSOR = /❯\s*\d+\.\s/;
/** A numbered menu option line: `1. Yes`, `  2. No, and tell Claude…`. */
const NUMBERED_OPTION = /(?:^|\s)\d+\.\s+\S/;
/** The permission-dialog header. Claude phrases every tool-permission prompt as
 * "Do you want to make this edit?" / "…proceed?" / "…create …?". */
const PERMISSION_Q = /do you want to/i;
/** An affirmative numbered option, e.g. `1. Yes` / `❯ 1. Yes, and don't ask…`. */
const YES_OPTION = /\d+\.\s+Yes\b/;

interface PromptRule {
  /** Which live screen this catches — recorded for review, not used at runtime. */
  screen: string;
  /** True only when *every* required signal is present in the scanned lines. */
  test: (lines: readonly string[]) => boolean;
}

/**
 * Conservative rules: each ANDs ≥2 signals so a single stray string can't flip
 * blocked (oversensitivity is worse than a miss — invariant ②). Rules are OR'd.
 * Deliberately NOT keyed on "esc to interrupt": that footer is the *working*
 * spinner, so matching it would false-positive on every streaming response.
 * (ANSI escapes are already stripped — callers pass `translateToString(true)`.)
 */
const PROMPT_RULES: readonly PromptRule[] = [
  {
    // Tool-permission dialog: "Do you want to make this edit?" + a "1. Yes"
    // option. Text-based (no ❯), so it still fires if the cursor glyph is
    // normalized away. A scrollback quote of the question alone lacks the
    // numbered Yes option, so both together are needed.
    screen: "permission-prompt (edit / bash / create / proceed)",
    test: (ls) => ls.some((l) => PERMISSION_Q.test(l)) && ls.some((l) => YES_OPTION.test(l)),
  },
  {
    // Any live numbered picker (AskUserQuestion, trust-folder, theme select):
    // the ❯ selection cursor on a numbered choice AND ≥2 numbered options — a
    // real menu, not a lone "❯ 1." coincidence in prose.
    screen: "numbered select menu (AskUserQuestion / trust / theme)",
    test: (ls) =>
      ls.some((l) => SELECT_CURSOR.test(l)) &&
      ls.filter((l) => NUMBERED_OPTION.test(l)).length >= 2,
  },
];

/**
 * Does the bottom of the screen show an input-waiting prompt (permission dialog
 * or numbered menu)? `lines` are collected bottom-first by the caller from the
 * live screen rows; we keep only the first `PROMPT_SCAN_MAX_LINES` non-empty
 * ones (blanks skipped, not counted) and OR the conservative rules over them.
 */
export function scanBottomForPrompt(lines: readonly string[]): boolean {
  const nonEmpty: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") continue; // blank rows don't consume the window
    nonEmpty.push(l);
    if (nonEmpty.length >= PROMPT_SCAN_MAX_LINES) break;
  }
  return PROMPT_RULES.some((r) => r.test(nonEmpty));
}

/**
 * Trailing debounce: `trigger()` (re)arms a timer; `run` fires once `delay` ms
 * after the *last* trigger, so a burst of PTY writes yields a single scan of the
 * final screen (intermediate frames ignored — invariant ②/F4). `cancel()` clears
 * a pending fire (call on unmount). Extracted from the component so the debounce
 * is unit-testable with fake timers.
 */
export function makeDebouncedScanner(
  run: () => void,
  delay: number,
): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const trigger = () => {
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, delay);
  };
  return { trigger, cancel };
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

/** Does the roll-up need rendering at all? Both zero → nothing to show (R3). */
export function shouldShowRollup(r: { blocked: number; doneUnseen: number }): boolean {
  return r.blocked > 0 || r.doneUnseen > 0;
}

/** The uuids currently needing attention, split by kind and kept in the entries'
 * insertion order — the roll-up cycles through these lists. Idle/working never
 * appear (they aren't attention states). */
export function attentionUuids(
  entries: Record<string, { status: SessionStatus; unseen: boolean }>,
): { blocked: string[]; doneUnseen: string[] } {
  const blocked: string[] = [];
  const doneUnseen: string[] = [];
  for (const [uuid, e] of Object.entries(entries)) {
    const a = attentionOf(e.status, e.unseen);
    if (a === 3) blocked.push(uuid);
    else if (a === 2) doneUnseen.push(uuid);
  }
  return { blocked, doneUnseen };
}

/** Next uuid to focus when the roll-up is clicked: the one after `current` in
 * `uuids`, wrapping at the end. `current` absent (or not in the list — e.g. it
 * left this attention set) restarts at the first. Empty list → null (no-op).
 * Pure so the cycle order is unit-testable independent of dockview. */
export function nextCycleTarget(
  uuids: readonly string[],
  current: string | null | undefined,
): string | null {
  if (uuids.length === 0) return null;
  const i = current == null ? -1 : uuids.indexOf(current);
  return uuids[(i + 1) % uuids.length];
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
  /** Latched true if the user looked (markSeen) at any point during the current
   * working→quiet hold epoch. Once latched, a later quiet tick reporting
   * `seenNow:false` can't un-see the completion — the hold confirms as *seen*
   * (unseen:false). Reset when real work resumes (S7). */
  seenDuringHold: boolean;
}

/** Payload the panel feeds updateFromTimeline on each `claude-timeline` tick. */
export interface DerivedTimeline {
  activity: SessionActivity;
  /** hasOpenQuestion(items). */
  questionBlocked: boolean;
  /** Panel active AND window focused right now. */
  seenNow: boolean;
  /** Snapshot seed (restore) vs a live edge — see {@link TimelineOrigin}.
   * Defaults to `live`. */
  origin?: TimelineOrigin;
}

function emptyEntry(): SessionEntry {
  return {
    status: "idle",
    unseen: false,
    activity: "quiet",
    questionBlocked: false,
    screenBlocked: false,
    seen: false,
    seenDuringHold: false,
  };
}

// --- attention event bus (S11: incremental notification) ---------------------

/** The two independent attention signals the notifier edges on (S10). Kept as a
 * flat pair (not the scalar `attentionOf`) so blocked and done-unseen are
 * separate rising edges the combination rules can reason about individually. */
export interface AttentionSignals {
  /** Display status is currently "blocked". */
  blockedActive: boolean;
  /** done-unseen flag (meaningful only when not blocked). */
  unseen: boolean;
}

/** One session's attention change. `prev === null` = the entry was just created;
 * `next === null` = it was removed. `origin` is the triggering update's origin
 * (a snapshot seed suppresses the first-observation alert — S4). */
export interface AttentionEvent {
  uuid: string;
  prev: AttentionSignals | null;
  next: AttentionSignals | null;
  origin: TimelineOrigin;
}

function attentionSignals(e: SessionEntry): AttentionSignals {
  return { blockedActive: e.status === "blocked", unseen: e.unseen };
}

const attentionListeners = new Set<(ev: AttentionEvent) => void>();

/** Subscribe to per-session attention changes (the notifier's feed — S11). The
 * store actions push only the changed uuid's prev/next signals here, so the
 * notifier never re-scans all entries. Returns an unsubscribe. */
export function onAttentionEvent(cb: (ev: AttentionEvent) => void): () => void {
  attentionListeners.add(cb);
  return () => attentionListeners.delete(cb);
}

function emitAttention(ev: AttentionEvent): void {
  for (const cb of attentionListeners) cb(ev);
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

/** numeric PTY/session id → stable uuid. The `claude-timeline` payload carries
 * only the numeric id, so the app-level global listener (claudeStatusGlobal)
 * reverse-maps it here to a uuid before updating the store. Registered by a
 * panel when its session opens; survives a panel unmount (tab switch) so a
 * backgrounded session's events still resolve — cleared only on real removal. */
const numericToUuid = new Map<number, string>();
/** Reverse of `numericToUuid`, so `remove(uuid)` can drop both directions. */
const uuidToNumeric = new Map<string, number>();

/** Resolve a numeric session id to its uuid (global listener reverse lookup). */
export function lookupSessionUuid(numericId: number): string | undefined {
  return numericToUuid.get(numericId);
}

interface StatusStore {
  entries: Record<string, SessionEntry>;
  /** uuid → number of mounted panels currently showing it (per window). While
   * >0 a live panel owns this session's timeline/seen updates (it has the
   * accurate `seenNow`), so the global listener skips it — no double update. */
  attached: Record<string, number>;
  /** The one session (in this window) the user is actively looking at right now:
   * its panel is the active tab AND the window is focused. Set/cleared at the
   * markSeen points in ClaudeTermPanel. The notifier reads it to suppress an
   * alert for a session the user is already watching (invariant ③, N4). A live
   * "watching" signal distinct from `SessionEntry.seen` (which is a snapshot from
   * the last timeline tick and isn't cleared on blur). */
  watchedUuid: string | null;
  /** The Claude panel that is the **active dock tab** in this window right now —
   * regardless of window focus (distinct from `watchedUuid`, which additionally
   * requires focus and drives alert suppression). This is the roll-up's cycle
   * cursor: clicking a group steps to the session *after* the active one, so the
   * cycle advances relative to what you're actually on. `null` when no Claude
   * panel is the active tab. Maintained by ClaudeTermPanel's activate/deactivate. */
  activeClaudeUuid: string | null;
  /** Set the actively-watched session (null when the user looks away/blurs). */
  setWatched: (uuid: string | null) => void;
  /** Set the dock-active Claude panel's uuid (S12 — roll-up cycle cursor). */
  setActiveClaudeUuid: (uuid: string | null) => void;
  /** Record a timeline tick for `uuid`, applying the working→quiet hold and the
   * unseen rule at hold-confirm. Blocked (question) is applied immediately. */
  updateFromTimeline: (uuid: string, d: DerivedTimeline) => void;
  /** P2 hook — set the screen-scan blocked signal (OR'd with question). */
  setScreenBlocked: (uuid: string, blocked: boolean) => void;
  /** The user looked: clear unseen and remember seen. */
  markSeen: (uuid: string) => void;
  /** Panel unmounted / session ended — drop the entry and any hold timer. */
  remove: (uuid: string) => void;
  /** Map a session's numeric id ↔ uuid so the global listener can resolve its
   * `claude-timeline` events. Idempotent; the mapping outlives a panel unmount. */
  registerSession: (uuid: string, numericId: number) => void;
  /** A panel mounted for `uuid` — it now owns timeline/seen updates (global skips). */
  attachPanel: (uuid: string) => void;
  /** A panel for `uuid` unmounted (tab switch). Only decrements the attach count;
   * the entry + numeric mapping stay so the global listener takes over. */
  detachPanel: (uuid: string) => void;
}

export const useClaudeStatus = create<StatusStore>((set, get) => {
  const clearHold = (uuid: string) => {
    const t = holdTimers.get(uuid);
    if (t !== undefined) {
      clearTimeout(t);
      holdTimers.delete(uuid);
    }
  };

  /** Commit a new entry for `uuid` and push its attention delta to the notifier
   * bus (S11). `prevEntry` is the pre-update entry (undefined = newly created). */
  const commit = (
    uuid: string,
    e: SessionEntry,
    prevEntry: SessionEntry | undefined,
    origin: TimelineOrigin,
  ) => {
    set((s) => ({ entries: { ...s.entries, [uuid]: e } }));
    emitAttention({
      uuid,
      prev: prevEntry ? attentionSignals(prevEntry) : null,
      next: attentionSignals(e),
      origin,
    });
  };

  const scheduleHold = (uuid: string) => {
    clearHold(uuid);
    const t = setTimeout(() => {
      holdTimers.delete(uuid);
      const prev = get().entries[uuid];
      if (!prev) return;
      // Confirm quiet. done-unseen iff the panel wasn't seen at completion —
      // where "seen" latches: either the last completion tick's seenNow, OR a
      // markSeen at any point during this hold epoch (seenDuringHold, S7). A
      // quiet tick reporting seenNow:false after the user already looked must
      // NOT resurrect unseen, so the latch wins. Epoch ends here.
      const e: SessionEntry = {
        ...prev,
        activity: "quiet",
        unseen: !(prev.seen || prev.seenDuringHold),
        seenDuringHold: false,
      };
      e.status = statusOf(e);
      commit(uuid, e, prev, "live");
    }, HOLD_MS);
    holdTimers.set(uuid, t);
  };

  return {
    entries: {},
    attached: {},
    watchedUuid: null,
    activeClaudeUuid: null,

    setWatched: (uuid) => {
      set((s) => (s.watchedUuid === uuid ? {} : { watchedUuid: uuid }));
    },

    setActiveClaudeUuid: (uuid) => {
      set((s) => (s.activeClaudeUuid === uuid ? {} : { activeClaudeUuid: uuid }));
    },

    updateFromTimeline: (uuid, d) => {
      const prevEntry = get().entries[uuid];
      const prev = prevEntry ?? emptyEntry();
      const e: SessionEntry = { ...prev, questionBlocked: d.questionBlocked, seen: d.seenNow };
      if (d.activity === "working") {
        // Real work (again) — cancel any pending hold, drop stale done-unseen,
        // and reset the seen latch so this fresh epoch starts clean (S7).
        clearHold(uuid);
        e.activity = "working";
        e.unseen = false;
        e.seenDuringHold = false;
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
      commit(uuid, e, prevEntry, d.origin ?? "live");
    },

    setScreenBlocked: (uuid, blocked) => {
      const prevEntry = get().entries[uuid];
      // Don't materialize a ghost idle entry for a never-seen uuid when clearing
      // (blocked:false) — only a real blocked signal creates an entry (minor).
      if (!prevEntry && !blocked) return;
      const prev = prevEntry ?? emptyEntry();
      if (prev.screenBlocked === blocked && prevEntry) return;
      const e: SessionEntry = { ...prev, screenBlocked: blocked };
      e.status = statusOf(e);
      commit(uuid, e, prevEntry, "live");
    },

    markSeen: (uuid) => {
      const prevEntry = get().entries[uuid];
      if (!prevEntry) return;
      // Latch seenDuringHold so a later seenNow:false quiet tick can't un-see
      // this completion (S7); clear unseen and remember seen.
      const e: SessionEntry = { ...prevEntry, seen: true, unseen: false, seenDuringHold: true };
      e.status = statusOf(e);
      commit(uuid, e, prevEntry, "live");
    },

    remove: (uuid) => {
      clearHold(uuid);
      const numericId = uuidToNumeric.get(uuid);
      // Only drop the reverse (numeric→uuid) mapping if it still points at THIS
      // uuid — a stale close for a reused numeric id must not unmap the session
      // that now owns it (S6).
      if (numericId !== undefined) {
        if (numericToUuid.get(numericId) === uuid) numericToUuid.delete(numericId);
        uuidToNumeric.delete(uuid);
      }
      const prevEntry = get().entries[uuid];
      set((s) => {
        const clearWatched = s.watchedUuid === uuid ? { watchedUuid: null } : {};
        const clearActive = s.activeClaudeUuid === uuid ? { activeClaudeUuid: null } : {};
        if (!(uuid in s.entries) && !(uuid in s.attached)) {
          return { ...clearWatched, ...clearActive };
        }
        const rest = { ...s.entries };
        delete rest[uuid];
        const att = { ...s.attached };
        delete att[uuid];
        return { entries: rest, attached: att, ...clearWatched, ...clearActive };
      });
      if (prevEntry) emitAttention({ uuid, prev: attentionSignals(prevEntry), next: null, origin: "live" });
    },

    registerSession: (uuid, numericId) => {
      // Evict stale mappings on either side before (re)binding, so a reused
      // numeric id or a uuid re-registered under a new id can't leave a dangling
      // reverse entry that resolves the wrong session (S6).
      const staleUuid = numericToUuid.get(numericId);
      if (staleUuid !== undefined && staleUuid !== uuid) uuidToNumeric.delete(staleUuid);
      const staleNumeric = uuidToNumeric.get(uuid);
      if (staleNumeric !== undefined && staleNumeric !== numericId) numericToUuid.delete(staleNumeric);
      numericToUuid.set(numericId, uuid);
      uuidToNumeric.set(uuid, numericId);
    },

    attachPanel: (uuid) => {
      set((s) => ({ attached: { ...s.attached, [uuid]: (s.attached[uuid] ?? 0) + 1 } }));
    },

    detachPanel: (uuid) => {
      set((s) => {
        const n = (s.attached[uuid] ?? 0) - 1;
        const att = { ...s.attached };
        if (n > 0) att[uuid] = n;
        else delete att[uuid];
        return { attached: att };
      });
    },
  };
});
