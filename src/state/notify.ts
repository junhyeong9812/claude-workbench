import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useClaudeStatus, attentionOf, type SessionStatus } from "./claudeStatus";

/**
 * Attention notifications + tones (agent-status-badges P4).
 *
 * Best-effort side channel layered on top of the P1 store: it subscribes to the
 * status store and, on the **rising edge** of a session into an attention state
 * (→ blocked or → done-unseen), fires an OS notification and a Web Audio tone.
 * Everything here is fire-and-forget: a denied permission, a rejected
 * `sendNotification`, or an unavailable `AudioContext` degrades to silence with a
 * single `console.warn` and never throws (invariant ⑥) — the badge, which lives
 * in the store, keeps working regardless.
 *
 * Edge semantics (invariant ③, N8/N9): notifications fire only on a transition
 * *into* an attention level, once per transition. Because `markSeen` drops the
 * badge (unseen→false) and a resolved block clears `blocked`, a later re-entry is
 * a fresh rising edge and alerts again — the "once" is per edge, not per session.
 *
 * Suppression (N4): a session the user is actively watching — its panel active
 * AND the window focused (`watchedUuid` === uuid && document.hasFocus()) — is
 * silenced. done-unseen already can't arise while watching (the store only sets
 * unseen when the panel wasn't seen at completion); this also silences a `blocked`
 * that pops up on the panel you're looking at.
 */

export type NotifKind = "blocked" | "done";

/** Attention level = the store's `attentionOf` result (3 blocked, 2 done-unseen,
 * 1 working, 0 idle). Aliased for readability in the pure edge logic. */
type Attention = 0 | 1 | 2 | 3;

export interface NotifPrefs {
  notifEnabled: boolean;
  soundEnabled: boolean;
}

/** Read the user's alert/sound toggles from localStorage (TerminalSettings writes
 * them). Both default ON — the key is absent until the user opts out, so only an
 * explicit "0" disables. Independent axes (N5/N6): alerts and sound gate
 * separately. */
export function readNotifPrefs(): NotifPrefs {
  return {
    notifEnabled: localStorage.getItem("notifyEnabled") !== "0",
    soundEnabled: localStorage.getItem("soundEnabled") !== "0",
  };
}

export function setNotifEnabled(on: boolean): void {
  localStorage.setItem("notifyEnabled", on ? "1" : "0");
}
export function setSoundEnabled(on: boolean): void {
  localStorage.setItem("soundEnabled", on ? "1" : "0");
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
 * Pure decision for one attention transition. `notify`/`sound` are true only on a
 * rising edge into an attention level, when not watching, and when the respective
 * toggle is on. The three axes — badge (store, not here), OS alert, sound — are
 * independent: `notifEnabled`/`soundEnabled` gate their own output only (N5/N6).
 */
export function shouldNotify(
  prev: Attention,
  next: Attention,
  opts: { watching: boolean; notifEnabled: boolean; soundEnabled: boolean },
): NotifDecision {
  const roseToBlocked = next === 3 && prev !== 3;
  const roseToDone = next === 2 && prev !== 2;
  if (!roseToBlocked && !roseToDone) return { notify: false, sound: false, kind: null };
  const kind: NotifKind = roseToBlocked ? "blocked" : "done";
  if (opts.watching) return { notify: false, sound: false, kind };
  return { notify: opts.notifEnabled, sound: opts.soundEnabled, kind };
}

/** Where a fired notification/tone is delivered — injected so the edge detector
 * is unit-testable without touching the OS or Web Audio. */
export interface NotifySinks {
  notify: (uuid: string, kind: NotifKind) => void;
  sound: (kind: NotifKind) => void;
}

/** Everything the detector needs about "now" beyond the entries themselves. */
export interface NotifyContext {
  watchedUuid: string | null;
  focused: boolean;
  notifEnabled: boolean;
  soundEnabled: boolean;
}

type EntryView = { status: SessionStatus; unseen: boolean };

/**
 * Rising-edge detector over successive `entries` snapshots. Holds the previous
 * attention level per uuid and, on each `process`, fires the sinks for any
 * session that crossed into an attention state. `prime` seeds the baseline
 * without firing (so pre-existing states at startup don't alert). Extracted from
 * the store subscription so the once-per-edge / re-entry / suppression rules are
 * unit-testable with plain snapshots.
 */
export function createTransitionDetector(sinks: NotifySinks) {
  const prevAttention = new Map<string, Attention>();

  const attOf = (uuid: string): Attention => prevAttention.get(uuid) ?? 0;

  return {
    /** Record current attention for every entry without firing (startup seed). */
    prime(entries: Record<string, EntryView>) {
      for (const [uuid, e] of Object.entries(entries)) {
        prevAttention.set(uuid, attentionOf(e.status, e.unseen));
      }
    },
    /** Diff `entries` against the last snapshot and fire sinks on rising edges. */
    process(entries: Record<string, EntryView>, ctx: NotifyContext) {
      for (const [uuid, e] of Object.entries(entries)) {
        const next = attentionOf(e.status, e.unseen);
        const prev = attOf(uuid);
        prevAttention.set(uuid, next);
        if (next === prev) continue;
        const watching = ctx.watchedUuid === uuid && ctx.focused;
        const d = shouldNotify(prev, next, {
          watching,
          notifEnabled: ctx.notifEnabled,
          soundEnabled: ctx.soundEnabled,
        });
        if (d.kind == null) continue;
        if (d.notify) sinks.notify(uuid, d.kind);
        if (d.sound) sinks.sound(d.kind);
      }
      // Forget sessions that are gone so a reused uuid starts fresh.
      for (const uuid of [...prevAttention.keys()]) {
        if (!(uuid in entries)) prevAttention.delete(uuid);
      }
    },
  };
}

// --- OS notification (best-effort) -----------------------------------------

let warnedPermission = false;
let warnedSend = false;

/** Copy for each transition (Korean, matching the app's hardcoded UI language). */
function bodyFor(uuid: string, kind: NotifKind): { title: string; body: string } {
  const short = uuid.slice(0, 8);
  return kind === "blocked"
    ? { title: "Claude — 입력 대기 중", body: `세션 ${short}이(가) 응답을 기다립니다` }
    : { title: "Claude — 작업 완료", body: `세션 ${short}의 작업이 끝났습니다` };
}

/**
 * Send an OS notification, requesting permission on first use. Never throws:
 * denied permission or a rejected `sendNotification` degrades to silence with a
 * single `console.warn` (invariant ⑥, N7). Awaitable for tests.
 */
export async function fireOsNotification(uuid: string, kind: NotifKind): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) {
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

// --- wiring ----------------------------------------------------------------

let started = false;

/**
 * Start the notifier for this window (idempotent). Seeds the current attention
 * baseline (no startup alerts), then subscribes to the store and fires OS
 * notifications + tones on attention rising edges. Returns a disposer (mainly for
 * symmetry/tests — normally left running for the window's lifetime).
 */
export function initNotify(): () => void {
  if (started) return () => {};
  started = true;

  const detector = createTransitionDetector({
    notify: (uuid, kind) => void fireOsNotification(uuid, kind),
    sound: (kind) => playTone(kind),
  });
  detector.prime(useClaudeStatus.getState().entries);

  const unsub = useClaudeStatus.subscribe((state) => {
    detector.process(state.entries, {
      watchedUuid: state.watchedUuid,
      focused: typeof document !== "undefined" ? document.hasFocus() : false,
      ...readNotifPrefs(),
    });
  });

  return () => {
    unsub();
    started = false;
  };
}
