import { useEffect } from "react";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";
import { TypeBadges } from "./TypeBadges";

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const expanded = useAppStore((s) => {
    const active = s.projects.find((p) => p.path === s.activeProject);
    return active?.tree_state.expanded.includes(entry.path) ?? false;
  });
  const children = useAppStore((s) => s.childrenCache[entry.path]);
  const isCursor = useAppStore((s) => s.treeCursor === entry.path);
  const isPeeked = useAppStore((s) => s.peekFile === entry.path);
  const toggleExpanded = useAppStore((s) => s.toggleExpanded);
  const loadChildren = useAppStore((s) => s.loadChildren);
  const setTreeCursor = useAppStore((s) => s.setTreeCursor);
  const setPeekFile = useAppStore((s) => s.setPeekFile);

  useEffect(() => {
    if (entry.is_dir && expanded && !children) {
      void loadChildren(entry.path);
    }
  }, [entry.is_dir, entry.path, expanded, children, loadChildren]);

  const onClick = () => {
    setTreeCursor(entry.path);
    if (entry.is_dir) toggleExpanded(entry.path);
    else setPeekFile(entry.path);
    // Focus the tree so subsequent ↑/↓ navigate from here.
    document.getElementById("folder-tree")?.focus();
  };

  const icon = entry.is_dir ? (expanded ? "▾" : "▸") : "·";

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isCursor ? " tree-row-cursor" : ""}${isPeeked ? " tree-row-peeked" : ""}`}
        data-tree-path={entry.path}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={onClick}
      >
        <span className="tree-icon">{icon}</span>
        <span className="tree-label">{entry.name}</span>
        {entry.is_dir && entry.project_types.length > 0 && (
          <TypeBadges types={entry.project_types} />
        )}
      </div>
      {entry.is_dir && expanded && children && (
        <div className="tree-children">
          {children.length === 0 ? (
            <div
              className="tree-empty-child"
              style={{ paddingLeft: (depth + 1) * 14 + 8 }}
            >
              (empty)
            </div>
          ) : (
            children.map((child) => (
              <TreeNode key={child.path} entry={child} depth={depth + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Flattened visible nodes (display order), respecting which dirs are expanded —
 * the navigation model for ↑/↓. Read from the store directly (not a hook). */
function visibleNodes(): DirEntry[] {
  const s = useAppStore.getState();
  const ap = s.activeProject;
  if (!ap) return [];
  const expanded = s.projects.find((p) => p.path === ap)?.tree_state.expanded ?? [];
  const out: DirEntry[] = [];
  const walk = (entries: DirEntry[] | undefined) => {
    for (const e of entries ?? []) {
      out.push(e);
      if (e.is_dir && expanded.includes(e.path)) walk(s.childrenCache[e.path]);
    }
  };
  walk(s.childrenCache[ap]);
  return out;
}

export function FolderTree() {
  const activeProject = useAppStore((s) => s.activeProject);
  const rootChildren = useAppStore((s) =>
    s.activeProject ? s.childrenCache[s.activeProject] : undefined,
  );
  const loadChildren = useAppStore((s) => s.loadChildren);
  const toggleExpanded = useAppStore((s) => s.toggleExpanded);
  const setTreeCursor = useAppStore((s) => s.setTreeCursor);
  const setPeekFile = useAppStore((s) => s.setPeekFile);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const reloadActiveTree = useAppStore((s) => s.reloadActiveTree);

  useEffect(() => {
    if (activeProject) void loadChildren(activeProject);
  }, [activeProject, loadChildren]);

  // Disk reload: poll the active tree (root + expanded) so external file
  // add/delete shows up on its own (manual ↻ in the toolbar bumps it too).
  useEffect(() => {
    if (!activeProject) return;
    const t = setInterval(() => void reloadActiveTree(), 4000);
    return () => clearInterval(t);
  }, [activeProject, reloadActiveTree]);

  const isExpanded = (p: string): boolean => {
    const s = useAppStore.getState();
    return (
      s.projects.find((pr) => pr.path === s.activeProject)?.tree_state.expanded.includes(p) ?? false
    );
  };

  // Move the cursor to a node; when the peek viewer is open, follow it onto files
  // (so ↑/↓ reads through the tree). Keep the moved row in view.
  const moveTo = (node: DirEntry) => {
    setTreeCursor(node.path);
    if (useAppStore.getState().peekFile != null && !node.is_dir) setPeekFile(node.path);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-tree-path="${CSS.escape(node.path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const nodes = visibleNodes();
    if (nodes.length === 0) return;
    const cursor = useAppStore.getState().treeCursor;
    const idx = nodes.findIndex((n) => n.path === cursor);
    const cur = idx >= 0 ? nodes[idx] : null;
    // Ctrl+E opens the cursor file in the editor. Close the peek viewer too — the
    // editor opens as a dock panel *under* the peek overlay, so leaving the peek
    // open would hide it.
    if (e.ctrlKey && (e.key === "e" || e.key === "E")) {
      if (cur && !cur.is_dir) {
        e.preventDefault();
        requestEditorOpen(cur.path);
        setPeekFile(null);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(nodes[Math.min((idx < 0 ? -1 : idx) + 1, nodes.length - 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(nodes[Math.max((idx < 0 ? nodes.length : idx) - 1, 0)]);
        break;
      case "ArrowRight":
        if (cur?.is_dir && !isExpanded(cur.path)) {
          e.preventDefault();
          toggleExpanded(cur.path);
        }
        break;
      case "ArrowLeft":
        if (cur?.is_dir && isExpanded(cur.path)) {
          e.preventDefault();
          toggleExpanded(cur.path);
        }
        break;
      case "Enter":
        if (cur) {
          e.preventDefault();
          if (cur.is_dir) toggleExpanded(cur.path);
          else setPeekFile(cur.path);
        }
        break;
      case "Escape":
        e.preventDefault();
        setPeekFile(null);
        break;
    }
  };

  if (!activeProject) {
    return <div className="tree-empty">No project open</div>;
  }
  if (!rootChildren) {
    return <div className="tree-empty">Loading…</div>;
  }

  // When the tree gains focus (e.g. Ctrl+B) with no cursor yet, put it on the
  // first node so there's a visible selection to navigate from.
  const onFocus = () => {
    if (useAppStore.getState().treeCursor == null) {
      const nodes = visibleNodes();
      if (nodes.length > 0) setTreeCursor(nodes[0].path);
    }
  };

  return (
    <div className="tree" id="folder-tree" tabIndex={0} onKeyDown={onKeyDown} onFocus={onFocus}>
      {rootChildren.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
