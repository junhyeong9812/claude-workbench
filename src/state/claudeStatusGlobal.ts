import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useClaudeStatus,
  deriveSessionActivity,
  hasOpenQuestion,
  lookupSessionUuid,
} from "./claudeStatus";
import type { TimelineItem } from "../components/TimelineView";

/**
 * App-level attention-status listener (agent-status-badges P3).
 *
 * dockview runs panels `onlyWhenVisible`, so a **backgrounded** Claude tab's
 * `ClaudeTermPanel` is unmounted — its own `claude-timeline` listener is gone and
 * its badge would freeze. This module holds one process-wide listener per window
 * so every session's status keeps updating whether or not its panel is mounted:
 *
 *  - `claude-timeline` → reverse-map the numeric id to a uuid (registry) and, for
 *    sessions **not** currently attached to a live panel, derive their status.
 *    An attached session is skipped here — its mounted panel already updates it
 *    with the accurate `seenNow` (active + focused), which this listener can't
 *    know, so letting the panel own it avoids a double update / a wrong seen flag.
 *  - `claude-session-closed` → a session that died while its panel was unmounted
 *    (background tab) would otherwise never be dropped; remove it here too. (A
 *    mounted panel also handles this; `remove` is idempotent.)
 *
 * Initialization is guarded to once per window (module scope = one webview), so
 * calling it from more than one mount point (main window + popout) is safe.
 */

/** Minimal shape read off the `claude-timeline` payload (mirror of the panel's
 * `ClaudeTimelineEvent`, kept local so this module doesn't import the component). */
interface TimelinePayload {
  id: number;
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
}

let started = false;
/** Set by the disposer so a `listen()` promise that resolves *after* teardown
 * immediately unlistens instead of leaking (S3 async race). */
let disposed = false;
let unlisteners: UnlistenFn[] = [];

/** Track a pending `listen()` registration: push its unlistener when it lands,
 * or unlisten at once if we were already disposed. A rejected registration
 * warns and reopens `started` so a later init can retry (S3). */
function track(p: Promise<UnlistenFn>): void {
  p.then((un) => {
    if (disposed) un();
    else unlisteners.push(un);
  }).catch((err) => {
    console.warn("[claudeStatusGlobal] listener registration failed — will retry on next init", err);
    started = false;
  });
}

/** Start the window-global attention listener (idempotent). Returns a disposer
 * that tears it down (mainly for symmetry / tests — normally left running for
 * the window's lifetime). */
export function initClaudeStatusGlobal(): () => void {
  if (started) return disposeClaudeStatusGlobal;
  started = true;
  disposed = false;

  track(
    listen<TimelinePayload>("claude-timeline", (e) => {
      const uuid = lookupSessionUuid(e.payload.id);
      if (!uuid) return; // an id we never registered (another window's session)
      // A mounted panel owns its own (accurate-seenNow) update — don't clobber it.
      if (useClaudeStatus.getState().attached[uuid]) return;
      useClaudeStatus.getState().updateFromTimeline(uuid, {
        activity: deriveSessionActivity(e.payload.turns, e.payload.answers, e.payload.items),
        questionBlocked: hasOpenQuestion(e.payload.items),
        // The panel is unmounted, so by definition the user isn't looking at it.
        seenNow: false,
        // A backgrounded session's live JSONL edge — alert normally.
        origin: "live",
      });
    }),
  );

  track(
    listen<number>("claude-session-closed", (e) => {
      const uuid = lookupSessionUuid(e.payload);
      if (uuid) useClaudeStatus.getState().remove(uuid);
    }),
  );

  return disposeClaudeStatusGlobal;
}

function disposeClaudeStatusGlobal() {
  disposed = true;
  for (const un of unlisteners) un();
  unlisteners = [];
  started = false;
}
