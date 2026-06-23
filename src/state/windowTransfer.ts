import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows, getCurrentWindow, cursorPosition } from "@tauri-apps/api/window";
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

// ---- z-order via focus recency (review backlog ②) ----
// Linux/WebKitGTK exposes no cross-window z-order query, and `getAllWindows()`
// order isn't a stack. We approximate "topmost" with focus recency: every window
// broadcasts when it gains focus, and each window keeps a shared most-recent-first
// list. Among windows overlapping a drop point, the most-recently-focused wins
// (focus≈raise) — strictly better than the old smallest-area guess.
const focusOrder: string[] = [];
let focusTrackingStarted = false;

/** Move `label` to the front (most-recent) of the focus-recency list. */
function bumpFocus(label: string): void {
  const i = focusOrder.indexOf(label);
  if (i !== -1) focusOrder.splice(i, 1);
  focusOrder.unshift(label);
}

/** focus-recency rank: 0 = most recent (topmost); Infinity = never seen. */
function focusRank(label: string): number {
  const i = focusOrder.indexOf(label);
  return i === -1 ? Infinity : i;
}

/** Idempotent per-window: subscribe to the shared focus broadcast and announce
 * our own focus. A window's own `tauri://focus` isn't visible to other windows,
 * so each window relays its focus through a global event the others listen to.
 * Pure state update on receive (no re-emit) → no echo loop. */
function ensureFocusTracking(): void {
  if (focusTrackingStarted) return;
  focusTrackingStarted = true;
  const self = getCurrentWindow();
  void listen<{ label: string }>("mt://window-focused", (e) => bumpFocus(e.payload.label));
  void self.onFocusChanged(({ payload: focused }) => {
    if (focused) void emit("mt://window-focused", { label: self.label });
  });
  // Seed: if we're focused right now, we're topmost (a focus event may not fire
  // until the next focus change). Best-effort — degrades to area tiebreak.
  void self
    .isFocused()
    .then((focused) => {
      if (focused) {
        bumpFocus(self.label);
        void emit("mt://window-focused", { label: self.label });
      }
    })
    .catch(() => {});
}

/** Physical-pixel bounds of every app window. Everything in the hit-test runs in
 * one physical-pixel space so asymmetric multi-monitor scale (one display at 1.0,
 * another at 2.0) can't desync the comparison — per-window logical px don't share
 * a global frame (review backlog ③). */
async function appWindowBounds(): Promise<{ label: string; l: number; t: number; r: number; b: number }[]> {
  const wins = await getAllWindows();
  const out = [];
  for (const w of wins) {
    try {
      // Skip hidden/minimized windows — the user can't drop onto them, and they
      // shouldn't win the overlap tiebreak (review P4-impl #4).
      const [visible, minimized] = await Promise.all([w.isVisible(), w.isMinimized()]);
      if (!visible || minimized) continue;
      const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
      out.push({
        label: w.label,
        l: pos.x,
        t: pos.y,
        r: pos.x + size.width,
        b: pos.y + size.height,
      });
    } catch {
      /* window gone mid-enumerate — skip */
    }
  }
  return out;
}

type WinBounds = { label: string; l: number; t: number; r: number; b: number };

/** Pure pick: label of the window containing the PHYSICAL point over a known
 * bounds set, or null (desktop). When windows overlap, the most-recently-focused
 * match wins (topmost ≈ last focused); smallest area breaks an equal-rank tie
 * (review backlog ②/③). Sync so the drag preview can reuse a cached snapshot
 * without per-move IPC (review backlog ①). */
function pickWindow(bounds: WinBounds[], physX: number, physY: number): string | null {
  if (!Number.isFinite(physX) || !Number.isFinite(physY)) return null;
  let best: { label: string; rank: number; area: number } | null = null;
  for (const b of bounds) {
    if (physX >= b.l && physX <= b.r && physY >= b.t && physY <= b.b) {
      const rank = focusRank(b.label);
      const area = (b.r - b.l) * (b.b - b.t);
      if (!best || rank < best.rank || (rank === best.rank && area < best.area)) {
        best = { label: b.label, rank, area };
      }
    }
  }
  return best?.label ?? null;
}

/** Label of the app window containing the PHYSICAL-pixel point, or null (desktop). */
async function windowAtPoint(physX: number, physY: number): Promise<string | null> {
  if (!Number.isFinite(physX) || !Number.isFinite(physY)) return null;
  try {
    return pickWindow(await appWindowBounds(), physX, physY);
  } catch (err) {
    // Enumeration failed (e.g. a missing window permission) — fall back to
    // "desktop" so a drop-out still pops a new window rather than no-op.
    console.error("[transfer] windowAtPoint failed; treating as desktop", err);
    return null;
  }
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
  phys: { x: number; y: number },
): Promise<void> {
  const self = getCurrentWindow();
  // `phys` is a PHYSICAL-pixel global point (from `cursorPosition()` — accurate
  // across mixed-scale monitors, unlike a CSS-px screenX scaled by the source DPR
  // which mis-projects onto another monitor; review backlog ③ / codex P1-#1).
  const target = await windowAtPoint(phys.x, phys.y);
  if (target === self.label) return;
  if (target) {
    dockPanelToWindow(api, panelId, target);
    return;
  }
  // New window: WebviewWindow x/y are logical px. Convert the physical drop point
  // with the source window's scale — identical to the old logical screen point on
  // a single 1.0 monitor (no regression); slight offset near a mixed-scale edge is
  // cosmetic (placement only, not routing).
  let scale = 1;
  try {
    scale = await self.scaleFactor();
  } catch {
    /* default 1 — logical == physical */
  }
  void movePanelToNewWindow(api, panelId, {
    x: Math.max(0, Math.round(phys.x / scale - 200)),
    y: Math.max(0, Math.round(phys.y / scale - 10)),
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
  ensureFocusTracking();
  let ac: AbortController | null = null;
  const sub = api.onWillDragPanel((e) => {
    const panelId = e.panel.id;
    ac?.abort();
    ac = new AbortController();
    const { signal } = ac;
    const selfLabel = getCurrentWindow().label;
    let last: { x: number; y: number } | null = null;
    // Snapshot window bounds + source DPR once at drag start so the live preview
    // can pick the hovered window each move WITHOUT per-move IPC — windows don't
    // move during a tab drag (review backlog ①).
    let snapBounds: WinBounds[] | null = null;
    let snapScale = 1;
    let lastTarget: string | null | undefined = undefined;
    void appWindowBounds()
      .then((b) => (snapBounds = b))
      .catch(() => {});
    void getCurrentWindow()
      .scaleFactor()
      .then((s) => (snapScale = s))
      .catch(() => {});
    window.addEventListener(
      "dragover",
      (ev: DragEvent) => {
        if (Number.isFinite(ev.screenX) && (ev.screenX !== 0 || ev.screenY !== 0)) {
          last = { x: ev.screenX, y: ev.screenY };
        }
        // Drive the target window's drop indicator (review backlog ①). Preview
        // uses the cheap screenX*DPR estimate; the actual drop still routes via
        // the precise cursorPosition() at dragend.
        if (!snapBounds || !last) return;
        const target = pickWindow(snapBounds, last.x * snapScale, last.y * snapScale);
        if (target !== lastTarget) {
          lastTarget = target;
          void emit("mt://drop-target", { source: selfLabel, target });
        }
      },
      { capture: true, signal },
    );
    window.addEventListener(
      "dragend",
      (ev: DragEvent) => {
        ac?.abort();
        void emit("mt://drop-end", { source: selfLabel });
        void (async () => {
          // Prefer the OS global cursor (physical px) — accurate across mixed-scale
          // monitors. Fall back to the last credible CSS screen point, scaled to
          // physical by the source DPR, if the query fails (review backlog ③).
          try {
            const p = await cursorPosition();
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
              await dropPanelAt(api, panelId, { x: p.x, y: p.y });
              return;
            }
          } catch {
            /* fall through to the screen-point fallback */
          }
          const credible =
            Number.isFinite(ev.screenX) && (ev.screenX !== 0 || ev.screenY !== 0)
              ? { x: ev.screenX, y: ev.screenY }
              : last;
          if (!credible) return;
          let scale = 1;
          try {
            scale = await getCurrentWindow().scaleFactor();
          } catch {
            /* default 1 */
          }
          await dropPanelAt(api, panelId, { x: credible.x * scale, y: credible.y * scale });
        })();
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
