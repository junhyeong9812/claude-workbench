import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import type { DockviewApi } from "dockview-react";
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

/** Panel ids whose transfer is in flight — a second trigger (e.g. a double
 * click) is ignored so the same session can't be handed to two windows at once
 * (review P2-impl #1). */
const inFlight = new Set<string>();

const READY_TIMEOUT_MS = 8000;
const ACCEPT_TIMEOUT_MS = 8000;

/**
 * Move a dockview panel from `api` into a brand-new popout window, keeping its
 * backend session alive. Robust handshake:
 *   1. arm `popout-ready` listener → create window.
 *   2. on ready: verify the target is on the SAME project (review P2-impl #2);
 *      else abort, keeping the source panel.
 *   3. detach the source panel (session survives via the transfer guard) and
 *      emit `panel-transfer`.
 *   4. wait for `transfer-accepted`; on `transfer-rejected` or timeout, re-insert
 *      the panel into the source so it's never lost (review P2-impl #3).
 *
 * Single-owner is structural: the source detaches BEFORE the target attaches, so
 * the same session is never rendered by two windows at once.
 */
export async function movePanelToNewWindow(api: DockviewApi, panelId: string): Promise<void> {
  if (inFlight.has(panelId)) return;
  const panel = api.getPanel(panelId);
  if (!panel) return;
  inFlight.add(panelId);

  const params = (panel.params ?? {}) as Record<string, unknown>;
  const kind = params.kind;
  const component = typeof kind === "string" && KNOWN_COMPONENTS.has(kind) ? kind : "placeholder";
  const project =
    (typeof params.project === "string" ? params.project : null) ??
    useAppStore.getState().activeProject;
  const title = typeof panel.title === "string" ? panel.title : component;
  const spec: PanelSpec = { id: panel.id, component, title, params };

  const label = `panel-${Date.now()}`;
  const transferId = `${label}:${panelId}`;

  let settled = false; // ready phase settled
  const done = () => inFlight.delete(panelId);

  const unreadyP = listen<{ label: string; project: string | null }>("popout-ready", (e) => {
    if (settled || e.payload.label !== label) return;
    settled = true;
    void unreadyP.then((un) => un());
    clearTimeout(readyTimer);

    // The target must be on the same project, else its dockview (keyed by
    // project) would attach our panel under the wrong layout (review P2-impl #2).
    if (e.payload.project !== project) {
      console.error("[transfer] target on a different project; aborting", label);
      done();
      return;
    }

    // Detach the source panel (session survives via the transfer guard).
    beginTransfer(panelId);
    panel.api.close();
    endTransfer(panelId);

    // Hand the spec to the target and wait for its accept/reject so a failed
    // add can be recovered (review P2-impl #3).
    let acked = false;
    const unackP = listen<{ transferId: string; ok: boolean }>("transfer-result", (re) => {
      if (acked || re.payload.transferId !== transferId) return;
      acked = true;
      void unackP.then((un) => un());
      clearTimeout(ackTimer);
      if (!re.payload.ok) reinsert();
      done();
    });
    const ackTimer = setTimeout(() => {
      if (acked) return;
      acked = true;
      void unackP.then((un) => un());
      reinsert();
      done();
    }, ACCEPT_TIMEOUT_MS);

    const envelope: TransferEnvelope = { transferId, targetLabel: label, project, panel: spec };
    void emit("panel-transfer", envelope);
  });

  const readyTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    void unreadyP.then((un) => un());
    console.error("[transfer] popout never signaled ready; keeping source panel", label);
    done();
  }, READY_TIMEOUT_MS);

  // Re-insert the (still-alive) session into the source dock if the target
  // couldn't take it — the panel is never lost.
  const reinsert = () => {
    if (api.getPanel(spec.id)) return; // already present somehow
    try {
      api.addPanel({ id: spec.id, component: spec.component, title: spec.title, params: spec.params });
    } catch (err) {
      console.error("[transfer] re-insert into source failed", err);
    }
  };

  const w = new WebviewWindow(label, {
    url: `${window.location.pathname}#popout=${label}`,
    title,
    width: 900,
    height: 640,
  });
  w.once("tauri://error", (e) => {
    if (settled) return;
    settled = true;
    void unreadyP.then((un) => un());
    clearTimeout(readyTimer);
    console.error("[transfer] popout window create failed", e);
    done();
  });
}
