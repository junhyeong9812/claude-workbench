import { emit, listen } from "@tauri-apps/api/event";
import type { DockviewApi } from "dockview-react";
import { useAppStore } from "./store";
import type { TransferEnvelope } from "./windowTransfer";

/**
 * Listen for panels transferred INTO this window and re-create them with the
 * same backend session (re-attach via params.sessionId). Shared by the main
 * window and popout windows so docking works in every direction (review P4).
 *
 * Validates the project — our dockview is keyed by the active project, so a
 * mismatch would attach the panel under the wrong layout — and acks accept or
 * reject via `transfer-result` so the source can recover a failed add instead
 * of losing the panel (review P2-impl #3). `processed` de-dups late delivery;
 * only successful adds are marked so a reject can be retried by the source.
 * `getApi` is read per-event because the dockview api changes across the
 * project-keyed remount.
 */
export function installTransferTarget(
  label: string,
  getApi: () => DockviewApi | null,
  processed: Set<string>,
): Promise<() => void> {
  return listen<TransferEnvelope>("panel-transfer", (e) => {
    const env = e.payload;
    if (env.targetLabel !== label) return; // addressed to another window
    if (processed.has(env.transferId)) return; // de-dup
    const api = getApi();
    const sameProject = env.project === useAppStore.getState().activeProject;
    let ok = false;
    if (api && sameProject) {
      try {
        api.addPanel({
          id: env.panel.id,
          component: env.panel.component,
          title: env.panel.title,
          params: env.panel.params,
        });
        ok = true;
      } catch (err) {
        console.error("[transfer-target] addPanel failed", err);
      }
    }
    if (ok) processed.add(env.transferId);
    void emit("transfer-result", { transferId: env.transferId, ok });
  });
}
