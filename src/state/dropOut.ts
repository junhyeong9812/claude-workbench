import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * True if the screen point (CSS/logical px, e.g. a drag event's `screenX/Y`)
 * lies outside this window's outer bounds — i.e. the tab was released onto the
 * desktop / another monitor, which we turn into a popout (WebKitGTK has no OS
 * drag-out; spike Q4).
 *
 * The comparison is done in LOGICAL pixels: `outerPosition`/`outerSize` are
 * physical px, so they're divided by this window's `scaleFactor` to match the
 * logical `screenX/Y`. Comparing in logical space (rather than scaling the point
 * up to physical) avoids misclassifying a release on another monitor with a
 * different scale (review P3 #2). Non-finite coordinates are treated as inside
 * so a degraded `dragend` can't cause an accidental popout (review P3 #3).
 */
export async function isOutsideCurrentWindow(screenX: number, screenY: number): Promise<boolean> {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return false;
  try {
    const w = getCurrentWindow();
    const [pos, size, scale] = await Promise.all([
      w.outerPosition(),
      w.outerSize(),
      w.scaleFactor(),
    ]);
    const left = pos.x / scale;
    const top = pos.y / scale;
    const right = (pos.x + size.width) / scale;
    const bottom = (pos.y + size.height) / scale;
    return screenX < left || screenX > right || screenY < top || screenY > bottom;
  } catch {
    return false; // can't decide -> treat as inside (no accidental popout)
  }
}
