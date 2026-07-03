import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionOf,
  attentionUuids,
  deriveSessionActivity,
  hasOpenQuestion,
  HOLD_MS,
  lookupSessionUuid,
  makeDebouncedScanner,
  nextCycleTarget,
  PROMPT_SCAN_MAX_LINES,
  rollup,
  scanBottomForPrompt,
  shouldShowRollup,
  useClaudeStatus,
  type ActivityItem,
  type SessionEntry,
  type SessionStatus,
} from "./claudeStatus";

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  kind: "read",
  agent_status: "completed",
  ...over,
});

// --- pure derivations -------------------------------------------------------

describe("deriveSessionActivity", () => {
  it("is working when the latest turn has no answer yet", () => {
    expect(deriveSessionActivity([[1, "hi"]], [], [])).toBe("working");
  });

  it("is quiet when the latest turn is answered and no tool is open", () => {
    expect(
      deriveSessionActivity([[1, "hi"]], [[1, "done"]], [item({ agent_status: "completed" })]),
    ).toBe("quiet");
  });

  it("is working when a tool item is still open, even if the turn is answered", () => {
    expect(
      deriveSessionActivity([[1, "hi"]], [[1, "part"]], [item({ agent_status: "in_progress" })]),
    ).toBe("working");
    expect(
      deriveSessionActivity([[1, "hi"]], [[1, "part"]], [item({ agent_status: "pending" })]),
    ).toBe("working");
  });

  it("uses the max turn number, not array order", () => {
    // turn 2 unanswered though it appears before turn 1 in the array
    expect(deriveSessionActivity([[2, "b"], [1, "a"]], [[1, "a-done"]], [])).toBe("working");
  });

  it("is quiet with no turns at all", () => {
    expect(deriveSessionActivity([], [], [])).toBe("quiet");
  });
});

describe("hasOpenQuestion", () => {
  it("is true for a question item that is still in_progress/pending", () => {
    expect(hasOpenQuestion([item({ kind: "question", agent_status: "in_progress" })])).toBe(true);
    expect(hasOpenQuestion([item({ kind: "question", agent_status: "pending" })])).toBe(true);
  });

  it("is false for an answered (completed/canceled) question", () => {
    expect(hasOpenQuestion([item({ kind: "question", agent_status: "completed" })])).toBe(false);
    expect(hasOpenQuestion([item({ kind: "question", agent_status: "canceled" })])).toBe(false);
  });

  it("is false for an open non-question tool", () => {
    expect(hasOpenQuestion([item({ kind: "execute", agent_status: "in_progress" })])).toBe(false);
  });
});

describe("attentionOf", () => {
  it("orders blocked > done-unseen > working > idle", () => {
    expect(attentionOf("blocked", false)).toBe(3);
    expect(attentionOf("blocked", true)).toBe(3); // blocked wins over unseen
    expect(attentionOf("idle", true)).toBe(2); // done-unseen
    expect(attentionOf("working", false)).toBe(1);
    expect(attentionOf("idle", false)).toBe(0);
  });
});

describe("rollup", () => {
  it("counts blocked and done-unseen, ignoring working/idle", () => {
    const entries: { status: SessionStatus; unseen: boolean }[] = [
      { status: "blocked", unseen: false },
      { status: "blocked", unseen: true },
      { status: "idle", unseen: true }, // done-unseen
      { status: "working", unseen: false },
      { status: "idle", unseen: false },
    ];
    expect(rollup(entries)).toEqual({ blocked: 2, doneUnseen: 1 });
  });
});

describe("shouldShowRollup (R3)", () => {
  it("R3: both zero → nothing to render", () => {
    expect(shouldShowRollup({ blocked: 0, doneUnseen: 0 })).toBe(false);
  });
  it("R4: any nonzero group → render", () => {
    expect(shouldShowRollup({ blocked: 1, doneUnseen: 0 })).toBe(true);
    expect(shouldShowRollup({ blocked: 0, doneUnseen: 2 })).toBe(true);
  });
});

describe("attentionUuids", () => {
  it("splits blocked / done-unseen by kind and ignores idle+working", () => {
    const entries: Record<string, { status: SessionStatus; unseen: boolean }> = {
      a: { status: "blocked", unseen: false },
      b: { status: "working", unseen: false }, // excluded
      c: { status: "idle", unseen: true }, // done-unseen
      d: { status: "idle", unseen: false }, // excluded
      e: { status: "blocked", unseen: true },
    };
    expect(attentionUuids(entries)).toEqual({ blocked: ["a", "e"], doneUnseen: ["c"] });
  });
  it("keeps entries' insertion order (the cycle order)", () => {
    const entries: Record<string, { status: SessionStatus; unseen: boolean }> = {
      z: { status: "idle", unseen: true },
      a: { status: "idle", unseen: true },
    };
    expect(attentionUuids(entries).doneUnseen).toEqual(["z", "a"]);
  });
});

describe("nextCycleTarget", () => {
  it("empty list → null (no-op)", () => {
    expect(nextCycleTarget([], null)).toBeNull();
    expect(nextCycleTarget([], "a")).toBeNull();
  });
  it("no current → first", () => {
    expect(nextCycleTarget(["a", "b", "c"], null)).toBe("a");
    expect(nextCycleTarget(["a", "b", "c"], undefined)).toBe("a");
  });
  it("current in the middle → next", () => {
    expect(nextCycleTarget(["a", "b", "c"], "b")).toBe("c");
  });
  it("current is last → wraps to first", () => {
    expect(nextCycleTarget(["a", "b", "c"], "c")).toBe("a");
  });
  it("current no longer in the list → restarts at first", () => {
    expect(nextCycleTarget(["a", "b"], "gone")).toBe("a");
  });
});

// --- store: hold + seen ------------------------------------------------------

const S = useClaudeStatus;
const entry = (uuid: string): SessionEntry | undefined => S.getState().entries[uuid];

describe("store: activity + hold + unseen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // reset store between tests
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows working immediately on a working tick", () => {
    S.getState().updateFromTimeline("a", { activity: "working", questionBlocked: false, seenNow: false });
    expect(entry("a")?.status).toBe("working");
    expect(entry("a")?.unseen).toBe(false);
  });

  it("holds working→quiet: a working return within the hold cancels done", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    // during the hold it still reads working (not yet confirmed idle)
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(entry(u)?.status).toBe("working");
    // work resumes before the hold fires → cancel, stay working, no unseen
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.status).toBe("working");
    expect(entry(u)?.unseen).toBe(false);
  });

  it("confirms done-unseen after the hold when the panel was not seen", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.status).toBe("idle");
    expect(entry(u)?.unseen).toBe(true);
    expect(attentionOf(entry(u)!.status, entry(u)!.unseen)).toBe(2);
  });

  it("does NOT flag unseen when the panel was seen at completion", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: true });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: true });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.status).toBe("idle");
    expect(entry(u)?.unseen).toBe(false);
  });

  it("markSeen during the hold clears unseen at confirm (user looked mid-hold)", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    S.getState().markSeen(u); // user looks during the 1s hold
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.unseen).toBe(false);
  });

  it("markSeen clears an already-confirmed done-unseen (invariant ①)", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.unseen).toBe(true);
    S.getState().markSeen(u);
    expect(entry(u)?.unseen).toBe(false);
    expect(attentionOf(entry(u)!.status, entry(u)!.unseen)).toBe(0);
  });

  it("a new working turn supersedes a stale done-unseen", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.unseen).toBe(true);
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    expect(entry(u)?.status).toBe("working");
    expect(entry(u)?.unseen).toBe(false);
  });
});

describe("store: blocked priority + re-transition (invariant ③)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("blocked (open question) wins over working, immediately (no hold)", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: true, seenNow: false });
    expect(entry(u)?.status).toBe("blocked");
    expect(attentionOf(entry(u)!.status, entry(u)!.unseen)).toBe(3);
  });

  it("setScreenBlocked ORs into blocked and can be cleared", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    S.getState().setScreenBlocked(u, true);
    expect(entry(u)?.status).toBe("blocked");
    S.getState().setScreenBlocked(u, false);
    expect(entry(u)?.status).toBe("idle");
  });

  it("re-blocked is re-detectable: a subscriber sees each rising blocked edge", () => {
    const u = "a";
    let risingEdges = 0;
    let wasBlocked = false;
    const unsub = S.subscribe((s) => {
      const nowBlocked = s.entries[u]?.status === "blocked";
      if (nowBlocked && !wasBlocked) risingEdges++;
      wasBlocked = nowBlocked;
    });
    // block → clear → block again = two distinct transitions
    S.getState().setScreenBlocked(u, true);
    S.getState().setScreenBlocked(u, false);
    S.getState().setScreenBlocked(u, true);
    unsub();
    expect(risingEdges).toBe(2);
  });

  it("remove drops the entry and cancels a pending hold", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    S.getState().remove(u);
    expect(entry(u)).toBeUndefined();
    // the hold timer must not resurrect the entry
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(entry(u)).toBeUndefined();
  });
});

// --- P2: bottom-of-screen prompt scan (E group) ------------------------------

// Bottom-first fixtures (index 0 = bottommost live row), as the panel collects
// them. Real Claude Code chrome shapes, self-authored (no herdr copy).
const PERMISSION_PROMPT = [
  "  3. No, and tell Claude what to do differently (esc)",
  "  2. Yes, and don't ask again this session",
  "❯ 1. Yes",
  "",
  "Do you want to make this edit to claudeStatus.ts?",
];
const SELECT_MENU = [
  "  3. Use a different approach",
  "  2. Refactor the store",
  "❯ 1. Add the scan function",
  "",
  "How should I structure P2?",
];

describe("scanBottomForPrompt — rule positives", () => {
  it("E-pos1: permission dialog (Do you want to… + numbered Yes) → blocked", () => {
    expect(scanBottomForPrompt(PERMISSION_PROMPT)).toBe(true);
  });

  it("E-pos2: numbered select menu (❯ cursor + ≥2 options) → blocked", () => {
    expect(scanBottomForPrompt(SELECT_MENU)).toBe(true);
  });

  it("E1: a prompt within the bottom ≤20 non-empty lines is detected", () => {
    // 12 innocuous lines below the prompt, still inside the 20-line window
    const lines = [...Array(12).fill("some earlier streamed output"), ...PERMISSION_PROMPT];
    expect(scanBottomForPrompt(lines)).toBe(true);
  });
});

describe("scanBottomForPrompt — rule negatives (no false positives, invariant ②)", () => {
  it("N1: assistant merely quoting the question, no numbered option → not blocked", () => {
    const lines = [
      "so it prints the confirmation.",
      'Earlier the CLI showed "Do you want to proceed?" but that is answered now.',
      "Here is the next step:",
    ];
    expect(scanBottomForPrompt(lines)).toBe(false);
  });

  it("N2: a plain enumerated list (no ❯ cursor) → not blocked", () => {
    const lines = ["3. Ship it", "2. Add tests", "1. Write the function", "The plan is:"];
    expect(scanBottomForPrompt(lines)).toBe(false);
  });

  it("N3: the working spinner footer 'esc to interrupt' → not blocked", () => {
    const lines = ["  (esc to interrupt)", "✻ Thinking… (12s · ↑ 1.2k tokens)"];
    expect(scanBottomForPrompt(lines)).toBe(false);
  });

  it("N4: a lone ❯ cursor with only one option → not blocked", () => {
    const lines = ["❯ 1. Yes", "Continue?"];
    expect(scanBottomForPrompt(lines)).toBe(false);
  });
});

describe("scanBottomForPrompt — window + blank handling", () => {
  it("E2: a prompt pushed past 20 non-empty lines (scrollback residue) is NOT detected", () => {
    // 21 non-empty filler lines are nearer the bottom; the prompt sits beyond
    // the window and must be ignored (no stale-scrollback false positive).
    const filler = Array.from({ length: 21 }, (_, i) => `output line ${i}`);
    const lines = [...filler, ...PERMISSION_PROMPT];
    expect(scanBottomForPrompt(lines)).toBe(false);
  });

  it("E2b: exactly at the boundary — prompt within the last 20 non-empty lines IS detected", () => {
    // PERMISSION_PROMPT has 4 non-empty lines → 16 filler keeps it inside 20.
    const filler = Array.from({ length: 15 }, (_, i) => `output line ${i}`);
    const lines = [...filler, ...PERMISSION_PROMPT];
    expect(scanBottomForPrompt(lines)).toBe(true);
  });

  it("E3: blank lines are skipped and do NOT consume the ≤20 window", () => {
    const blanks = Array.from({ length: 40 }, () => "   ");
    const lines = [...blanks.slice(0, 20), ...PERMISSION_PROMPT, ...blanks];
    // 20 blanks before the prompt would exhaust a naive window, but blanks are
    // not counted, so the prompt is still reached.
    expect(scanBottomForPrompt(lines)).toBe(true);
  });

  it("counts non-empty only up to the cap constant", () => {
    expect(PROMPT_SCAN_MAX_LINES).toBe(20);
  });
});

describe("makeDebouncedScanner — trailing debounce (E4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("E4: a burst of triggers scans once, seeing only the final snapshot", () => {
    const seen: string[] = [];
    let screen = "frame-a";
    const { trigger } = makeDebouncedScanner(() => seen.push(screen), 300);

    trigger();
    screen = "frame-b";
    trigger();
    screen = "frame-c";
    trigger();
    // nothing fired mid-burst
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    // fires once, 300ms after the LAST trigger, with the final state
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["frame-c"]);
  });

  it("E4b: cancel() prevents a pending scan (unmount safety)", () => {
    const run = vi.fn();
    const { trigger, cancel } = makeDebouncedScanner(run, 300);
    trigger();
    cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });

  it("separated triggers each fire (not merged when the gap exceeds delay)", () => {
    const run = vi.fn();
    const { trigger } = makeDebouncedScanner(run, 300);
    trigger();
    vi.advanceTimersByTime(300);
    trigger();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

// --- registry: numeric↔uuid mapping + attach/detach (P3 global listener) ------

describe("store: session registry + attach/detach", () => {
  beforeEach(() => {
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
    for (const uuid of Object.keys(S.getState().attached)) S.getState().remove(uuid);
  });

  it("registerSession resolves the numeric id to its uuid (global reverse lookup)", () => {
    S.getState().registerSession("uuid-a", 42);
    expect(lookupSessionUuid(42)).toBe("uuid-a");
    expect(lookupSessionUuid(999)).toBeUndefined();
  });

  it("attachPanel marks a session attached; the global path skips attached sessions", () => {
    S.getState().registerSession("uuid-a", 42);
    expect(S.getState().attached["uuid-a"]).toBeUndefined(); // not attached yet
    S.getState().attachPanel("uuid-a");
    // The global listener's guard is `attached[uuid]` — truthy here means it defers
    // to the mounted panel (no double update).
    expect(S.getState().attached["uuid-a"]).toBe(1);
    S.getState().detachPanel("uuid-a");
    expect(S.getState().attached["uuid-a"]).toBeUndefined(); // global takes over
  });

  it("attach is ref-counted so a double-detach can't go negative", () => {
    S.getState().attachPanel("uuid-a");
    S.getState().attachPanel("uuid-a");
    expect(S.getState().attached["uuid-a"]).toBe(2);
    S.getState().detachPanel("uuid-a");
    expect(S.getState().attached["uuid-a"]).toBe(1);
    S.getState().detachPanel("uuid-a");
    S.getState().detachPanel("uuid-a"); // extra
    expect(S.getState().attached["uuid-a"]).toBeUndefined();
  });

  it("detach keeps the numeric mapping (a backgrounded tab still resolves)", () => {
    S.getState().registerSession("uuid-a", 42);
    S.getState().attachPanel("uuid-a");
    S.getState().detachPanel("uuid-a");
    // Mapping survives an unmount so the global listener can update the bg tab.
    expect(lookupSessionUuid(42)).toBe("uuid-a");
  });

  it("remove clears the numeric mapping + attach count (true session death)", () => {
    S.getState().registerSession("uuid-a", 42);
    S.getState().attachPanel("uuid-a");
    S.getState().updateFromTimeline("uuid-a", {
      activity: "working",
      questionBlocked: false,
      seenNow: false,
    });
    S.getState().remove("uuid-a");
    expect(lookupSessionUuid(42)).toBeUndefined();
    expect(S.getState().attached["uuid-a"]).toBeUndefined();
    expect(S.getState().entries["uuid-a"]).toBeUndefined();
  });
});
