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
 *
 * Origin (S4a): each trigger records its origin *at trigger time* — reading a
 * shared variable at execution time would let live output arriving within the
 * debounce window promote a pure restore-replay scan to "live" (re-alerting a
 * restored prompt). A coalesced batch resolves to `snapshot` only when EVERY
 * trigger in it was snapshot; any live trigger makes the batch live (live output
 * is new information — that scan's verdict genuinely is live). Batch resets
 * after each run.
 */
export function makeDebouncedScanner(
  run: (origin: TimelineOrigin) => void,
  delay: number,
): { trigger: (origin?: TimelineOrigin) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let batchOrigin: TimelineOrigin | null = null; // null = no batch pending
  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    batchOrigin = null;
  };
  const trigger = (origin: TimelineOrigin = "live") => {
    // Batch rule: all-snapshot → snapshot; any live → live.
    batchOrigin = batchOrigin === null ? origin : origin === "live" ? "live" : batchOrigin;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const o = batchOrigin ?? "live";
      batchOrigin = null;
      run(o);
    }, delay);
  };
  return { trigger, cancel };
}

/**
 * Empty-screen scan gate (S1). A blank live screen right after a panel mounts is
 * just "restore hasn't painted yet" — clearing screen-blocked on it would false-
 * negative a session reopened while sitting at a prompt. `admit(nonEmpty)` says
 * whether the scan result may be applied: admitted when the screen is non-empty
 * (latching — a later blank is a REAL clear-screen and may clear the signal) OR
 * once the gate is `arm()`ed. Arm when the post-restore scheduled scan is issued:
 * from then on the restore is over, so even a genuinely-empty screen is a valid
 * verdict (otherwise a blocked badge would stick on a session whose restored
 * screen really is blank). One gate per panel mount.
 */
export function makeScanGate(): { admit: (nonEmpty: boolean) => boolean; arm: () => void } {
  let sawNonEmpty = false;
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    admit(nonEmpty: boolean): boolean {
      if (nonEmpty) {
        sawNonEmpty = true;
        return true;
      }
      return sawNonEmpty || armed;
    },
  };
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
  /** hook-status: 이 세션이 hook 이벤트를 한 번이라도 보냈다 — 그때부터
   * 화면 스캔(screenBlocked)은 표시 판정에서 무시된다(hook 우선/스캔 폴백). */
  hookBacked: boolean;
  /** hook Notification(입력 대기) 이후 UserPromptSubmit/Stop 전 — blocked. */
  hookBlocked: boolean;
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
    hookBacked: false,
    hookBlocked: false,
  };
}

// --- hook-status: 이벤트 이름 → 상태 전이 종류 (순수 — vitest 대상) ---------

export type HookEventKind = "stop" | "notification" | "prompt-submit";

/** `claude-hook-status` payload의 이벤트 이름(수신기 화이트리스트와 1:1)을
 * 전이 종류로 매핑. 모르는 이름 = null(무시 — 전이 없음). */
export function mapHookEvent(name: string): HookEventKind | null {
  switch (name) {
    case "Stop":
      return "stop";
    case "Notification":
      return "notification";
    case "UserPromptSubmit":
      return "prompt-submit";
    default:
      return null;
  }
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
  // Isolate each listener: one throwing subscriber must not starve the ones
  // after it, nor propagate up into the store action — and through it into the
  // action's caller (e.g. the S9 transfer-ack handler calling remove) (S11).
  for (const cb of attentionListeners) {
    try {
      cb(ev);
    } catch (err) {
      console.error("[claudeStatus] attention listener failed", err);
    }
  }
}

/** Recompute the display status from the internal fields. Blocked wins; a
 * hook-backed session ignores the screen-scan heuristic (hook이 정본 — 스캔은
 * hook 미수신 세션의 폴백일 뿐이다, hook-status spec §2). */
function statusOf(e: SessionEntry): SessionStatus {
  if (e.questionBlocked || e.hookBlocked || (e.screenBlocked && !e.hookBacked)) return "blocked";
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
/** uuid → the origin of the update that SCHEDULED the pending hold. The confirm
 * commit fires with this origin, so a snapshot-seeded working→quiet epoch
 * confirms as `snapshot` (silent restore) instead of leaking a `live` done
 * alert (S4b). Cleared together with the timer. */
const holdOrigins = new Map<string, TimelineOrigin>();

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

/** 이 창이 이 세션을 등록했는가 (hook-status: 전 창 브로드캐스트를 자기
 * 세션으로 거르는 필터 — registerSession이 만든 매핑 존재 여부). */
export function hasSessionMapping(uuid: string): boolean {
  return uuidToNumeric.has(uuid);
}

/** uuid → 숫자 PTY id (없으면 undefined). uuid만 아는 소비자(타임라인 peek)가
 * 숫자 id로만 오는 `claude-session-closed`를 자기 세션과 맞추는 데 쓴다. */
export function lookupSessionId(uuid: string): number | undefined {
  return uuidToNumeric.get(uuid);
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
  /** P2 hook — set the screen-scan blocked signal (OR'd with question).
   * `origin` marks a restore-replay scan as `snapshot` (silent notifier seed —
   * S4a); defaults to `live`. */
  setScreenBlocked: (uuid: string, blocked: boolean, origin?: TimelineOrigin) => void;
  /** hook-status: 수신기가 중계한 hook 이벤트를 적용한다 (항상 live —
   * hook은 실이벤트에만 발화하므로 restore 재생이 없다). */
  applyHookEvent: (uuid: string, kind: HookEventKind) => void;
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
    holdOrigins.delete(uuid);
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

  const scheduleHold = (uuid: string, origin: TimelineOrigin) => {
    clearHold(uuid);
    holdOrigins.set(uuid, origin);
    const t = setTimeout(() => {
      holdTimers.delete(uuid);
      // Confirm with the origin of the update that scheduled this epoch — a
      // snapshot-seeded quiet confirms silently instead of firing done (S4b).
      const confirmOrigin = holdOrigins.get(uuid) ?? "live";
      holdOrigins.delete(uuid);
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
      commit(uuid, e, prev, confirmOrigin);
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
      // hook Notification은 "그 순간" 신호다 — 권한 승인 후에는 UserPromptSubmit
      // 없이 작업이 재개되므로, live 타임라인이 실작업을 보고하면 hookBlocked를
      // 해제한다(H5c: 승인 후 blocked 고착 방지).
      if (prev.hookBlocked && d.activity === "working" && (d.origin ?? "live") === "live") {
        e.hookBlocked = false;
      }
      if (d.activity === "working") {
        // Real work (again) — cancel any pending hold, drop stale done-unseen,
        // and reset the seen latch so this fresh epoch starts clean (S7).
        clearHold(uuid);
        e.activity = "working";
        e.unseen = false;
        e.seenDuringHold = false;
      } else if (prev.activity === "working") {
        // working→quiet: don't confirm yet. Keep showing "working" through the
        // hold; if the hold is already running, let it keep ticking (its confirm
        // origin stays that of the tick that scheduled it — S4b).
        if (!holdTimers.has(uuid)) scheduleHold(uuid, d.origin ?? "live");
        e.activity = "working";
      } else {
        // Already quiet (or never worked) — nothing to hold.
        e.activity = "quiet";
      }
      e.status = statusOf(e);
      commit(uuid, e, prevEntry, d.origin ?? "live");
    },

    setScreenBlocked: (uuid, blocked, origin) => {
      const prevEntry = get().entries[uuid];
      // Don't materialize a ghost idle entry for a never-seen uuid when clearing
      // (blocked:false) — only a real blocked signal creates an entry (minor).
      if (!prevEntry && !blocked) return;
      const prev = prevEntry ?? emptyEntry();
      if (prev.screenBlocked === blocked && prevEntry) return;
      const e: SessionEntry = { ...prev, screenBlocked: blocked };
      e.status = statusOf(e);
      commit(uuid, e, prevEntry, origin ?? "live");
    },

    applyHookEvent: (uuid, kind) => {
      const prevEntry = get().entries[uuid];
      // 리듀서 자체 가드(H6): 이 창이 모르는(또는 이미 remove된) 세션의 늦은
      // hook은 유령 엔트리를 되살리지 않는다 — 리스너 필터에만 기대지 않음.
      if (!prevEntry && !hasSessionMapping(uuid)) return;
      const prev = prevEntry ?? emptyEntry();
      const e: SessionEntry = { ...prev, hookBacked: true };
      if (kind === "notification") {
        // 입력 대기 — 즉시 blocked (질문/권한 프롬프트).
        e.hookBlocked = true;
      } else if (kind === "prompt-submit") {
        // 작업 재개 — working 틱과 동일한 epoch 정리(S7 규칙 재사용).
        // 프롬프트가 제출됐다는 것은 열려 있던 질문이 방금 답변됐다는 뜻 —
        // 타임라인 지연으로 남은 stale questionBlocked도 함께 해제한다(감사
        // H5a 이의 반영; 실제로 열려 있으면 다음 타임라인 틱이 되살린다).
        clearHold(uuid);
        e.hookBlocked = false;
        e.questionBlocked = false;
        e.activity = "working";
        e.unseen = false;
        e.seenDuringHold = false;
      } else {
        // stop: 턴이 방금 끝났다는 정본 신호 — blocked 해제 + 완료 전이를
        // **항상** 보장한다(H5b: 타임라인 지연으로 working이 안 잡혔어도
        // done 판정이 소실되면 안 됨). 확정은 기존 HOLD·unseen 규칙 경유
        // (즉시 quiet로 꺾으면 micro-pause 오탐 재발).
        e.hookBlocked = false;
        if (!holdTimers.has(uuid)) {
          e.activity = "working"; // hold 확정 경로 진입용 일시 상태
          scheduleHold(uuid, "live");
        } else {
          // 이미 도는 hold가 snapshot origin이면 live로 승격 — Stop은 진짜
          // 완료 신호라 done 알림이 침묵되면 안 된다(감사 H5b 부분).
          holdOrigins.set(uuid, "live");
        }
      }
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
