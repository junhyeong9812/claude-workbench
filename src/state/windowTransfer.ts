import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { useAppStore } from "./store";
import { beginTransfer, endTransfer } from "./panelTransfer";

const KNOWN_COMPONENTS = new Set([
  "placeholder",
  "terminal",
  "ssh",
  "claudeterm",
  "editor",
  "diff",
]);

/** Spec needed to re-create a panel in another window with the SAME session. */
interface PanelSpec {
  id: string;
  component: string;
  title: string;
  params: Record<string, unknown>;
}

/** Source → target: re-create this panel (re-attaches via params.sessionId). */
export interface TransferEnvelope {
  transferId: string;
  targetLabel: string;
  project: string | null;
  panel: PanelSpec;
}

/** Panel ids whose transfer is in flight — a second trigger is ignored so the
 * same session can't be handed to two windows at once (review P2-impl #1). */
const inFlight = new Set<string>();
let seq = 0;

const READY_TIMEOUT_MS = 8000;
const ACCEPT_TIMEOUT_MS = 8000;

function panelSpecOf(panel: IDockviewPanel): { spec: PanelSpec; project: string | null } {
  const params = (panel.params ?? {}) as Record<string, unknown>;
  const kind = params.kind;
  const component = typeof kind === "string" && KNOWN_COMPONENTS.has(kind) ? kind : "placeholder";
  const project =
    (typeof params.project === "string" ? params.project : null) ??
    useAppStore.getState().activeProject;
  const title = typeof panel.title === "string" ? panel.title : component;
  return { spec: { id: panel.id, component, title, params }, project };
}

/**
 * Detach the source panel (session survives via the transfer guard) and hand it
 * to a window that is ALREADY listening. Waits for `transfer-result`; on reject
 * or timeout the panel is re-inserted into the source so it's never lost. The
 * source detaches before the target attaches, so the same session is never
 * rendered by two windows at once (structural single-owner).
 */
async function handOff(
  api: DockviewApi,
  panelId: string,
  spec: PanelSpec,
  project: string | null,
  targetLabel: string,
  transferId: string,
): Promise<void> {
  const reinsert = () => {
    if (api.getPanel(spec.id)) return;
    try {
      api.addPanel({ id: spec.id, component: spec.component, title: spec.title, params: spec.params });
    } catch (err) {
      console.error("[transfer] re-insert into source failed", err);
    }
  };

  // Fully register the accept/reject listener (AWAIT) BEFORE detaching/emitting,
  // else a fast target could ack before we're listening → missed ack → reinsert
  // a session the target already took (review P4-impl #1 / R4-2).
  let acked = false;
  let ackTimer: ReturnType<typeof setTimeout>;
  const un = await listen<{ transferId: string; ok: boolean }>("transfer-result", (re) => {
    if (acked || re.payload.transferId !== transferId) return;
    acked = true;
    un();
    clearTimeout(ackTimer);
    if (!re.payload.ok) reinsert();
    inFlight.delete(panelId);
  });
  ackTimer = setTimeout(() => {
    if (acked) return;
    acked = true;
    un();
    reinsert();
    inFlight.delete(panelId);
  }, ACCEPT_TIMEOUT_MS);

  // Detach the source panel (session survives via the guard), then VERIFY it
  // actually left before handing it off — if the close didn't take, abort
  // rather than risk the same session living in two windows (review R4-2).
  beginTransfer(panelId);
  api.getPanel(panelId)?.api.close();
  endTransfer(panelId);
  if (api.getPanel(panelId)) {
    console.error("[transfer] source panel did not close; aborting", panelId);
    acked = true;
    un();
    clearTimeout(ackTimer);
    inFlight.delete(panelId);
    return;
  }

  const envelope: TransferEnvelope = { transferId, targetLabel, project, panel: spec };
  void emit("panel-transfer", envelope);
}

/** True while any panel transfer from this window is awaiting its ack — used by
 * a popout to defer auto-closing an empty window until no move is in flight
 * (review R4-4). */
export function hasInFlight(): boolean {
  return inFlight.size > 0;
}

/** Dock a panel into an EXISTING window (no new window) — re-dock back to main
 * or into another popout (review P4). */
export function dockPanelToWindow(api: DockviewApi, panelId: string, targetLabel: string): void {
  if (inFlight.has(panelId)) return;
  const panel = api.getPanel(panelId);
  if (!panel) return;
  inFlight.add(panelId);
  const { spec, project } = panelSpecOf(panel);
  void handOff(api, panelId, spec, project, targetLabel, `t${seq++}:${panelId}`);
}

/** Move a panel into a BRAND-NEW popout window at `position`. Ready-handshake:
 * create window → await its `popout-ready` (same project) → handOff. On ready
 * timeout / window error the source panel is kept (no orphan). */
export async function movePanelToNewWindow(
  api: DockviewApi,
  panelId: string,
  position?: { x: number; y: number },
): Promise<void> {
  if (inFlight.has(panelId)) return;
  const panel = api.getPanel(panelId);
  if (!panel) return;
  inFlight.add(panelId);
  const { spec, project } = panelSpecOf(panel);
  const label = `panel-${Date.now()}`;
  const transferId = `${label}:${panelId}`;

  let settled = false;
  let readyTimer: ReturnType<typeof setTimeout>;
  // Register the ready listener (AWAIT) before creating the window so its ack
  // can't race ahead of us (review P4-impl #1).
  const un = await listen<{ label: string; project: string | null }>("popout-ready", (e) => {
    if (settled || e.payload.label !== label) return;
    settled = true;
    un();
    clearTimeout(readyTimer);
    if (e.payload.project !== project) {
      console.error("[transfer] new window on a different project; aborting", label);
      inFlight.delete(panelId);
      return;
    }
    void handOff(api, panelId, spec, project, label, transferId);
  });
  readyTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    un();
    console.error("[transfer] popout never signaled ready; keeping source panel", label);
    inFlight.delete(panelId);
  }, READY_TIMEOUT_MS);

  const w = new WebviewWindow(label, {
    url: `${window.location.pathname}#popout=${label}`,
    title: spec.title,
    width: 900,
    height: 640,
    ...(position ? { x: Math.round(position.x), y: Math.round(position.y) } : {}),
  });
  w.once("tauri://error", (e) => {
    if (settled) return;
    settled = true;
    un();
    clearTimeout(readyTimer);
    console.error("[transfer] popout window create failed", e);
    inFlight.delete(panelId);
  });
}

/** Logical-space bounds of every app window. */
async function appWindowBounds(): Promise<{ label: string; l: number; t: number; r: number; b: number }[]> {
  const wins = await getAllWindows();
  const out = [];
  for (const w of wins) {
    try {
      // Skip hidden/minimized windows — the user can't drop onto them, and they
      // shouldn't win the smallest-area tiebreak (review P4-impl #4).
      const [visible, minimized] = await Promise.all([w.isVisible(), w.isMinimized()]);
      if (!visible || minimized) continue;
      const [pos, size, scale] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
      out.push({
        label: w.label,
        l: pos.x / scale,
        t: pos.y / scale,
        r: (pos.x + size.width) / scale,
        b: (pos.y + size.height) / scale,
      });
    } catch {
      /* window gone mid-enumerate — skip */
    }
  }
  return out;
}

/** Label of the app window containing the screen point, or null (desktop). When
 * windows overlap, the SMALLEST-area match wins (most specific / likely topmost)
 * — `getAllWindows()` order isn't z-order, so we can't trust "first match"
 * (review R4-1). */
async function windowAtPoint(screenX: number, screenY: number): Promise<string | null> {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  const bounds = await appWindowBounds();
  let best: { label: string; area: number } | null = null;
  for (const b of bounds) {
    if (screenX >= b.l && screenX <= b.r && screenY >= b.t && screenY <= b.b) {
      const area = (b.r - b.l) * (b.b - b.t);
      if (!best || area < best.area) best = { label: b.label, area };
    }
  }
  return best?.label ?? null;
}

/**
 * Route a released tab by its drop point (review P4):
 *  - over THIS window → no-op (dockview rearranges natively),
 *  - over ANOTHER app window → dock into it (no new window),
 *  - over the desktop → new window at the drop point.
 */
export async function dropPanelAt(
  api: DockviewApi,
  panelId: string,
  point: { x: number; y: number },
): Promise<void> {
  const self = getCurrentWindow().label;
  const target = await windowAtPoint(point.x, point.y);
  if (target === self) return;
  if (target) dockPanelToWindow(api, panelId, target);
  else
    void movePanelToNewWindow(api, panelId, {
      x: Math.max(0, Math.round(point.x - 200)),
      y: Math.max(0, Math.round(point.y - 10)),
    });
}

/**
 * Wire the drop-out / dock gesture onto a dockview (shared by the main window
 * and popouts). On a tab drag, one AbortController bounds this gesture's
 * dragover/dragend listeners; the last credible screen point guards against a
 * degraded final `dragend` (review P3 #1/#3). Returns a disposable that tears
 * down the subscription and any live listeners.
 */
export function installDragOut(api: DockviewApi): { dispose: () => void } {
  let ac: AbortController | null = null;
  const sub = api.onWillDragPanel((e) => {
    const panelId = e.panel.id;
    ac?.abort();
    ac = new AbortController();
    const { signal } = ac;
    let last: { x: number; y: number } | null = null;
    window.addEventListener(
      "dragover",
      (ev: DragEvent) => {
        if (Number.isFinite(ev.screenX) && (ev.screenX !== 0 || ev.screenY !== 0)) {
          last = { x: ev.screenX, y: ev.screenY };
        }
      },
      { capture: true, signal },
    );
    window.addEventListener(
      "dragend",
      (ev: DragEvent) => {
        ac?.abort();
        const credible =
          Number.isFinite(ev.screenX) && (ev.screenX !== 0 || ev.screenY !== 0)
            ? { x: ev.screenX, y: ev.screenY }
            : last;
        if (credible) void dropPanelAt(api, panelId, credible);
      },
      { capture: true, signal },
    );
  });
  return {
    dispose: () => {
      ac?.abort();
      sub.dispose();
    },
  };
}
