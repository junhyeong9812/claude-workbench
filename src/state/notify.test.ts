import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// OS notification plugin is mocked — these tests exercise the edge logic and the
// best-effort wrapper without touching Tauri.
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(() => undefined),
}));

import * as plugin from "@tauri-apps/plugin-notification";
import {
  shouldNotify,
  createTransitionDetector,
  fireOsNotification,
  type NotifyContext,
} from "./notify";
import type { SessionStatus } from "./claudeStatus";

const entry = (status: SessionStatus, unseen: boolean) => ({ status, unseen });

/** Default context: not watching, both toggles on → transitions alert. */
const CTX: NotifyContext = {
  watchedUuid: null,
  focused: false,
  notifEnabled: true,
  soundEnabled: true,
};

function makeDetector() {
  const notify = vi.fn();
  const sound = vi.fn();
  const det = createTransitionDetector({ notify, sound });
  return { det, notify, sound };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// --- shouldNotify (pure) ----------------------------------------------------

describe("shouldNotify — pure edge decision", () => {
  const opts = { watching: false, notifEnabled: true, soundEnabled: true };

  it("fires on a rising edge into blocked (0→3)", () => {
    expect(shouldNotify(0, 3, opts)).toEqual({ notify: true, sound: true, kind: "blocked" });
  });
  it("fires on a rising edge into done-unseen (1→2)", () => {
    expect(shouldNotify(1, 2, opts)).toEqual({ notify: true, sound: true, kind: "done" });
  });
  it("does not fire when attention is unchanged (3→3)", () => {
    expect(shouldNotify(3, 3, opts)).toEqual({ notify: false, sound: false, kind: null });
  });
  it("does not fire on a working edge (0→1)", () => {
    expect(shouldNotify(0, 1, opts)).toEqual({ notify: false, sound: false, kind: null });
  });
  it("does not fire when attention drops (2→0)", () => {
    expect(shouldNotify(2, 0, opts)).toEqual({ notify: false, sound: false, kind: null });
  });
  it("promotes done→blocked (2→3) as a blocked edge (M15)", () => {
    expect(shouldNotify(2, 3, opts)).toEqual({ notify: true, sound: true, kind: "blocked" });
  });
  it("suppresses both outputs while watching but keeps the kind (N4)", () => {
    expect(shouldNotify(0, 3, { ...opts, watching: true })).toEqual({
      notify: false,
      sound: false,
      kind: "blocked",
    });
  });
  it("gates notify independently of sound (N5)", () => {
    expect(shouldNotify(0, 3, { ...opts, notifEnabled: false })).toEqual({
      notify: false,
      sound: true,
      kind: "blocked",
    });
  });
  it("gates sound independently of notify (N6)", () => {
    expect(shouldNotify(0, 3, { ...opts, soundEnabled: false })).toEqual({
      notify: true,
      sound: false,
      kind: "blocked",
    });
  });
});

// --- transition detector (N1–N9) -------------------------------------------

describe("createTransitionDetector — rising edges", () => {
  it("N1: blocked entry alerts exactly once", () => {
    const { det, notify, sound } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false) }, CTX);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "blocked");
    expect(sound).toHaveBeenCalledWith("blocked");
  });

  it("N2: staying blocked does not re-alert", () => {
    const { det, notify } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false) }, CTX);
    det.process({ a: entry("blocked", false) }, CTX);
    det.process({ a: entry("blocked", false) }, CTX);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("N3: done-unseen entry alerts exactly once (working does not)", () => {
    const { det, notify, sound } = makeDetector();
    det.process({ a: entry("working", false) }, CTX);
    expect(notify).not.toHaveBeenCalled(); // working is not an alert
    det.process({ a: entry("idle", true) }, CTX);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "done");
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("N4: watching (active AND focused) suppresses; only-one is not watching", () => {
    // Both true → suppressed.
    {
      const { det, notify, sound } = makeDetector();
      det.process({ a: entry("idle", false) }, CTX);
      det.process({ a: entry("blocked", false) }, { ...CTX, watchedUuid: "a", focused: true });
      expect(notify).not.toHaveBeenCalled();
      expect(sound).not.toHaveBeenCalled();
    }
    // Active panel but window blurred → still alerts (AND not satisfied).
    {
      const { det, notify } = makeDetector();
      det.process({ a: entry("idle", false) }, CTX);
      det.process({ a: entry("blocked", false) }, { ...CTX, watchedUuid: "a", focused: false });
      expect(notify).toHaveBeenCalledTimes(1);
    }
    // Focused but a different panel is active → still alerts.
    {
      const { det, notify } = makeDetector();
      det.process({ a: entry("idle", false) }, CTX);
      det.process({ a: entry("blocked", false) }, { ...CTX, watchedUuid: "other", focused: true });
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });

  it("N5: alerts off → no OS notification but sound still plays (badge unaffected)", () => {
    const { det, notify, sound } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false) }, { ...CTX, notifEnabled: false });
    expect(notify).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledTimes(1);
  });

  it("N6: sound off → tone silent but OS notification still fires", () => {
    const { det, notify, sound } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false) }, { ...CTX, soundEnabled: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sound).not.toHaveBeenCalled();
  });

  it("N8: after the block resolves, a re-block alerts again", () => {
    const { det, notify } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false) }, CTX); // alert 1
    det.process({ a: entry("idle", false) }, CTX); // resolved → attention 0
    det.process({ a: entry("blocked", false) }, CTX); // alert 2
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("N9: after done is seen, a re-done alerts again", () => {
    const { det, notify } = makeDetector();
    det.process({ a: entry("idle", false) }, CTX);
    det.process({ a: entry("idle", true) }, CTX); // done-unseen → alert 1
    det.process({ a: entry("idle", false) }, CTX); // seen (unseen cleared) → 0
    det.process({ a: entry("idle", true) }, CTX); // done again → alert 2
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("prime seeds the baseline without firing", () => {
    const { det, notify } = makeDetector();
    det.prime({ a: entry("blocked", false) });
    det.process({ a: entry("blocked", false) }, CTX);
    expect(notify).not.toHaveBeenCalled();
  });

  it("tracks sessions independently by uuid", () => {
    const { det, notify } = makeDetector();
    det.process({ a: entry("idle", false), b: entry("idle", false) }, CTX);
    det.process({ a: entry("blocked", false), b: entry("idle", true) }, CTX);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith("a", "blocked");
    expect(notify).toHaveBeenCalledWith("b", "done");
  });
});

// --- fireOsNotification best-effort (N7, invariant ⑥) ----------------------

describe("fireOsNotification — best-effort", () => {
  it("N7: a rejected sendNotification does not throw", async () => {
    (plugin.sendNotification as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(fireOsNotification("abcdef01", "blocked")).resolves.toBeUndefined();
  });

  it("degrades silently when permission is denied (no send, no throw)", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (plugin.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("denied");
    await expect(fireOsNotification("abcdef01", "done")).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("sends with a title + body when permitted", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    await fireOsNotification("abcdef0123", "blocked");
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    const arg = (plugin.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toHaveProperty("title");
    expect(arg).toHaveProperty("body");
    expect(String(arg.body)).toContain("abcdef01"); // short uuid
  });
});
