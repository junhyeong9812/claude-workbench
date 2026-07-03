// Pure routing helpers for the main-area layer swap (통합↔개발 z-스왑, P1).
//
// The integrated (MainArea) and dev (DevView) views are BOTH mounted and
// swapped by z-index/visibility rather than conditionally rendered, so store
// requests (editorOpen…) could reach two live consumers at once. These helpers
// decide, from a project's mode alone, exactly one consumer per request (XOR)
// and whether the dev layer stays mounted. Kept side-effect-free so the
// invariants (③ single-consumer, ④ never-dev = no mount, ② state preserved) are
// unit-testable without mounting React.

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

/** The integrated (MainArea) layer consumes editorOpen only when it is in
 * front. Exactly one of this / `devConsumesEditorOpen` is true for any mode. */
export function integratedConsumesEditorOpen(mode: MainLayerMode): boolean {
  return mode === "integrated";
}

/** The dev (DevView) layer consumes editorOpen only when it is in front. */
export function devConsumesEditorOpen(mode: MainLayerMode): boolean {
  return mode === "dev";
}

/** Mount latch for the dev layer: mount while in dev mode, and KEEP it mounted
 * after returning to integrated within the same run (`visited`), so toggling
 * back and forth preserves the dev session's state (② PTY/scrollback/tabs)
 * without ever mounting for a project that never entered dev (④). */
export function devLayerMounted(mode: MainLayerMode, visited: boolean): boolean {
  return mode === "dev" || visited;
}
