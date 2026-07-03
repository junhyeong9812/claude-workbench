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
    const dispose = initClaudeStatusGlobal(); // registers 2 deferred listens
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
});
