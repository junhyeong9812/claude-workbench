// Pure routing helpers for the main-area layer swap (통합↔개발 z-스왑, P1).
//
// The integrated (MainArea) and dev (DevView) views are BOTH mounted and
// swapped by z-index/visibility rather than conditionally rendered, so store
// requests could reach two live consumers at once. These helpers decide, from a
// project's mode alone, exactly one consumer per request (XOR) and whether the
// dev layer stays mounted. Kept side-effect-free so the invariants (③
// single-consumer, ④ never-dev = no mount, ② state preserved) are unit-testable
// without mounting React.
//
// Two request classes route differently (kept explicit so callers don't confuse
// them):
//   - VIEW-ROW requests (front-layer routing): editorOpen·diff·claudeOpen·run —
//     they render into whichever layer is IN FRONT, so only the front layer
//     consumes them (`integratedIsFront`/`devIsFront`). A request that arrives
//     for the hidden layer is left in the store (유실≠소비) or triggers a
//     symmetric flip (`shouldFlipToIntegrated`).
//   - SESSION-ROW requests (project routing): devReview (✓확인/🧪) — they target a
//     specific project's dev session, which the DevView owns whether it is front
//     or hidden. So devReview is NOT front-gated; the project's DevView consumes
//     it (queued) regardless of the visible layer.

export type MainLayerMode = "integrated" | "dev";

/** Which layer is in front for `activeProject`. Absent from the (sparse) map —
 * or no active project — means the default integrated mode. */
export function resolveLayerMode(
  projectModes: Record<string, "integrated" | "dev">,
  activeProject: string | null,
): MainLayerMode {
  if (!activeProject) return "integrated";
  return projectModes[activeProject] === "dev" ? "dev" : "integrated";
}

/** True when the integrated (MainArea) layer is the front layer — the single
 * authority for consuming view-row requests. Exactly one of this / `devIsFront`
 * is true for any mode. */
export function integratedIsFront(mode: MainLayerMode): boolean {
  return mode === "integrated";
}

/** True when the dev (DevView) layer is the front layer — the single authority
 * for consuming view-row requests while dev is shown. */
export function devIsFront(mode: MainLayerMode): boolean {
  return mode === "dev";
}

/** Mount latch for the dev layer: mount while in dev mode, and KEEP it mounted
 * after returning to integrated within the same active-project period
 * (`visited`), so toggling back and forth preserves the dev session's state (②
 * PTY/scrollback/tabs) without ever mounting for a project that never entered
 * dev (④).
 *
 * The `visited` latch is per-run, in-memory, and NON-persistent, and it is reset
 * whenever the active project changes (DevView is keyed by project, so its state
 * is dropped on a project switch anyway). It does NOT govern restart behavior: a
 * persisted `projectModes[p] === "dev"` still mounts on restart via the
 * `mode === "dev"` branch here — that is the intentional dev-session resume, not
 * a latch effect. */
export function devLayerMounted(mode: MainLayerMode, visited: boolean): boolean {
  return mode === "dev" || visited;
}

/** How the dev layer delivers a devReview (✓확인/🧪) prompt, from the dev dock's
 * state alone:
 *   - "pending": the dock isn't ready yet (fresh mount from the ✓확인 flip) — leave
 *     the request in the queue; onReady seeds the new session with it (no loss, #6).
 *   - "inject": the dev session panel is live — inject the prompt (uuid-matched).
 *   - "seed": the dock is ready but the panel is gone (user closed the session) —
 *     re-open it carrying the prompt as its one-shot seed.
 * A prompt reaches the session by exactly one channel — never injected into a
 * not-yet-live panel (F4 seed race) and never dropped. */
export type DevReviewRoute = "pending" | "inject" | "seed";
export function routeDevReview(dockReady: boolean, panelPresent: boolean): DevReviewRoute {
  if (!dockReady) return "pending";
  return panelPresent ? "inject" : "seed";
}

/** Symmetric auto-flip (B4): when the dev layer is in FRONT and a VIEW-ROW request
 * (diff·claudeOpen·run) arrives for the active project, flip that project back to
 * integrated so the front-gated integrated consumer can immediately render it —
 * otherwise the panel would open behind the dev layer (invisible). A request for
 * a DIFFERENT project must NOT flip the active project's layer (it stays pending
 * for that project's own consumer), and in integrated mode there is nothing to
 * flip. `requestProject` is the request's project basis (diff uses its `cwd`). */
export function shouldFlipToIntegrated(
  mode: MainLayerMode,
  requestProject: string | null | undefined,
  activeProject: string | null,
): boolean {
  return mode === "dev" && requestProject != null && requestProject === activeProject;
}
