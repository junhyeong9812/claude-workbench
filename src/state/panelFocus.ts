// Ephemeral, per-dockview-panel memory of which sub-area last held focus.
//
// dockview runs in its default `onlyWhenVisible` renderer mode, so switching
// tabs UNMOUNTS the inactive panel's React tree and remounts it on return.
// That means a panel can't remember "where focus was" in its own state/ref —
// it would be wiped on every switch. This module-level map lives outside the
// React lifecycle (module scope survives remounts), keyed by the stable
// dockview panel id (`props.api.id`).
//
// Purely view-state and intentionally NOT persisted to disk: focus position is
// session-ephemeral and must never enter the saved layout.

export type PanelArea = "term" | "viewer" | "timeline";

const lastArea = new Map<string, PanelArea>();

/** Remember the sub-area that currently holds focus for this panel. */
export function rememberArea(panelId: string, area: PanelArea): void {
  lastArea.set(panelId, area);
}

/** The sub-area to restore for this panel (undefined if never focused yet). */
export function recallArea(panelId: string): PanelArea | undefined {
  return lastArea.get(panelId);
}

/** Drop a closed panel's entry so the map can't grow unbounded and a reused
 * panel id can't inherit a stale area. Called on real panel removal. */
export function forgetArea(panelId: string): void {
  lastArea.delete(panelId);
}
