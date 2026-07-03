import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionOf,
  deriveSessionActivity,
  hasOpenQuestion,
  HOLD_MS,
  rollup,
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
