import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  useClaudeStatus,
  onAttentionEvent,
  type AttentionEvent,
  type AttentionSignals,
} from "./claudeStatus";

/**
 * Attention notifications + tones (agent-status-badges P4).
 *
 * Best-effort side channel layered on top of the P1 store. It subscribes to the
 * store's **attention event bus** (S11 — the store pushes only a changed uuid's
 * prev/next signals, so this never re-scans all sessions) and, on a rising edge
 * into an attention state, fires an OS notification and a Web Audio tone.
 * Everything here is fire-and-forget: a denied permission, a rejected
 * `sendNotification`, or an unavailable `AudioContext` degrades to silence with a
 * single `console.warn` and never throws (invariant ⑥) — the badge, which lives
 * in the store, keeps working regardless.
 *
 * Edge model (S10): `blockedActive` and `unseen` are treated as **independent
 * signals**, not a single scalar. The combination rules (see {@link edgeKind})
 * make blocked strictly dominate done, so e.g. a done→blocked→done bounce alerts
 * blocked once and never re-fires done (the old scalar 2→3→2 double-alert bug).
 *
 * Suppression (N4): a session the user is actively watching — its panel active
 * AND the window focused (`watchedUuid` === uuid && document.hasFocus()) — is
 * silenced.
 */

export type NotifKind = "blocked" | "done";

export interface NotifPrefs {
  notifEnabled: boolean;
  soundEnabled: boolean;
}

// --- prefs (cached — S2: no localStorage read on the fire path) --------------

/** Read the user's alert/sound toggles from localStorage (TerminalSettings writes
 * them). Both default ON — the key is absent until the user opts out, so only an
 * explicit "0" disables. Independent axes (N5/N6). */
export function readNotifPrefs(): NotifPrefs {
  return {
    notifEnabled: localStorage.getItem("notifyEnabled") !== "0",
    soundEnabled: localStorage.getItem("soundEnabled") !== "0",
  };
}

/** Module cache so the hot fire path never hits localStorage (S2). Seeded on
 * first use; kept in sync by the setters below. */
let prefsCache: NotifPrefs | null = null;
function cachedPrefs(): NotifPrefs {
  if (!prefsCache) prefsCache = readNotifPrefs();
  return prefsCache;
}

export function setNotifEnabled(on: boolean): void {
  localStorage.setItem("notifyEnabled", on ? "1" : "0");
  prefsCache = { ...cachedPrefs(), notifEnabled: on };
}
export function setSoundEnabled(on: boolean): void {
  localStorage.setItem("soundEnabled", on ? "1" : "0");
  prefsCache = { ...cachedPrefs(), soundEnabled: on };
}

// --- pure edge decision (S10) ----------------------------------------------

/**
 * Which alert (if any) a prev→next signal change fires. Blocked and done-unseen
 * are independent rising edges combined by these rules:
 *  ① both rise at once           → blocked only  (blocked dominates)
 *  ② blocked held, unseen rises   → nothing        (`!next.blockedActive` guard)
 *  ③ blocked clears, unseen already true → nothing (unseen not *rising*)
 *  ④ blocked clears AND unseen rises same update → done
 *  ⑤ done, blocked rises          → blocked        (any blocked rising edge)
 * So done fires exactly on `!next.blockedActive && unseen rising`.
 */
export function edgeKind(prev: AttentionSignals, next: AttentionSignals): NotifKind | null {
  const blockedRising = next.blockedActive && !prev.blockedActive;
  const unseenRising = next.unseen && !prev.unseen;
  if (blockedRising) return "blocked";
  if (unseenRising && !next.blockedActive) return "done";
  return null;
}

export interface NotifDecision {
  /** Fire an OS notification. */
  notify: boolean;
  /** Play the tone. */
  sound: boolean;
  /** Which transition this is (null when there's no attention rising edge). */
  kind: NotifKind | null;
}

/**
 * Pure decision for one signal transition: the {@link edgeKind}, then gated by
 * watching (both outputs off) and the independent notif/sound toggles (N5/N6).
 */
export function decideNotify(
  prev: AttentionSignals,
  next: AttentionSignals,
  opts: { watching: boolean; notifEnabled: boolean; soundEnabled: boolean },
): NotifDecision {
  const kind = edgeKind(prev, next);
  if (!kind) return { notify: false, sound: false, kind: null };
  if (opts.watching) return { notify: false, sound: false, kind };
  return { notify: opts.notifEnabled, sound: opts.soundEnabled, kind };
}

/** Where a fired notification/tone is delivered — injected so the edge detector
 * is unit-testable without touching the OS or Web Audio. */
export interface NotifySinks {
  notify: (uuid: string, kind: NotifKind) => void;
  sound: (kind: NotifKind) => void;
}

/** Everything the detector needs about "now" beyond the event itself. */
export interface NotifyContext {
  watchedUuid: string | null;
  focused: boolean;
  notifEnabled: boolean;
  soundEnabled: boolean;
}

const IDLE_SIGNALS: AttentionSignals = { blockedActive: false, unseen: false };

/**
 * Incremental rising-edge detector (S11). It holds each uuid's last signals and,
 * on each {@link AttentionEvent}, fires the sinks for a rising edge. `prime`
 * seeds baselines without firing (so pre-existing states at startup don't alert).
 * ANY `snapshot`-origin event silently re-seeds the baseline — restore paths
 * (the snapshot timeline seed, the restore-replay screen scan, a snapshot-
 * scheduled hold confirm) must never alert, even for a uuid already tracked
 * (S4/S4a/S4b). A `live` first sighting edges from idle so a genuinely-new
 * blocked/done still fires.
 */
export function createTransitionDetector(sinks: NotifySinks) {
  const prev = new Map<string, AttentionSignals>();

  return {
    /** Record current signals for every entry without firing (startup seed). */
    prime(signals: Record<string, AttentionSignals>) {
      for (const [uuid, s] of Object.entries(signals)) prev.set(uuid, s);
    },
    /** Handle one attention event and fire sinks on a qualifying rising edge. */
    processEvent(ev: AttentionEvent, ctx: NotifyContext) {
      if (ev.next === null) {
        // Session gone — forget it so a reused uuid starts fresh.
        prev.delete(ev.uuid);
        return;
      }
      const next = ev.next;
      if (ev.origin === "snapshot") {
        // Restore seed — adopt the state silently (S4a: whether or not the uuid
        // was already seen; a restore scan can land after the timeline seed).
        prev.set(ev.uuid, next);
        return;
      }
      const base = prev.get(ev.uuid) ?? IDLE_SIGNALS; // live first sighting edges from idle
      prev.set(ev.uuid, next);
      const watching = ctx.watchedUuid === ev.uuid && ctx.focused;
      const d = decideNotify(base, next, {
        watching,
        notifEnabled: ctx.notifEnabled,
        soundEnabled: ctx.soundEnabled,
      });
      if (d.kind == null) return;
      if (d.notify) sinks.notify(ev.uuid, d.kind);
      if (d.sound) sinks.sound(d.kind);
    },
  };
}

// --- OS notification (best-effort) -----------------------------------------

let warnedPermission = false;
let warnedSend = false;

/** Cached permission verdict (S13). "unknown" until first checked; "failed" =
 * the permission API itself threw — the fire path won't retry (only the settings
 * button's interactive request can). */
export type NotifyPermission = "granted" | "denied" | "unknown" | "failed";
let permissionState: NotifyPermission = "unknown";
/** In-flight permission check/request — concurrent fires await the SAME promise
 * so a burst of alerts can't stack OS permission prompts (S13). */
let permRequest: Promise<boolean> | null = null;

/**
 * Ensure OS-notification permission, caching the result. `interactive:false`
 * (the fire path) requests at most once, and once denied — or once the API
 * threw ("failed") — never retries. `interactive:true` (the settings button, a
 * user gesture) always attempts again. Concurrent callers share one in-flight
 * request. Never throws.
 */
export function ensureNotifyPermission(interactive: boolean): Promise<boolean> {
  if (permissionState === "granted") return Promise.resolve(true);
  if (!interactive && (permissionState === "denied" || permissionState === "failed")) {
    return Promise.resolve(false);
  }
  if (permRequest) return permRequest;
  permRequest = (async () => {
    try {
      if (await isPermissionGranted()) {
        permissionState = "granted";
        return true;
      }
      if (permissionState === "denied" && !interactive) return false;
      const res = await requestPermission();
      permissionState = res === "granted" ? "granted" : "denied";
      return permissionState === "granted";
    } catch {
      // API failure (plugin missing, IPC error): remember it so the fire path
      // stops retrying — the settings button (interactive) may try again.
      permissionState = "failed";
      return false;
    } finally {
      permRequest = null;
    }
  })();
  return permRequest;
}

/** Current cached permission verdict (for the settings display). */
export function notifyPermissionState(): NotifyPermission {
  return permissionState;
}

/** Re-query the OS permission (settings panel open) and update the cache. */
export async function refreshNotifyPermission(): Promise<NotifyPermission> {
  try {
    if (await isPermissionGranted()) permissionState = "granted";
    else if (permissionState === "granted") permissionState = "unknown";
  } catch {
    /* leave cache as-is */
  }
  return permissionState;
}

/** Copy for each transition (Korean, matching the app's hardcoded UI language). */
function bodyFor(uuid: string, kind: NotifKind): { title: string; body: string } {
  const short = uuid.slice(0, 8);
  return kind === "blocked"
    ? { title: "에이전트 — 입력 대기 중", body: `세션 ${short}이(가) 응답을 기다립니다` }
    : { title: "에이전트 — 작업 완료", body: `세션 ${short}의 작업이 끝났습니다` };
}

/**
 * Send an OS notification (best-effort). Uses the cached permission (requests at
 * most once, never re-prompts once denied — S13). Never throws: a denied
 * permission or a rejected `sendNotification` degrades to silence with a single
 * `console.warn` (invariant ⑥, N7). Awaitable for tests.
 */
export async function fireOsNotification(uuid: string, kind: NotifKind): Promise<void> {
  try {
    if (!(await ensureNotifyPermission(false))) {
      if (!warnedPermission) {
        console.warn("[notify] OS notification permission not granted — alerts silenced");
        warnedPermission = true;
      }
      return;
    }
    const { title, body } = bodyFor(uuid, kind);
    await sendNotification({ title, body });
  } catch (err) {
    if (!warnedSend) {
      console.warn("[notify] OS notification failed — degrading to silent", err);
      warnedSend = true;
    }
  }
}

// --- Web Audio tone (asset-free, generated) --------------------------------

let audioCtx: AudioContext | null = null;
let warnedAudio = false;

function getAudioCtx(): AudioContext | null {
  try {
    const Ctor: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Resume the AudioContext from a user gesture (settings button) so later
 * fire-time tones aren't blocked by the autoplay policy (S13). Best-effort. */
export function primeAudio(): void {
  const ac = getAudioCtx();
  if (ac && ac.state === "suspended") void ac.resume().catch(() => {});
}

/** Schedule one sine beep with a short attack/release so it doesn't click. */
function beep(ac: AudioContext, freq: number, start: number, dur: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const peak = 0.1; // low volume — a cue, not a klaxon
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.01);
  gain.gain.setValueAtTime(peak, Math.max(start + 0.01, start + dur - 0.03));
  gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur);
}

/**
 * Play the attention tone: blocked = a two-note rising chirp (660→880 Hz, 120 ms
 * each), done = a single 660 Hz note (150 ms). Generated via OscillatorNode — no
 * audio assets. If the context is suspended (no user gesture yet) we try to
 * resume; failure degrades to silence with one warn.
 */
export function playTone(kind: NotifKind): void {
  const ac = getAudioCtx();
  if (!ac) {
    if (!warnedAudio) {
      console.warn("[notify] Web Audio unavailable — tones silenced");
      warnedAudio = true;
    }
    return;
  }
  const go = () => {
    const t0 = ac.currentTime;
    if (kind === "blocked") {
      beep(ac, 660, t0, 0.12);
      beep(ac, 880, t0 + 0.13, 0.12);
    } else {
      beep(ac, 660, t0, 0.15);
    }
  };
  try {
    if (ac.state === "suspended") {
      void ac.resume().then(go).catch(() => {
        if (!warnedAudio) {
          console.warn("[notify] AudioContext resume blocked — tones silenced");
          warnedAudio = true;
        }
      });
    } else {
      go();
    }
  } catch {
    if (!warnedAudio) {
      console.warn("[notify] tone playback failed — silenced");
      warnedAudio = true;
    }
  }
}

/** Reset all module-level notifier state — test-only (permission/warn caches and
 * prefs leak across cases otherwise). */
export function __resetNotifyForTest(): void {
  permissionState = "unknown";
  permRequest = null;
  warnedPermission = false;
  warnedSend = false;
  warnedAudio = false;
  prefsCache = null;
}

// --- wiring ----------------------------------------------------------------

let started = false;

/**
 * Start the notifier for this window (idempotent). Seeds the current attention
 * baseline (no startup alerts), then subscribes to the store's attention event
 * bus and fires OS notifications + tones on rising edges (S11). Returns a
 * disposer (mainly for symmetry/tests — normally left running for the window's
 * lifetime).
 */
export function initNotify(): () => void {
  if (started) return () => {};
  started = true;

  const detector = createTransitionDetector({
    notify: (uuid, kind) => void fireOsNotification(uuid, kind),
    sound: (kind) => playTone(kind),
  });

  // Seed baselines from the current entries so pre-existing states don't alert.
  const seed: Record<string, AttentionSignals> = {};
  for (const [uuid, e] of Object.entries(useClaudeStatus.getState().entries)) {
    seed[uuid] = { blockedActive: e.status === "blocked", unseen: e.unseen };
  }
  detector.prime(seed);

  const unsub = onAttentionEvent((ev) => {
    detector.processEvent(ev, {
      watchedUuid: useClaudeStatus.getState().watchedUuid,
      focused: typeof document !== "undefined" ? document.hasFocus() : false,
      ...cachedPrefs(),
    });
  });

  return () => {
    unsub();
    started = false;
  };
}
