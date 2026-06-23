import { useDropTargetHighlight } from "../state/dropIndicator";

/**
 * Full-window highlight shown while a tab from another window is dragged over
 * this one (multiwindow backlog ①). Docking always lands the panel as a tab in
 * the active group, so a window-level highlight is the right granularity — it
 * answers "which window receives this drop". Click-through (pointer-events:none)
 * so it never interferes with the drag.
 */
export function DropTargetOverlay() {
  const active = useDropTargetHighlight();
  if (!active) return null;
  return (
    <div className="drop-target-overlay">
      <div className="drop-target-overlay-label">여기로 도킹</div>
    </div>
  );
}
