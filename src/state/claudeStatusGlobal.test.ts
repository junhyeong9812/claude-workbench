import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control when each `listen()` registration resolves so we can drive the
// dispose-before-resolve race (S3). The real Tauri event API is mocked.
let listenImpl: () => Promise<() => void>;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => listenImpl()),
}));

import { listen } from "@tauri-apps/api/event";
import { initClaudeStatusGlobal } from "./claudeStatusGlobal";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("initClaudeStatusGlobal — async race + retry (S3)", () => {
  let resolvers: Array<(un: () => void) => void>;

  beforeEach(() => {
    resolvers = [];
    (listen as ReturnType<typeof vi.fn>).mockClear();
    // Deferred: each listen() parks its resolver so the test lands it on demand.
    listenImpl = () => new Promise<() => void>((res) => resolvers.push(res));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a listen() that resolves AFTER dispose is immediately unlistened (no leak)", async () => {
    const dispose = initClaudeStatusGlobal(); // registers 3 deferred listens
    dispose(); // tear down before either resolves

    // The two registrations land late — each must self-unlisten at once.
    const lateSpies = resolvers.map(() => vi.fn());
    resolvers.forEach((r, i) => r(lateSpies[i]));
    await flush();
    for (const s of lateSpies) expect(s).toHaveBeenCalledTimes(1);

    // Re-setup: a fresh init registers new listeners; when they land they stay
    // active (not disposed), and only these are torn down on the next dispose —
    // exactly one live listener set, no leaked duplicate from the first attempt.
    resolvers = [];
    const dispose2 = initClaudeStatusGlobal();
    const liveSpies = resolvers.map(() => vi.fn());
    resolvers.forEach((r, i) => r(liveSpies[i]));
    await flush();
    for (const s of liveSpies) expect(s).not.toHaveBeenCalled();
    dispose2();
    for (const s of liveSpies) expect(s).toHaveBeenCalledTimes(1);
  });

  it("a rejected registration reopens started so a later init retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    listenImpl = () => Promise.reject(new Error("register failed"));
    initClaudeStatusGlobal();
    await flush();

    // A retry must actually re-register (it would be skipped if `started` stayed
    // stuck true after the failure).
    listenImpl = () => Promise.resolve(vi.fn());
    (listen as ReturnType<typeof vi.fn>).mockClear();
    const dispose = initClaudeStatusGlobal();
    expect(listen).toHaveBeenCalled();
    await flush();
    dispose();
  });

  it("S3: generation-crossed resolve — A's late listeners can't join B's set", async () => {
    // init A (deferred) → dispose A → init B (deferred) → A's listens resolve.
    // With a shared boolean, B's init would reset `disposed=false` and A's late
    // resolutions would be pushed into B's list (leak). Generations prevent it.
    const disposeA = initClaudeStatusGlobal();
    const aResolvers = resolvers.splice(0);
    disposeA();

    const disposeB = initClaudeStatusGlobal(); // new generation, still pending
    const bResolvers = resolvers.splice(0);

    // A's registrations land AFTER B started — must self-unlisten immediately.
    const aSpies = aResolvers.map(() => vi.fn());
    aResolvers.forEach((r, i) => r(aSpies[i]));
    await flush();
    for (const s of aSpies) expect(s).toHaveBeenCalledTimes(1);

    // B's registrations stay live and are exactly what dispose B tears down.
    const bSpies = bResolvers.map(() => vi.fn());
    bResolvers.forEach((r, i) => r(bSpies[i]));
    await flush();
    for (const s of bSpies) expect(s).not.toHaveBeenCalled();
    disposeB();
    for (const s of bSpies) expect(s).toHaveBeenCalledTimes(1);
  });

  it("S3: partial registration failure cleans up the surviving sibling (no duplicate on retry)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // First listen succeeds, second rejects.
    const survivor = vi.fn();
    let call = 0;
    listenImpl = () =>
      call++ === 0 ? Promise.resolve(survivor) : Promise.reject(new Error("half failed"));
    initClaudeStatusGlobal();
    await flush();
    // The failure must have torn down the sibling that DID register…
    expect(survivor).toHaveBeenCalledTimes(1);

    // …and reopened started so a retry re-registers cleanly.
    resolvers = [];
    listenImpl = () => new Promise<() => void>((res) => resolvers.push(res));
    (listen as ReturnType<typeof vi.fn>).mockClear();
    const dispose = initClaudeStatusGlobal();
    expect(listen).toHaveBeenCalledTimes(3); // all listeners re-registered (timeline·closed·hook)
    const spies = resolvers.map(() => vi.fn());
    resolvers.forEach((r, i) => r(spies[i]));
    await flush();
    dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  it("S3: failure landing after the sibling's success still cleans up (order-independent)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const survivor = vi.fn();
    let rejectLate: (e: Error) => void = () => {};
    let call = 0;
    listenImpl = () =>
      call++ === 0
        ? Promise.resolve(survivor)
        : new Promise<() => void>((_res, rej) => (rejectLate = rej));
    initClaudeStatusGlobal();
    await flush(); // success already pushed into the current generation
    expect(survivor).not.toHaveBeenCalled();
    rejectLate(new Error("late failure"));
    await flush();
    // The late failure still unlistens the already-registered sibling.
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it("S3: a stale disposer re-invoked after its generation ended is a no-op (doesn't kill B)", async () => {
    // init A → dispose A → init B (listeners live) → call A's disposer again:
    // B's listeners must survive; only B's own disposer tears them down.
    const disposeA = initClaudeStatusGlobal();
    resolvers.splice(0).forEach((r) => r(vi.fn()));
    await flush();
    disposeA(); // A ends

    const disposeB = initClaudeStatusGlobal();
    const bSpies = resolvers.splice(0).map((r) => {
      const s = vi.fn();
      r(s);
      return s;
    });
    await flush();

    disposeA(); // stale handle re-invoked — must NOT touch B's generation
    for (const s of bSpies) expect(s).not.toHaveBeenCalled();

    disposeB();
    for (const s of bSpies) expect(s).toHaveBeenCalledTimes(1);
  });
});

describe("P6 D3 — 전송 커밋 콜백 배선(S9)", () => {
  it("모듈 import만으로 커밋 콜백이 배지를 제거한다(미등록 무음 실패 차단)", async () => {
    const { useClaudeStatus } = await import("./claudeStatus");
    const { __testFireTransferCommitted } = await import("./windowTransfer");
    useClaudeStatus.getState().updateFromTimeline("uuid-s9", {
      activity: "working",
      questionBlocked: false,
      seenNow: false,
      origin: "live",
    });
    expect(useClaudeStatus.getState().entries["uuid-s9"]).toBeTruthy();
    __testFireTransferCommitted("uuid-s9");
    expect(useClaudeStatus.getState().entries["uuid-s9"]).toBeUndefined();
  });
});
