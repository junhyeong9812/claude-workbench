import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";

/**
 * Lightweight folder tree for a study sidebar, rooted at an arbitrary path
 * (decoupled from the project model). Reuses the store's path-keyed
 * `childrenCache`/`loadChildren`; expansion is local. File click → `onOpenFile`.
 */
export function StudyTree({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const childrenCache = useAppStore((s) => s.childrenCache);
  const loadChildren = useAppStore((s) => s.loadChildren);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void loadChildren(root);
    setExpanded(new Set());
  }, [root, loadChildren]);

  const toggle = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void loadChildren(dir);
      }
      return next;
    });

  const renderNode = (entry: DirEntry, depth: number): ReactNode => {
    if (entry.is_dir) {
      const isOpen = expanded.has(entry.path);
      return (
        <div key={entry.path}>
          <div
            className="study-tree-row"
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => toggle(entry.path)}
          >
            <span className="study-tree-caret">{isOpen ? "▾" : "▸"}</span>
            <span className="study-tree-name">{entry.name}</span>
          </div>
          {isOpen && (childrenCache[entry.path] ?? []).map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <div
        key={entry.path}
        className="study-tree-row study-tree-file"
        style={{ paddingLeft: 6 + depth * 12 + 12 }}
        title={entry.path}
        onClick={() => onOpenFile(entry.path)}
      >
        <span className="study-tree-name">{entry.name}</span>
      </div>
    );
  };

  return <div className="study-tree">{(childrenCache[root] ?? []).map((c) => renderNode(c, 0))}</div>;
}
