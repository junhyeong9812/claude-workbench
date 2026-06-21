import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";

interface VisNode {
  entry: DirEntry;
  depth: number;
}

/**
 * Lightweight, keyboard-navigable folder tree for a study sidebar, rooted at an
 * arbitrary path (decoupled from the project model). Reuses the store's
 * path-keyed `childrenCache`/`loadChildren`; expansion + cursor are local.
 *
 * Keyboard (mouse-free): ↑/↓ move the cursor, →/← expand/collapse (or step
 * in/out), Enter activates a file. In viewer mode the cursor *follows* — every
 * cursor move on a file calls `onPreview` so the file opens as you browse.
 */
export function StudyTree({
  root,
  onActivate,
  onPreview,
}: {
  root: string;
  onActivate: (path: string) => void;
  onPreview?: (path: string) => void;
}) {
  const childrenCache = useAppStore((s) => s.childrenCache);
  const loadChildren = useAppStore((s) => s.loadChildren);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  useEffect(() => {
    void loadChildren(root);
    setExpanded(new Set());
    setCursor(null);
  }, [root, loadChildren]);

  // Flattened list of currently-visible nodes (for ↑/↓ traversal).
  const visible = useMemo<VisNode[]>(() => {
    const out: VisNode[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of childrenCache[dir] ?? []) {
        out.push({ entry: e, depth });
        if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, childrenCache, expanded]);

  const expand = (dir: string) =>
    setExpanded((prev) => {
      if (prev.has(dir)) return prev;
      const next = new Set(prev);
      next.add(dir);
      void loadChildren(dir);
      return next;
    });
  const collapse = (dir: string) =>
    setExpanded((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Set(prev);
      next.delete(dir);
      return next;
    });

  // Move the cursor by delta over the visible list; in viewer mode, preview it.
  const moveCursor = (delta: number) => {
    if (visible.length === 0) return;
    const idx = visible.findIndex((v) => v.entry.path === cursor);
    const nextIdx = idx === -1 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, idx + delta));
    const node = visible[nextIdx];
    setCursor(node.entry.path);
    if (!node.entry.is_dir) onPreviewRef.current?.(node.entry.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = visible.find((v) => v.entry.path === cursor);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur?.entry.is_dir) {
          if (expanded.has(cur.entry.path)) moveCursor(1);
          else expand(cur.entry.path);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur?.entry.is_dir && expanded.has(cur.entry.path)) collapse(cur.entry.path);
        break;
      case "Enter":
        e.preventDefault();
        if (cur && !cur.entry.is_dir) onActivate(cur.entry.path);
        else if (cur?.entry.is_dir) (expanded.has(cur.entry.path) ? collapse : expand)(cur.entry.path);
        break;
    }
  };

  const onRowClick = (entry: DirEntry) => {
    setCursor(entry.path);
    if (entry.is_dir) (expanded.has(entry.path) ? collapse : expand)(entry.path);
    else onActivate(entry.path);
  };

  return (
    <div className="study-tree" tabIndex={0} onKeyDown={onKeyDown}>
      {visible.map(({ entry, depth }): ReactNode => (
        <div
          key={entry.path}
          className={`study-tree-row${entry.is_dir ? "" : " study-tree-file"}${
            cursor === entry.path ? " cursor" : ""
          }`}
          style={{ paddingLeft: 6 + depth * 12 + (entry.is_dir ? 0 : 12) }}
          title={entry.path}
          onClick={() => onRowClick(entry)}
        >
          {entry.is_dir && <span className="study-tree-caret">{expanded.has(entry.path) ? "▾" : "▸"}</span>}
          <span className="study-tree-name">{entry.name}</span>
        </div>
      ))}
    </div>
  );
}
