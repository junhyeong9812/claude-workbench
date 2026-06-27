import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";
import type { DirEntry } from "../types";
import { TypeBadges } from "./TypeBadges";

/** Quick file-type picks for "새 파일" (fills the extension; the user can also
 * just type a full name like `Foo.java`). Our supported languages + markdown. */
const FILE_EXTS: [string, string][] = [
  ["Rust", "rs"],
  ["Java", "java"],
  ["Kotlin", "kt"],
  ["Python", "py"],
  ["TS", "ts"],
  ["TSX", "tsx"],
  ["JS", "js"],
  ["HTML", "html"],
  ["CSS", "css"],
  ["MD", "md"],
];

/** A right-click action on a tree node (or the empty background → `entry=null`). */
type ContextHandler = (entry: DirEntry | null, x: number, y: number) => void;

function TreeNode({
  entry,
  depth,
  onContext,
}: {
  entry: DirEntry;
  depth: number;
  onContext: ContextHandler;
}) {
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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext(entry, e.clientX, e.clientY);
        }}
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
              <TreeNode key={child.path} entry={child} depth={depth + 1} onContext={onContext} />
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
  const reloadDir = useAppStore((s) => s.reloadDir);

  // Right-click context menu (at cursor) + the create/rename/delete dialog.
  const [menu, setMenu] = useState<{ dir: string; node: DirEntry | null; x: number; y: number } | null>(
    null,
  );
  const [dialog, setDialog] = useState<
    | { kind: "newfile" | "newfolder"; dir: string }
    | { kind: "rename"; node: DirEntry }
    | { kind: "delete"; node: DirEntry }
    | null
  >(null);
  const [name, setName] = useState("");
  const [opErr, setOpErr] = useState<string | null>(null);

  // dir to create *into*: a folder uses itself; a file uses its parent dir; the
  // empty background uses the project root.
  const dirOf = (node: DirEntry | null): string => {
    if (!node) return activeProject ?? "";
    return node.is_dir ? node.path : node.path.slice(0, node.path.lastIndexOf("/"));
  };

  const onContext: ContextHandler = (node, x, y) => {
    setMenu({ dir: dirOf(node), node, x, y });
  };

  const ensureExpanded = (dir: string) => {
    if (dir !== activeProject && !isExpanded(dir)) toggleExpanded(dir);
  };

  // Run a filesystem op, refresh the affected dir, surface errors in the dialog.
  // Returns true only on success, so callers can chain (e.g. open the new file)
  // without firing on failure.
  const runOp = async (
    fn: () => Promise<void>,
    reloadTarget: string,
    afterExpand?: string,
  ): Promise<boolean> => {
    setOpErr(null);
    try {
      await fn();
      await reloadDir(reloadTarget);
      if (afterExpand) ensureExpanded(afterExpand);
      setDialog(null);
      setName("");
      return true;
    } catch (e) {
      setOpErr(errText(e, "작업 실패"));
      return false;
    }
  };

  const submitDialog = () => {
    if (!dialog) return;
    const trimmed = name.trim();
    if (dialog.kind === "newfile") {
      if (!trimmed) return;
      // `sub/Foo.java` makes the subdir too; reload the right-clicked dir.
      const path = `${dialog.dir}/${trimmed}`;
      void runOp(() => invoke("create_file", { path }), dialog.dir, dialog.dir).then((ok) => {
        if (ok) requestEditorOpen(path); // open the fresh file in the editor
      });
    } else if (dialog.kind === "newfolder") {
      if (!trimmed) return;
      // `.` (Java package style) or `/` → nested dirs.
      const rel = trimmed.replace(/\./g, "/");
      void runOp(() => invoke("create_dir", { path: `${dialog.dir}/${rel}` }), dialog.dir, dialog.dir);
    } else if (dialog.kind === "rename") {
      if (!trimmed) return;
      const parent = dialog.node.path.slice(0, dialog.node.path.lastIndexOf("/"));
      void runOp(
        () => invoke("rename_path", { from: dialog.node.path, to: `${parent}/${trimmed}` }),
        parent,
      );
    }
  };

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
    // Ctrl+→ moves focus into the peek viewer (opening it for a file first), so
    // ↑/↓ scroll its content. Ctrl+← inside the viewer returns focus here —
    // mirrors the change-detail panel's Ctrl+←/→ focus switching.
    if (e.ctrlKey && e.key === "ArrowRight") {
      if (cur && !cur.is_dir) {
        e.preventDefault();
        setPeekFile(cur.path);
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(".peek-viewer")?.focus(),
        );
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
          if (cur.is_dir) {
            toggleExpanded(cur.path);
          } else {
            // Open the peek and hand focus to it, so ↑/↓ scroll its content (like
            // opening a timeline detail tab). Ctrl+B / Esc return focus to the tree.
            setPeekFile(cur.path);
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>(".peek-viewer")?.focus(),
            );
          }
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

  const openDialog = (d: NonNullable<typeof dialog>, initial = "") => {
    setMenu(null);
    setOpErr(null);
    setName(initial);
    setDialog(d);
  };

  return (
    <div
      className="tree"
      id="folder-tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onContextMenu={(e) => {
        // Right-click on empty space → operate on the project root.
        e.preventDefault();
        onContext(null, e.clientX, e.clientY);
      }}
    >
      {rootChildren.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} onContext={onContext} />
      ))}

      {menu && (
        <>
          <div className="tree-menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="tree-menu" style={{ left: menu.x, top: menu.y }}>
            <button className="tree-menu-item" onClick={() => openDialog({ kind: "newfile", dir: menu.dir })}>
              새 파일
            </button>
            <button className="tree-menu-item" onClick={() => openDialog({ kind: "newfolder", dir: menu.dir })}>
              새 폴더
            </button>
            {menu.node && (
              <>
                <div className="tree-menu-sep" />
                <button
                  className="tree-menu-item"
                  onClick={() => openDialog({ kind: "rename", node: menu.node! }, menu.node!.name)}
                >
                  이름 변경
                </button>
                <button
                  className="tree-menu-item tree-menu-danger"
                  onClick={() => { setDialog({ kind: "delete", node: menu.node! }); setMenu(null); setOpErr(null); }}
                >
                  삭제
                </button>
              </>
            )}
          </div>
        </>
      )}

      {dialog && (
        <div className="tree-dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="tree-dialog" onClick={(e) => e.stopPropagation()}>
            {dialog.kind === "delete" ? (
              <>
                <div className="tree-dialog-head">삭제 확인</div>
                <div className="tree-dialog-msg">
                  <code>{dialog.node.name}</code> 을(를) 삭제할까요?
                  {dialog.node.is_dir && " (폴더 내용 전부)"}
                </div>
                {opErr && <div className="tree-dialog-err">{opErr}</div>}
                <div className="tree-dialog-foot">
                  <button onClick={() => setDialog(null)}>취소</button>
                  <button
                    className="tree-menu-danger"
                    onClick={() =>
                      void runOp(
                        () => invoke("delete_path", { path: dialog.node.path }),
                        dialog.node.path.slice(0, dialog.node.path.lastIndexOf("/")),
                      )
                    }
                  >
                    삭제
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tree-dialog-head">
                  {dialog.kind === "newfile" ? "새 파일" : dialog.kind === "newfolder" ? "새 폴더" : "이름 변경"}
                </div>
                {dialog.kind === "newfolder" && (
                  <div className="tree-dialog-hint">. 또는 / 로 중첩 폴더 (예: com.example.foo)</div>
                )}
                <input
                  className="tree-dialog-input"
                  autoFocus
                  value={name}
                  placeholder={dialog.kind === "newfile" ? "파일명 (예: Foo.java)" : "이름"}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); submitDialog(); }
                    if (e.key === "Escape") { e.preventDefault(); setDialog(null); }
                  }}
                />
                {dialog.kind === "newfile" && (
                  <div className="tree-dialog-exts">
                    {FILE_EXTS.map(([label, ext]) => (
                      <button
                        key={ext}
                        className="tree-ext-btn"
                        onClick={() =>
                          setName((n) => {
                            const base = n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
                            return `${base || "Untitled"}.${ext}`;
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {opErr && <div className="tree-dialog-err">{opErr}</div>}
                <div className="tree-dialog-foot">
                  <button onClick={() => setDialog(null)}>취소</button>
                  <button onClick={submitDialog}>확인</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
