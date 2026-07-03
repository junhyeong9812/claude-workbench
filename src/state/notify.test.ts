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
  edgeKind,
  decideNotify,
  createTransitionDetector,
  fireOsNotification,
  ensureNotifyPermission,
  __resetNotifyForTest,
  type NotifyContext,
} from "./notify";
import type { AttentionEvent, AttentionSignals } from "./claudeStatus";

const sig = (blockedActive: boolean, unseen: boolean): AttentionSignals => ({
  blockedActive,
  unseen,
});

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

/** A live (default) attention event with the given next signals. */
function ev(
  uuid: string,
  next: AttentionSignals | null,
  origin: "live" | "snapshot" = "live",
): AttentionEvent {
  return { uuid, prev: null, next, origin };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetNotifyForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// --- edgeKind: the five S10 combination rules ------------------------------

describe("edgeKind — independent-signal combination rules (S10)", () => {
  it("① both rise at once → blocked only", () => {
    expect(edgeKind(sig(false, false), sig(true, true))).toBe("blocked");
  });
  it("② blocked held while unseen rises → nothing (done suppressed)", () => {
    expect(edgeKind(sig(true, false), sig(true, true))).toBeNull();
  });
  it("③ blocked clears while unseen already true → nothing (not rising)", () => {
    expect(edgeKind(sig(true, true), sig(false, true))).toBeNull();
  });
  it("④ blocked clears AND unseen rises in the same update → done", () => {
    expect(edgeKind(sig(true, false), sig(false, true))).toBe("done");
  });
  it("⑤ done state, blocked rises → blocked (M15)", () => {
    expect(edgeKind(sig(false, true), sig(true, true))).toBe("blocked");
  });

  it("plain rising blocked / done", () => {
    expect(edgeKind(sig(false, false), sig(true, false))).toBe("blocked");
    expect(edgeKind(sig(false, false), sig(false, true))).toBe("done");
  });
  it("no edge when signals are unchanged or dropping", () => {
    expect(edgeKind(sig(true, false), sig(true, false))).toBeNull(); // stay blocked
    expect(edgeKind(sig(false, false), sig(false, false))).toBeNull(); // idle/working
    expect(edgeKind(sig(true, false), sig(false, false))).toBeNull(); // blocked→idle
    expect(edgeKind(sig(false, true), sig(false, false))).toBeNull(); // done seen
  });
});

// --- decideNotify: gating on top of edgeKind --------------------------------

describe("decideNotify — watching + toggle gates", () => {
  const opts = { watching: false, notifEnabled: true, soundEnabled: true };

  it("fires both outputs on a blocked rising edge", () => {
    expect(decideNotify(sig(false, false), sig(true, false), opts)).toEqual({
      notify: true,
      sound: true,
      kind: "blocked",
    });
  });
  it("no edge → nothing", () => {
    expect(decideNotify(sig(true, false), sig(true, false), opts)).toEqual({
      notify: false,
      sound: false,
      kind: null,
    });
  });
  it("suppresses both outputs while watching but keeps the kind (N4)", () => {
    expect(decideNotify(sig(false, false), sig(true, false), { ...opts, watching: true })).toEqual({
      notify: false,
      sound: false,
      kind: "blocked",
    });
  });
  it("gates notify independently of sound (N5)", () => {
    expect(decideNotify(sig(false, false), sig(true, false), { ...opts, notifEnabled: false })).toEqual(
      { notify: false, sound: true, kind: "blocked" },
    );
  });
  it("gates sound independently of notify (N6)", () => {
    expect(decideNotify(sig(false, false), sig(true, false), { ...opts, soundEnabled: false })).toEqual(
      { notify: true, sound: false, kind: "blocked" },
    );
  });
});

// --- transition detector (N1–N9 + S4 + S10 bounce) --------------------------

describe("createTransitionDetector — incremental rising edges", () => {
  it("N1: blocked entry alerts exactly once", () => {
    const { det, notify, sound } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "blocked");
    expect(sound).toHaveBeenCalledWith("blocked");
  });

  it("N2: staying blocked does not re-alert", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("N3: done-unseen alerts once; working (idle signals) does not", () => {
    const { det, notify, sound } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX); // working = idle signals
    expect(notify).not.toHaveBeenCalled();
    det.processEvent(ev("a", sig(false, true)), CTX); // done-unseen
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "done");
    expect(sound).toHaveBeenCalledWith("done");
  });

  it("N4: watching (active AND focused) suppresses; only-one still alerts", () => {
    {
      const { det, notify, sound } = makeDetector();
      det.processEvent(ev("a", sig(false, false)), CTX);
      det.processEvent(ev("a", sig(true, false)), { ...CTX, watchedUuid: "a", focused: true });
      expect(notify).not.toHaveBeenCalled();
      expect(sound).not.toHaveBeenCalled();
    }
    {
      const { det, notify } = makeDetector();
      det.processEvent(ev("a", sig(false, false)), CTX);
      det.processEvent(ev("a", sig(true, false)), { ...CTX, watchedUuid: "a", focused: false });
      expect(notify).toHaveBeenCalledTimes(1);
    }
    {
      const { det, notify } = makeDetector();
      det.processEvent(ev("a", sig(false, false)), CTX);
      det.processEvent(ev("a", sig(true, false)), { ...CTX, watchedUuid: "other", focused: true });
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });

  it("N5: alerts off → no OS notification but sound still plays", () => {
    const { det, notify, sound } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), { ...CTX, notifEnabled: false });
    expect(notify).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledTimes(1);
  });

  it("N6: sound off → tone silent but OS notification still fires", () => {
    const { det, notify, sound } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), { ...CTX, soundEnabled: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(sound).not.toHaveBeenCalled();
  });

  it("N8: after the block resolves, a re-block alerts again", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX); // alert 1
    det.processEvent(ev("a", sig(false, false)), CTX); // resolved
    det.processEvent(ev("a", sig(true, false)), CTX); // alert 2
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("N9: after done is seen, a re-done alerts again", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(false, true)), CTX); // done → alert 1
    det.processEvent(ev("a", sig(false, false)), CTX); // seen
    det.processEvent(ev("a", sig(false, true)), CTX); // done → alert 2
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("S10 bounce: done→blocked→done alerts blocked once, never re-fires done", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(false, true)), CTX); // done (alert 1)
    det.processEvent(ev("a", sig(true, true)), CTX); // →blocked (alert 2), unseen still latched
    det.processEvent(ev("a", sig(false, true)), CTX); // block clears, unseen already true → NO re-done
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, "a", "done");
    expect(notify).toHaveBeenNthCalledWith(2, "a", "blocked");
  });

  it("S4: a snapshot-origin first observation seeds silently (restore no re-alert)", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(true, false), "snapshot"), CTX); // restored blocked
    expect(notify).not.toHaveBeenCalled();
    det.processEvent(ev("a", sig(true, false)), CTX); // still blocked
    expect(notify).not.toHaveBeenCalled();
  });

  it("S4: a live-origin first observation of blocked DOES alert", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(true, false), "live"), CTX);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("S4a: a snapshot event for an ALREADY-tracked uuid re-seeds silently (restore scan)", () => {
    const { det, notify } = makeDetector();
    // Restore order in the panel: timeline snapshot seed (no open question) …
    det.processEvent(ev("a", sig(false, false), "snapshot"), CTX);
    // … then the restore-replay screen scan finds the prompt chrome. The uuid is
    // known by now — the snapshot origin must still seed, not edge.
    det.processEvent(ev("a", sig(true, false), "snapshot"), CTX);
    expect(notify).not.toHaveBeenCalled();
    // A later *live* clear → re-block is a genuine new prompt and alerts.
    det.processEvent(ev("a", sig(false, false), "live"), CTX);
    det.processEvent(ev("a", sig(true, false), "live"), CTX);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "blocked");
  });

  it("S4b: a snapshot-origin hold confirm (unseen rising) does not fire done", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false), "snapshot"), CTX); // restored, held as working
    det.processEvent(ev("a", sig(false, true), "snapshot"), CTX); // hold confirm, snapshot epoch
    expect(notify).not.toHaveBeenCalled();
    // A genuinely new live completion afterwards still alerts.
    det.processEvent(ev("a", sig(false, false), "live"), CTX);
    det.processEvent(ev("a", sig(false, true), "live"), CTX);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("a", "done");
  });

  it("prime seeds the baseline without firing", () => {
    const { det, notify } = makeDetector();
    det.prime({ a: sig(true, false) });
    det.processEvent(ev("a", sig(true, false)), CTX);
    expect(notify).not.toHaveBeenCalled();
  });

  it("removal forgets a uuid so a reused uuid starts fresh", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX); // alert 1
    det.processEvent(ev("a", null), CTX); // removed
    det.processEvent(ev("a", sig(true, false)), CTX); // fresh live blocked → alert 2
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("tracks sessions independently by uuid", () => {
    const { det, notify } = makeDetector();
    det.processEvent(ev("a", sig(false, false)), CTX);
    det.processEvent(ev("b", sig(false, false)), CTX);
    det.processEvent(ev("a", sig(true, false)), CTX);
    det.processEvent(ev("b", sig(false, true)), CTX);
    expect(notify).toHaveBeenCalledWith("a", "blocked");
    expect(notify).toHaveBeenCalledWith("b", "done");
  });
});

// --- fireOsNotification best-effort + permission caching (S13) --------------

describe("fireOsNotification — best-effort + cached permission (S13)", () => {
  it("N7: a rejected sendNotification does not throw", async () => {
    (plugin.sendNotification as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(fireOsNotification("abcdef01", "blocked")).resolves.toBeUndefined();
  });

  it("degrades silently when permission is denied (no send, no throw)", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (plugin.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue("denied");
    await expect(fireOsNotification("abcdef01", "done")).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("sends with a title + body when permitted", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await fireOsNotification("abcdef0123", "blocked");
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    const arg = (plugin.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toHaveProperty("title");
    expect(arg).toHaveProperty("body");
    expect(String(arg.body)).toContain("abcdef01"); // short uuid
  });

  it("S13: once denied, the fire path never re-requests permission", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (plugin.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue("denied");
    await fireOsNotification("a", "blocked"); // requests once
    await fireOsNotification("a", "blocked"); // must reuse the cached denial
    await fireOsNotification("a", "blocked");
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("S13: an interactive request re-prompts even after a cached denial", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (plugin.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue("denied");
    await fireOsNotification("a", "blocked"); // caches denied (1 request)
    await ensureNotifyPermission(true); // gesture → requests again
    expect(plugin.requestPermission).toHaveBeenCalledTimes(2);
  });

  it("S13: concurrent fires share ONE in-flight permission request", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    // Park the request so both fires overlap while it's pending.
    let release: (v: string) => void = () => {};
    (plugin.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((res) => (release = res)),
    );
    const p1 = fireOsNotification("a", "blocked");
    const p2 = fireOsNotification("b", "done");
    // Let both pass isPermissionGranted and reach the (single) parked request.
    await new Promise((r) => setTimeout(r, 0));
    release("granted");
    await Promise.all([p1, p2]);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(2); // both delivered
  });

  it("S13: a throwing permission API caches 'failed' — the fire path stops retrying", async () => {
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ipc down"));
    await fireOsNotification("a", "blocked"); // attempt → failed
    await fireOsNotification("a", "blocked"); // must not touch the API again
    expect(plugin.isPermissionGranted).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    // The settings button (interactive) may still retry — and can recover.
    (plugin.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(ensureNotifyPermission(true)).resolves.toBe(true);
  });
});
