import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";
import { ContextMenu, copyText, type MenuItem } from "./ContextMenu";

const dirname = (p: string): string => p.split(/[\\/]/).slice(0, -1).join("/") || "/";
const errText = (e: unknown): string =>
  typeof e === "string" ? e : ((e as { message?: string })?.message ?? String(e));

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
  id,
  reloadSignal,
}: {
  root: string;
  onActivate: (path: string) => void;
  onPreview?: (path: string) => void;
  id?: string;
  /** Bump to force an immediate disk re-read (manual refresh button). */
  reloadSignal?: number;
}) {
  const childrenCache = useAppStore((s) => s.childrenCache);
  const loadChildren = useAppStore((s) => s.loadChildren);
  const reloadDir = useAppStore((s) => s.reloadDir);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);
  // Re-read the root + every expanded dir from disk (reflects external add/delete).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const refreshFromDisk = useCallback(() => {
    void reloadDir(root);
    expandedRef.current.forEach((d) => void reloadDir(d));
  }, [root, reloadDir]);
  // Periodic polling (every 4s) so external file changes show up on their own.
  useEffect(() => {
    const t = setInterval(refreshFromDisk, 4000);
    return () => clearInterval(t);
  }, [refreshFromDisk]);
  // Manual force-refresh (sidebar ↻ button bumps reloadSignal).
  useEffect(() => {
    if (reloadSignal) refreshFromDisk();
  }, [reloadSignal, refreshFromDisk]);
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
    if (e.ctrlKey || e.altKey) return; // Ctrl/Alt arrows = column/tab nav (bubble up)
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

  const menuItems = (entry: DirEntry): MenuItem[] => {
    const targetDir = entry.is_dir ? entry.path : dirname(entry.path);
    return [
      { label: "경로 복사", onClick: () => void copyText(entry.path) },
      {
        label: "새 파일",
        onClick: async () => {
          const name = window.prompt(`새 파일 이름 (${targetDir})`);
          if (!name || !name.trim()) return;
          const clean = name.trim();
          // Keep new files inside the folder — no separators / parent escapes (codex SF-1).
          if (/[\\/]/.test(clean) || clean.split("/").includes("..") || clean.includes("..")) {
            alert("파일 이름에 경로 구분자(/ \\)나 ..는 쓸 수 없습니다.");
            return;
          }
          const np = `${targetDir}/${clean}`;
          try {
            await invoke("write_file", { path: np, content: "" });
            if (entry.is_dir) expand(entry.path);
            await reloadDir(targetDir);
            onActivate(np);
          } catch (err) {
            alert(`파일 생성 실패: ${errText(err)}`);
          }
        },
      },
      {
        label: "삭제",
        danger: true,
        onClick: async () => {
          if (!window.confirm(`${entry.path}\n삭제할까요?${entry.is_dir ? " (폴더 전체)" : ""}`)) return;
          try {
            await invoke("delete_path", { path: entry.path });
            await reloadDir(dirname(entry.path));
          } catch (err) {
            alert(`삭제 실패: ${errText(err)}`);
          }
        },
      },
    ];
  };

  return (
    <>
      <div
        className="study-tree"
        id={id}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!cursor && visible.length > 0) setCursor(visible[0].entry.path);
        }}
      >
        {visible.map(({ entry, depth }): ReactNode => (
          <div
            key={entry.path}
            className={`study-tree-row${entry.is_dir ? "" : " study-tree-file"}${
              cursor === entry.path ? " cursor" : ""
            }`}
            style={{ paddingLeft: 6 + depth * 12 + (entry.is_dir ? 0 : 12) }}
            title={entry.path}
            onClick={() => onRowClick(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCursor(entry.path);
              setMenu({ x: e.clientX, y: e.clientY, entry });
            }}
          >
            {entry.is_dir && <span className="study-tree-caret">{expanded.has(entry.path) ? "▾" : "▸"}</span>}
            <span className="study-tree-name">{entry.name}</span>
          </div>
        ))}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
