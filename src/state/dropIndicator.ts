import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

/**
 * True while a tab is being dragged from ANOTHER window over THIS one — drives a
 * drop-target highlight so the user can see which window will receive the panel
 * (multiwindow backlog ①). The source window drives this over `mt://drop-target`
 * / `mt://drop-end` because a popped-out window can't see the HTML5 drag itself
 * (it never crosses the webview boundary).
 *
 * Use in exactly ONE place per window (the workbench root) so a single pair of
 * listeners feeds the overlay.
 */
export function useDropTargetHighlight(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const me = getCurrentWindow().label;
    // If a listen() promise resolves AFTER cleanup (fast unmount/remount, e.g.
    // StrictMode's double-mount), unlisten immediately so we never leak a stale
    // subscription (codex P3).
    let disposed = false;
    let unT: (() => void) | undefined;
    let unE: (() => void) | undefined;
    listen<{ source: string; target: string | null }>("mt://drop-target", (e) => {
      // Never highlight the source window itself (dropping onto it just rearranges
      // natively); only light up a genuine cross-window target.
      setActive(e.payload.target === me && e.payload.source !== me);
    })
      .then((f) => (disposed ? f() : (unT = f)))
      .catch(() => {});
    listen("mt://drop-end", () => setActive(false))
      .then((f) => (disposed ? f() : (unE = f)))
      .catch(() => {});
    return () => {
      disposed = true;
      unT?.();
      unE?.();
    };
  }, []);
  return active;
}
