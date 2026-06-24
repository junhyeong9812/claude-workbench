import type { KeyboardEvent } from "react";

export interface ScrollKeyOpts {
  /** Whether Home/End jump to top/bottom. Off by default so call sites that don't
   * want them (the change-detail pane) keep letting those keys bubble. */
  homeEnd?: boolean;
  /** Pixels per Arrow press. */
  arrowStep?: number;
  /** Fraction of the viewport per Page press. */
  pageFactor?: number;
}

/**
 * Vertical scroll for ↑/↓/PageUp/PageDown(/Home/End) on a scroll container.
 * Returns `true` (and calls `preventDefault`) when it consumes the key; returns
 * `false` and does nothing when `scroller` is null or the key isn't a handled
 * scroll key. Shared by the change-detail pane (ClaudeTermPanel) and the file
 * peek viewer — invoke it as the LAST branch of an onKeyDown handler, after the
 * caller's own keys (v / Enter / Esc / Ctrl+arrows), which never overlap these.
 */
export function handleScrollKey(
  e: KeyboardEvent,
  scroller: HTMLElement | null,
  { homeEnd = false, arrowStep = 48, pageFactor = 0.9 }: ScrollKeyOpts = {},
): boolean {
  if (!scroller) return false;
  const page = scroller.clientHeight * pageFactor;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      scroller.scrollTop += arrowStep;
      return true;
    case "ArrowUp":
      e.preventDefault();
      scroller.scrollTop -= arrowStep;
      return true;
    case "PageDown":
      e.preventDefault();
      scroller.scrollTop += page;
      return true;
    case "PageUp":
      e.preventDefault();
      scroller.scrollTop -= page;
      return true;
    case "Home":
      if (!homeEnd) return false;
      e.preventDefault();
      scroller.scrollTop = 0;
      return true;
    case "End":
      if (!homeEnd) return false;
      e.preventDefault();
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    default:
      return false;
  }
}
