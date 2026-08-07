import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionOf,
  attentionUuids,
  deriveSessionActivity,
  hasOpenQuestion,
  HOLD_MS,
  lookupSessionUuid,
  makeDebouncedScanner,
  makeScanGate,
  nextCycleTarget,
  onAttentionEvent,
  PROMPT_SCAN_MAX_LINES,
  rollup,
  isWriteBlocked,
  statusOf,
  scanBottomForPrompt,
  shouldShowRollup,
  useClaudeStatus,
  type ActivityItem,
  type AttentionEvent,
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

/**
 * 미신뢰 폴더의 trust 대화 — **실측 고정**(2026-08-07, claude 2.1.223).
 *
 * 새 /tmp 디렉토리에서 실 PTY로 띄운 화면을 xterm 버퍼에 넣고
 * `translateToString(true)`로 뽑은 줄을 **그대로** 옮긴 것이다(bottom-first).
 * 손으로 지어낸 모양이 아니라 실제로 렌더된 글자라, 시드 발사 게이트가 trust
 * 대화까지 덮는다는 근거가 이 픽스처다 — 규칙을 손대다 이게 깨지면 미신뢰
 * 폴더에서 시드가 trust 메뉴의 키 입력으로 들어간다.
 *
 * 같은 실측에서 함께 확인된 것: **미신뢰 폴더에서는 PTY 준비 신호(대체 화면
 * 진입)가 아예 나오지 않는다** — trust 대화는 인라인으로 그려진다. 그래서 그
 * 세션의 시드는 폴백 3000ms 경로를 타고, 화면은 1.0s에 이미 다 그려져 있어
 * 발사 시각의 스캔이 이 대화를 확실히 본다(여유 ~2s).
 */
const TRUST_DIALOG = [
  " Enter to confirm · Esc to cancel",
  "   2. No, exit",
  " ❯ 1. Yes, I trust this folder",
  " Security guide",
  " Claude Code'll be able to read, edit, and execute files here.",
  " take a moment to review what's in this folder first.",
  " own code, a well-known open source project, or work from your team). If not,",
  " Quick safety check: Is this a project you created or one you trust? (Like your",
  " /tmp/wb-trust-probe-23051",
  " Accessing workspace:",
];

// --- 쓰기 게이트 판정: 원시 신호 합집합 (codex N2) --------------------------

describe("isWriteBlocked", () => {
  const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
    status: "idle",
    unseen: false,
    activity: "quiet",
    questionBlocked: false,
    screenBlocked: false,
    seen: true,
    seenDuringHold: false,
    hookBacked: false,
    hookBlocked: false,
    ...over,
  });

  it("신호가 하나도 없으면 통과", () => {
    expect(isWriteBlocked(entry())).toBe(false);
  });

  it("엔트리가 없으면 통과 — 신호가 없는 것이지 막힌 것이 아니다", () => {
    expect(isWriteBlocked(undefined)).toBe(false);
    expect(isWriteBlocked(null)).toBe(false);
  });

  it("세 신호 각각 단독으로 막는다", () => {
    expect(isWriteBlocked(entry({ questionBlocked: true }))).toBe(true);
    expect(isWriteBlocked(entry({ hookBlocked: true }))).toBe(true);
    expect(isWriteBlocked(entry({ screenBlocked: true }))).toBe(true);
  });

  it("**hookBacked여도 화면 신호를 무시하지 않는다** — 표시 판정과 갈리는 지점", () => {
    // 표시(statusOf)는 hook을 정본으로 삼아 이 조합을 "안 막힘"으로 읽는다.
    // 쓰기 게이트가 그걸 그대로 쓰면, hook 해제가 화면 재도색보다 먼저 도착한
    // 순간 대화가 아직 떠 있는데 게이트가 열린다(codex N2).
    const e = entry({ hookBacked: true, hookBlocked: false, screenBlocked: true });
    expect(isWriteBlocked(e)).toBe(true);
    expect(statusOf(e)).toBe("idle"); // 표시는 반대로 읽는다 — 의도된 차이
  });
});

describe("scanBottomForPrompt — rule positives", () => {
  it("E-pos1: permission dialog (Do you want to… + numbered Yes) → blocked", () => {
    expect(scanBottomForPrompt(PERMISSION_PROMPT)).toBe(true);
  });

  it("E-pos2: numbered select menu (❯ cursor + ≥2 options) → blocked", () => {
    expect(scanBottomForPrompt(SELECT_MENU)).toBe(true);
  });

  it("E-pos3: 미신뢰 폴더 trust 대화(실측 화면 그대로) → blocked", () => {
    // 규칙 2(❯ 커서 + 숫자 옵션 ≥2)가 이미 덮는다 — 패턴 보강 없이 커버된다는
    // 실확인 결과를 코드에 고정한다.
    expect(scanBottomForPrompt(TRUST_DIALOG)).toBe(true);
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

  // S4a: the batch origin is captured per trigger, not read at execution time.
  it("S4a: an all-snapshot batch runs with origin snapshot (even if 'now' is live)", () => {
    const run = vi.fn();
    const { trigger } = makeDebouncedScanner(run, 300);
    trigger("snapshot"); // restore replay — nothing else happens
    // (a shared-variable design would read "live" here if the phase advanced)
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledWith("snapshot");
  });

  it("S4a: a live trigger inside the batch promotes the whole batch to live", () => {
    const run = vi.fn();
    const { trigger } = makeDebouncedScanner(run, 300);
    trigger("snapshot"); // restore replay …
    trigger("live"); // … then real new output within the debounce window
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledWith("live");
  });

  it("S4a: the batch origin resets after each run (live batch doesn't taint the next)", () => {
    const run = vi.fn();
    const { trigger } = makeDebouncedScanner(run, 300);
    trigger("live");
    vi.advanceTimersByTime(300);
    trigger("snapshot");
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenNthCalledWith(1, "live");
    expect(run).toHaveBeenNthCalledWith(2, "snapshot");
  });

  it("S4a: trigger() without an origin defaults to live", () => {
    const run = vi.fn();
    const { trigger } = makeDebouncedScanner(run, 300);
    trigger();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledWith("live");
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

  // S6: bidirectional registry hygiene ---------------------------------------

  it("S6: re-registering a uuid under a new numeric id drops the stale reverse", () => {
    S.getState().registerSession("uuid-a", 42);
    S.getState().registerSession("uuid-a", 43); // same session, new PTY id
    expect(lookupSessionUuid(43)).toBe("uuid-a");
    expect(lookupSessionUuid(42)).toBeUndefined(); // stale reverse evicted
  });

  it("S6: reusing a numeric id for a new uuid unbinds the old uuid's forward map", () => {
    S.getState().registerSession("uuid-a", 42);
    S.getState().registerSession("uuid-b", 42); // id 42 reused by a new session
    expect(lookupSessionUuid(42)).toBe("uuid-b");
    // uuid-a's forward mapping is gone, so removing it can't touch 42 (below).
    S.getState().remove("uuid-a");
    expect(lookupSessionUuid(42)).toBe("uuid-b"); // still the new session
  });

  it("S6: a stale close for a reused numeric id does NOT unmap the new session", () => {
    S.getState().registerSession("uuid-a", 42);
    S.getState().registerSession("uuid-b", 42); // 42 now → uuid-b
    // An old close event for uuid-a arrives late; it must not delete 42→uuid-b.
    S.getState().remove("uuid-a");
    expect(lookupSessionUuid(42)).toBe("uuid-b");
  });
});

// --- S7: seenDuringHold latch ------------------------------------------------

describe("store: seenDuringHold latch (S7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a markSeen during the hold survives a later seenNow:false quiet tick", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    S.getState().markSeen(u); // user looked mid-hold → latch
    // A subsequent quiet tick still reports not-looking; without the latch this
    // would reset seen and the hold would confirm unseen=true.
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.unseen).toBe(false);
  });

  it("the latch resets when real work resumes (a genuinely-unseen next completion)", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    S.getState().markSeen(u); // latch
    vi.advanceTimersByTime(HOLD_MS); // confirms seen (unseen false)
    expect(entry(u)?.unseen).toBe(false);
    // New work, then it finishes unseen — the latch must have reset.
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    expect(entry(u)?.seenDuringHold).toBe(false);
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    vi.advanceTimersByTime(HOLD_MS);
    expect(entry(u)?.unseen).toBe(true);
  });
});

// --- S8 / S12: watchedUuid + activeClaudeUuid lifecycle ----------------------

describe("store: watchedUuid + activeClaudeUuid (S8/S12)", () => {
  beforeEach(() => {
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
    S.getState().setWatched(null);
    S.getState().setActiveClaudeUuid(null);
  });

  it("S12: setActiveClaudeUuid tracks the dock-active session", () => {
    S.getState().setActiveClaudeUuid("a");
    expect(S.getState().activeClaudeUuid).toBe("a");
    S.getState().setActiveClaudeUuid(null);
    expect(S.getState().activeClaudeUuid).toBeNull();
  });

  it("S8: remove clears watchedUuid + activeClaudeUuid when they point at it", () => {
    S.getState().updateFromTimeline("a", { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().setWatched("a");
    S.getState().setActiveClaudeUuid("a");
    S.getState().remove("a");
    expect(S.getState().watchedUuid).toBeNull();
    expect(S.getState().activeClaudeUuid).toBeNull();
  });

  it("S8: remove leaves a DIFFERENT watched/active session alone", () => {
    S.getState().updateFromTimeline("a", { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().setWatched("b");
    S.getState().setActiveClaudeUuid("b");
    S.getState().remove("a");
    expect(S.getState().watchedUuid).toBe("b");
    expect(S.getState().activeClaudeUuid).toBe("b");
  });
});

// --- minor: no ghost entry from setScreenBlocked(false) ----------------------

describe("store: setScreenBlocked ghost-entry guard (minor)", () => {
  beforeEach(() => {
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });

  it("clearing screen-blocked on an unknown uuid does not create an entry", () => {
    S.getState().setScreenBlocked("never-seen", false);
    expect(S.getState().entries["never-seen"]).toBeUndefined();
  });

  it("setting screen-blocked true DOES create the entry", () => {
    S.getState().setScreenBlocked("fresh", true);
    expect(S.getState().entries["fresh"]?.status).toBe("blocked");
  });
});

// --- S11: attention event bus ------------------------------------------------

describe("store: onAttentionEvent bus (S11)", () => {
  beforeEach(() => {
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });

  it("emits prev/next signals + origin for a changed session", () => {
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    S.getState().updateFromTimeline("a", {
      activity: "working",
      questionBlocked: true,
      seenNow: false,
    });
    unsub();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      uuid: "a",
      prev: null, // newly created
      next: { blockedActive: true, unseen: false },
      origin: "live",
    });
  });

  it("carries the snapshot origin through for a restore seed", () => {
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    S.getState().updateFromTimeline("a", {
      activity: "quiet",
      questionBlocked: false,
      seenNow: false,
      origin: "snapshot",
    });
    unsub();
    expect(seen[0]?.origin).toBe("snapshot");
  });

  it("emits a removal event (next === null) on remove", () => {
    S.getState().updateFromTimeline("a", { activity: "working", questionBlocked: false, seenNow: false });
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    S.getState().remove("a");
    unsub();
    expect(seen[seen.length - 1]).toMatchObject({ uuid: "a", next: null });
  });

  it("S11: a throwing listener is isolated — later listeners still run, the action survives", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    const un1 = onAttentionEvent(() => {
      throw new Error("subscriber boom");
    });
    const un2 = onAttentionEvent(after);
    // The action (and through it its caller) must not see the throw.
    expect(() =>
      S.getState().updateFromTimeline("a", { activity: "working", questionBlocked: false, seenNow: false }),
    ).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    un1();
    un2();
    errSpy.mockRestore();
  });
});

// --- S4a/S4b: snapshot-origin propagation ------------------------------------

describe("store: snapshot origin propagation (S4a/S4b)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const uuid of Object.keys(S.getState().entries)) S.getState().remove(uuid);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("S4a: setScreenBlocked forwards a snapshot origin to the bus (restore scan)", () => {
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    S.getState().setScreenBlocked("a", true, "snapshot");
    unsub();
    expect(seen[0]).toMatchObject({
      uuid: "a",
      next: { blockedActive: true, unseen: false },
      origin: "snapshot",
    });
  });

  it("S4a: setScreenBlocked defaults to live (new-output scan)", () => {
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    S.getState().setScreenBlocked("a", true);
    unsub();
    expect(seen[0]?.origin).toBe("live");
  });

  it("S4b: a hold scheduled by a snapshot tick confirms with origin snapshot", () => {
    const u = "a";
    // Snapshot seed shows mid-work, then a snapshot quiet schedules the hold.
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false, origin: "snapshot" });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false, origin: "snapshot" });
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    vi.advanceTimersByTime(HOLD_MS);
    unsub();
    // The confirm commit (unseen goes true) carries the scheduling origin.
    expect(seen[seen.length - 1]).toMatchObject({
      uuid: u,
      next: { blockedActive: false, unseen: true },
      origin: "snapshot",
    });
  });

  it("S4b: a hold scheduled by a live tick still confirms live", () => {
    const u = "a";
    S.getState().updateFromTimeline(u, { activity: "working", questionBlocked: false, seenNow: false });
    S.getState().updateFromTimeline(u, { activity: "quiet", questionBlocked: false, seenNow: false });
    const seen: AttentionEvent[] = [];
    const unsub = onAttentionEvent((e) => seen.push(e));
    vi.advanceTimersByTime(HOLD_MS);
    unsub();
    expect(seen[seen.length - 1]?.origin).toBe("live");
  });
});

// --- S1: empty-screen scan gate ------------------------------------------------

describe("makeScanGate (S1)", () => {
  it("rejects empty scans before the first non-empty screen (restore not painted)", () => {
    const g = makeScanGate();
    expect(g.admit(false)).toBe(false); // blank pre-restore — ignore
    expect(g.admit(false)).toBe(false); // still blank — ignore
  });

  it("admits empty scans after a non-empty screen (real clear-screen unblocks)", () => {
    const g = makeScanGate();
    expect(g.admit(true)).toBe(true); // restore painted (maybe a prompt)
    expect(g.admit(false)).toBe(true); // later blank = actual clear → may clear blocked
  });

  it("S1: arm() admits empty scans even when the screen was never non-empty", () => {
    const g = makeScanGate();
    expect(g.admit(false)).toBe(false); // pre-arm blank — restore not painted, ignore
    g.arm(); // the post-restore scheduled scan is issued — restore is over
    // A genuinely-empty restored screen is now a valid verdict (clears a stale
    // blocked signal instead of leaving it sticky).
    expect(g.admit(false)).toBe(true);
  });
});
