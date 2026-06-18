import { useEffect } from "react";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const expanded = useAppStore((s) => {
    const active = s.projects.find((p) => p.path === s.activeProject);
    return active?.tree_state.expanded.includes(entry.path) ?? false;
  });
  const children = useAppStore((s) => s.childrenCache[entry.path]);
  const toggleExpanded = useAppStore((s) => s.toggleExpanded);
  const loadChildren = useAppStore((s) => s.loadChildren);

  useEffect(() => {
    if (entry.is_dir && expanded && !children) {
      void loadChildren(entry.path);
    }
  }, [entry.is_dir, entry.path, expanded, children, loadChildren]);

  const onClick = () => {
    if (entry.is_dir) toggleExpanded(entry.path);
  };

  const icon = entry.is_dir ? (expanded ? "▾" : "▸") : "·";

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={onClick}
      >
        <span className="tree-icon">{icon}</span>
        <span className="tree-label">{entry.name}</span>
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

export function FolderTree() {
  const activeProject = useAppStore((s) => s.activeProject);
  const rootChildren = useAppStore((s) =>
    s.activeProject ? s.childrenCache[s.activeProject] : undefined,
  );
  const loadChildren = useAppStore((s) => s.loadChildren);

  useEffect(() => {
    if (activeProject) void loadChildren(activeProject);
  }, [activeProject, loadChildren]);

  if (!activeProject) {
    return <div className="tree-empty">No project open</div>;
  }
  if (!rootChildren) {
    return <div className="tree-empty">Loading…</div>;
  }

  return (
    <div className="tree">
      {rootChildren.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}
