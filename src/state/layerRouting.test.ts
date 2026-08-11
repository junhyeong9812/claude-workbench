import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveLayerMode,
  integratedIsFront,
  devIsFront,
  devLayerMounted,
  routeDevReview,
  shouldFlipToIntegrated,
  nextDevReviewAction,
  type MainLayerMode,
} from "./layerRouting";
import { useAppStore } from "./store";

const P = "/repo/proj";

describe("resolveLayerMode", () => {
  it("defaults to integrated when the project is absent from the sparse map", () => {
    // T2: a project that never entered dev routes to the integrated layer.
    expect(resolveLayerMode({}, P)).toBe("integrated");
    expect(resolveLayerMode({ other: "dev" }, P)).toBe("integrated");
  });

  it("defaults to integrated when there is no active project", () => {
    expect(resolveLayerMode({ [P]: "dev" }, null)).toBe("integrated");
  });

  it("returns dev only for a project explicitly in dev mode", () => {
    expect(resolveLayerMode({ [P]: "dev" }, P)).toBe("dev");
  });
});

describe("front-layer gates (XOR — 불변식 ③)", () => {
  // T3: for ANY mode, exactly one layer is front — never both, never neither.
  const modes: MainLayerMode[] = ["integrated", "dev"];
  it("integrated is front iff integrated mode", () => {
    expect(integratedIsFront("integrated")).toBe(true);
    expect(integratedIsFront("dev")).toBe(false);
  });
  it("dev is front iff dev mode", () => {
    expect(devIsFront("dev")).toBe(true);
    expect(devIsFront("integrated")).toBe(false);
  });
  it("exactly one gate is true for every mode (XOR)", () => {
    for (const m of modes) {
      expect(integratedIsFront(m) !== devIsFront(m)).toBe(true);
    }
  });
});

describe("shouldFlipToIntegrated (B4 — symmetric auto-flip for view-row requests)", () => {
  const A = "/repo/a";
  const B = "/repo/b";
  it("flips when dev is front and the request targets the active project", () => {
    expect(shouldFlipToIntegrated("dev", A, A)).toBe(true);
  });
  it("does not flip when the request is for a DIFFERENT project (stays pending)", () => {
    expect(shouldFlipToIntegrated("dev", B, A)).toBe(false);
  });
  it("does not flip in integrated mode (nothing to flip)", () => {
    expect(shouldFlipToIntegrated("integrated", A, A)).toBe(false);
  });
  it("does not flip with no request project or no active project", () => {
    expect(shouldFlipToIntegrated("dev", null, A)).toBe(false);
    expect(shouldFlipToIntegrated("dev", undefined, A)).toBe(false);
    expect(shouldFlipToIntegrated("dev", A, null)).toBe(false);
  });
});

describe("devLayerMounted latch (④ never-dev = no mount / ② toggle preserves state)", () => {
  it("T11: not mounted before the project ever enters dev", () => {
    expect(devLayerMounted("integrated", false)).toBe(false);
  });
  it("mounted while in dev mode", () => {
    expect(devLayerMounted("dev", false)).toBe(true);
  });
  it("T12: stays mounted after toggling back to integrated within the run", () => {
    // Entered dev once (visited=true); returning to integrated keeps it mounted
    // so the dev session's PTY/tabs survive the round trip.
    expect(devLayerMounted("integrated", true)).toBe(true);
  });
});

// Gate + real-store integration: exercises setProjectMode's sparse-map shape
// feeding resolveLayerMode, and the request-retention contract the effects rely
// on. (Effect *ordering* — side effect before clear, T1 — is verified by code
// review / manual GUI M-scenarios; no component mount here since the project has
// no @testing-library/react.)
describe("store-driven routing (T1/T4/T5)", () => {
  beforeEach(() => {
    useAppStore.setState({ projectModes: {}, activeProject: P, editorOpenRequest: { primary: null, secondary: null } });
  });

  it("T1: integrated mode routes editorOpen to the integrated layer", () => {
    useAppStore.getState().requestEditorOpen("/repo/proj/a.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    expect(mode).toBe("integrated");
    expect(integratedIsFront(mode)).toBe(true);
    expect(devIsFront(mode)).toBe(false);
    expect(s.editorOpenRequest.primary?.path).toBe("/repo/proj/a.ts");
  });

  it("T4: in dev mode the integrated gate is closed, so it must not clear the request", () => {
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().requestEditorOpen("/repo/proj/b.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    // The integrated consumer returns early (gate false) BEFORE requestEditorOpen(null),
    // so the request survives for the dev layer to consume.
    expect(integratedIsFront(mode)).toBe(false);
    expect(devIsFront(mode)).toBe(true);
    expect(s.editorOpenRequest.primary?.path).toBe("/repo/proj/b.ts");
  });

  it("T5: setProjectMode(dev) then editorOpen routes to the dev layer", () => {
    // Same-tick ✓확인 order: flip to dev, then request the editor open.
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().requestEditorOpen("/repo/proj/c.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    expect(mode).toBe("dev");
    expect(devIsFront(mode)).toBe(true);
  });

  it("setProjectMode('integrated') deletes the key (sparse map) → resolves integrated", () => {
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().setProjectMode(P, "integrated");
    expect(useAppStore.getState().projectModes[P]).toBeUndefined();
    expect(resolveLayerMode(useAppStore.getState().projectModes, P)).toBe("integrated");
  });
});

describe("routeDevReview channel (③·#6·F4 — ✓확인/🧪 delivery)", () => {
  it("T6: a live dev-session panel → inject", () => {
    // Dock ready and the dev-claude panel present (subsequent ✓확인): inject the
    // prompt into the already-live session (uuid-matched in ClaudeTermPanel).
    expect(routeDevReview(true, true)).toBe("inject");
  });

  it("T7: fresh mount (dock not ready) → pending, not a lost inject", () => {
    // The ✓확인 flip just mounted DevView; onReady will seed the new session with
    // the prompt. Never inject into a not-yet-live panel (F4 seed race).
    expect(routeDevReview(false, false)).toBe("pending");
    expect(routeDevReview(false, true)).toBe("pending"); // dock-not-ready dominates
  });

  it("dock ready but panel gone (user closed the session) → seed (re-open)", () => {
    expect(routeDevReview(true, false)).toBe("seed");
  });

  it("exactly one channel per state — never both inject and seed", () => {
    for (const dockReady of [false, true]) {
      for (const panelPresent of [false, true]) {
        const r = routeDevReview(dockReady, panelPresent);
        expect(["pending", "inject", "seed"]).toContain(r);
      }
    }
  });
});

describe("ensureDevUuid (⑥ — persisted dev-session id)", () => {
  const DP = "/repo/devproj";
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ devUuids: {} });
  });

  it("T9: idempotent — repeated calls return the same uuid (no regeneration)", () => {
    const first = useAppStore.getState().ensureDevUuid(DP);
    const second = useAppStore.getState().ensureDevUuid(DP);
    expect(second).toBe(first);
    // A different project gets its own distinct uuid.
    expect(useAppStore.getState().ensureDevUuid("/repo/other")).not.toBe(first);
  });

  it("T10: persisted to localStorage → survives a re-hydrate with the same value", () => {
    const uuid = useAppStore.getState().ensureDevUuid(DP);
    // Written through to storage under the project key…
    const persisted = JSON.parse(localStorage.getItem("devUuids") || "{}");
    expect(persisted[DP]).toBe(uuid);
    // …and a fresh store hydrated from that storage resumes the same uuid (the
    // dev session resumes across restarts — no new session spawned).
    useAppStore.setState({ devUuids: persisted });
    expect(useAppStore.getState().ensureDevUuid(DP)).toBe(uuid);
  });
});

describe("devReview FIFO queue (B1/B2 — ③ single-consumer, no clobber)", () => {
  const A = "/repo/a";
  const B = "/repo/b";
  beforeEach(() => {
    useAppStore.setState({ devReviewQueue: [] });
  });

  it("enqueues in order with stable unique ids (no clobber of rapid clicks)", () => {
    useAppStore.getState().requestDevReview({ project: A, prompt: "one" });
    useAppStore.getState().requestDevReview({ project: A, prompt: "two" });
    const q = useAppStore.getState().devReviewQueue;
    expect(q.map((r) => r.prompt)).toEqual(["one", "two"]); // FIFO order preserved
    expect(q[0].id).not.toBe(q[1].id); // distinct ids
    expect(typeof q[0].id).toBe("string");
  });

  it("consumeDevReview removes only the matching id, and is idempotent", () => {
    useAppStore.getState().requestDevReview({ project: A, prompt: "one" });
    useAppStore.getState().requestDevReview({ project: A, prompt: "two" });
    const [first] = useAppStore.getState().devReviewQueue;
    useAppStore.getState().consumeDevReview(first.id);
    expect(useAppStore.getState().devReviewQueue.map((r) => r.prompt)).toEqual(["two"]);
    // Double-consume the same id is a harmless no-op (onReady + effect both fire).
    useAppStore.getState().consumeDevReview(first.id);
    expect(useAppStore.getState().devReviewQueue.map((r) => r.prompt)).toEqual(["two"]);
    // An unknown id is also a no-op.
    useAppStore.getState().consumeDevReview("does-not-exist");
    expect(useAppStore.getState().devReviewQueue.map((r) => r.prompt)).toEqual(["two"]);
  });

  it("a project drains only its own head — other projects' entries never block it", () => {
    useAppStore.getState().requestDevReview({ project: A, prompt: "a1" });
    useAppStore.getState().requestDevReview({ project: B, prompt: "b1" });
    useAppStore.getState().requestDevReview({ project: A, prompt: "a2" });
    // A's DevView takes its head (first entry whose project === A), leaving B's.
    const headA = useAppStore.getState().devReviewQueue.find((r) => r.project === A);
    expect(headA?.prompt).toBe("a1");
    useAppStore.getState().consumeDevReview(headA!.id);
    // B's entry is untouched; A's next is now the head for A.
    const q = useAppStore.getState().devReviewQueue;
    expect(q.map((r) => r.prompt)).toEqual(["b1", "a2"]);
    expect(q.find((r) => r.project === A)?.prompt).toBe("a2");
    expect(q.find((r) => r.project === B)?.prompt).toBe("b1"); // never blocked/removed
  });
});

describe("nextDevReviewAction (B2 — inject pacing over the single claudeInject slot)", () => {
  const A = "/repo/a";
  const q = [
    { id: "1", project: A, prompt: "one" },
    { id: "2", project: A, prompt: "two" },
  ];

  it("delivers the head when the slot is free", () => {
    expect(nextDevReviewAction(q, A, "inject", false)).toEqual({
      kind: "inject",
      id: "1",
      prompt: "one",
    });
  });

  it("waits while the slot is occupied — the entry stays queued (no overwrite)", () => {
    expect(nextDevReviewAction(q, A, "inject", true)).toEqual({ kind: "wait" });
  });

  it("pending (dock not ready) waits regardless of the slot", () => {
    expect(nextDevReviewAction(q, A, "pending", false)).toEqual({ kind: "wait" });
    expect(nextDevReviewAction(q, A, "pending", true)).toEqual({ kind: "wait" });
  });

  it("seed does not use the inject slot (ignores occupancy)", () => {
    expect(nextDevReviewAction(q, A, "seed", true)).toEqual({
      kind: "seed",
      id: "1",
      prompt: "one",
    });
  });

  it("none when the project has no entries", () => {
    expect(nextDevReviewAction(q, "/repo/other", "inject", false)).toEqual({ kind: "none" });
    expect(nextDevReviewAction([], A, "inject", false)).toEqual({ kind: "none" });
  });

  it("store scenario: two rapid ✓확인 flow one per slot vacancy (no clobber)", () => {
    // Mirrors DevView's drain loop against the real store: 2 entries queued, a
    // live panel (route "inject"), single inject slot.
    useAppStore.setState({ devReviewQueue: [], claudeInjectRequest: null });
    useAppStore.getState().requestDevReview({ project: A, prompt: "one" });
    useAppStore.getState().requestDevReview({ project: A, prompt: "two" });

    const step = () => {
      const s = useAppStore.getState();
      const action = nextDevReviewAction(
        s.devReviewQueue,
        A,
        "inject",
        s.claudeInjectRequest !== null,
      );
      if (action.kind === "inject") {
        useAppStore.getState().requestClaudeInject({ id: "r1", uuid: "u", text: action.prompt });
        useAppStore.getState().consumeDevReview(action.id);
      }
      return action;
    };

    // Pass 1: slot free → "one" injected + consumed; next step sees the slot
    // occupied → wait, so "two" SURVIVES in the queue (not overwritten).
    expect(step().kind).toBe("inject");
    expect(useAppStore.getState().claudeInjectRequest?.text).toBe("one");
    expect(step().kind).toBe("wait");
    expect(useAppStore.getState().devReviewQueue.map((r) => r.prompt)).toEqual(["two"]);

    // ClaudeTermPanel consumes the inject (slot → null) → next pass delivers "two".
    useAppStore.getState().requestClaudeInject(null);
    expect(step().kind).toBe("inject");
    expect(useAppStore.getState().claudeInjectRequest?.text).toBe("two");
    expect(useAppStore.getState().devReviewQueue).toEqual([]);
    useAppStore.setState({ claudeInjectRequest: null });
  });
});
