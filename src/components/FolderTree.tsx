import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";
import { expandedSetOf } from "../state/treeSelectors";
import type { DirEntry } from "../types";
import { TypeBadges } from "./TypeBadges";
import {
  TREE_DND_MIME,
  baseName,
  decodePayload,
  dropDisallowed,
  encodePayload,
  parentDir,
  resolveDropDir,
} from "./treeDnd";

/** 트리 행 DnD 핸들러 묶음 — TreeNode 재귀에 한 덩어리로 내려보낸다. */
interface TreeDndHandlers {
  /** 현재 드롭 후보로 하이라이트할 행 경로 ("" = 빈 영역/루트, null = 없음). */
  hover: string | null;
  onRowDragStart: (entry: DirEntry, e: React.DragEvent) => void;
  onRowDragOver: (entry: DirEntry | null, e: React.DragEvent) => void;
  onRowDrop: (entry: DirEntry | null, e: React.DragEvent) => void;
  onRowDragEnd: () => void;
}

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
  parentIgnored,
  dnd,
}: {
  entry: DirEntry;
  depth: number;
  onContext: ContextHandler;
  /** An ignored dir's children come back non-ignored from a walk rooted inside
   * it, so ignored-ness is inherited down the subtree for consistent dimming. */
  parentIgnored?: boolean;
  dnd: TreeDndHandlers;
}) {
  // P2 F1: expanded 배열 identity 메모 Set의 O(1) 조회 — 기존 노드당
  // find+includes O(P+E)가 store set마다 전 노드에서 돌던 비용 제거(동치는
  // treeSelectors 특성테스트).
  const expanded = useAppStore((s) => expandedSetOf(s).has(entry.path));
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
  const ignored = parentIgnored || !!entry.is_ignored;

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isCursor ? " tree-row-cursor" : ""}${isPeeked ? " tree-row-peeked" : ""}${ignored ? " tree-row-ignored" : ""}${dnd.hover === entry.path ? " tree-row-drop" : ""}`}
        data-tree-path={entry.path}
        style={{ paddingLeft: depth * 14 + 8 }}
        draggable
        onDragStart={(e) => dnd.onRowDragStart(entry, e)}
        onDragOver={(e) => dnd.onRowDragOver(entry, e)}
        onDrop={(e) => dnd.onRowDrop(entry, e)}
        onDragEnd={dnd.onRowDragEnd}
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
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                onContext={onContext}
                parentIgnored={ignored}
                dnd={dnd}
              />
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
  const expanded = expandedSetOf(s);
  const out: DirEntry[] = [];
  const walk = (entries: DirEntry[] | undefined) => {
    for (const e of entries ?? []) {
      out.push(e);
      if (e.is_dir && expanded.has(e.path)) walk(s.childrenCache[e.path]);
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
    | { kind: "dnd-overwrite"; from: string; to: string; destDir: string; srcParent: string; copy: boolean }
    | null
  >(null);
  const [name, setName] = useState("");
  const [opErr, setOpErr] = useState<string | null>(null);
  // DnD 드롭 후보 하이라이트: 행 경로, "" = 빈 영역(루트), null = 드래그 없음.
  const [dndHover, setDndHover] = useState<string | null>(null);
  // DnD 실행 single-flight (리뷰 D2): 덮어쓰기 버튼 중복 클릭이 "삭제→이동
  // 완료→재삭제"로 원본을 지우는 race 차단. ref는 상태 반영 전 클릭까지 막고,
  // state는 버튼 disabled 표시용.
  const dndBusyRef = useRef(false);
  const [dndBusy, setDndBusy] = useState(false);
  // 드롭 존 창 생성 중 가드 (post-fix P5 — check-then-create race).
  const dropZoneOpeningRef = useRef(false);

  // Parent dir of an absolute path; "/" for a root-level entry (so reloadDir
  // never gets "" → the process cwd). treeDnd.parentDir와 문자단위 동일이라
  // 그쪽(테스트 보유)을 단일 출처로 (P4).
  const dirname = parentDir;

  // Clean a typed relative path: drop empty/`.`/`..` segments. "" if invalid, so
  // `.` / `/` / `...` don't slip through as a no-op create.
  const normalizeRel = (s: string): string => {
    const segs = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (segs.length === 0 || segs.some((x) => x === "." || x === "..")) return "";
    return segs.join("/");
  };

  // dir to create *into*: a folder uses itself; a file uses its parent dir; the
  // empty background uses the project root.
  const dirOf = (node: DirEntry | null): string => {
    if (!node) return activeProject ?? "";
    return node.is_dir ? node.path : dirname(node.path);
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
    if (!dialog || !activeProject) return;
    const root = activeProject;
    const trimmed = name.trim();
    if (dialog.kind === "newfile") {
      // `sub/Foo.java` makes the subdir too. Reject empty path segments.
      const rel = normalizeRel(trimmed);
      if (!rel) {
        setOpErr("올바른 파일명을 입력하세요");
        return;
      }
      const path = `${dialog.dir}/${rel}`;
      void runOp(() => invoke("create_file", { path, root }), dialog.dir, dialog.dir).then((ok) => {
        if (ok) requestEditorOpen(path); // open the fresh file in the editor
      });
    } else if (dialog.kind === "newfolder") {
      // `.` (Java package style) or `/` → nested dirs. Reject empty segments so
      // `.` / `/` / `...` don't silently no-op on an existing dir.
      const rel = normalizeRel(trimmed.replace(/\./g, "/"));
      if (!rel) {
        setOpErr("올바른 폴더명을 입력하세요");
        return;
      }
      void runOp(() => invoke("create_dir", { path: `${dialog.dir}/${rel}`, root }), dialog.dir, dialog.dir);
    } else if (dialog.kind === "rename") {
      const rel = normalizeRel(trimmed);
      if (!rel) {
        setOpErr("올바른 이름을 입력하세요");
        return;
      }
      const parent = dirname(dialog.node.path);
      void runOp(
        () => invoke("rename_path", { from: dialog.node.path, to: `${parent}/${rel}`, root }),
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

  const isExpanded = (p: string): boolean => expandedSetOf(useAppStore.getState()).has(p);

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

  // ---- 트리 내 DnD (이동/복사) ----
  // 전용 mime + stopPropagation으로 프로젝트 탭 드래그·dockview 탭 드래그와
  // 서로 오인하지 않는다 (spec §2).
  const acceptsTreeDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(TREE_DND_MIME);

  const onRowDragStart = (entry: DirEntry, e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(TREE_DND_MIME, encodePayload({ path: entry.path, isDir: entry.is_dir }));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const onRowDragOver = (entry: DirEntry | null, e: React.DragEvent) => {
    if (!acceptsTreeDrag(e)) return; // 다른 출처(탭 등)의 드래그는 무시
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
    setDndHover(entry ? entry.path : "");
  };

  /** 이동/복사 실행. `fromDialog`=덮어쓰기 확인 다이얼로그 경유(에러를 다이얼
   * 로그 안에 표시), 직접 드롭 실패는 alert. 원본 삭제는 rename 성공으로만
   * 일어난다 — 덮어쓰기도 "대상 삭제 → 이동/복사" 순서라 원본은 보존(spec §2). */
  const doDnd = async (
    from: string,
    to: string,
    destDir: string,
    srcParent: string,
    copy: boolean,
    overwrite: boolean,
    fromDialog: boolean,
  ) => {
    const root = activeProject;
    if (!root) return;
    if (dndBusyRef.current) return; // single-flight (D2)
    dndBusyRef.current = true;
    setDndBusy(true);
    try {
      if (overwrite) await invoke("delete_path", { path: to, root });
      if (copy) await invoke("copy_path", { from, to, root });
      else await invoke("rename_path", { from, to, root });
      setDialog(null);
      setOpErr(null);
      await reloadDir(destDir);
      ensureExpanded(destDir);
      if (!copy && srcParent !== destDir) await reloadDir(srcParent);
      if (!copy && useAppStore.getState().treeCursor === from) setTreeCursor(to);
    } catch (e) {
      if (fromDialog) setOpErr(errText(e, "작업 실패"));
      else alert(errText(e, copy ? "복사 실패" : "이동 실패"));
    } finally {
      dndBusyRef.current = false;
      setDndBusy(false);
    }
  };

  const onRowDrop = (entry: DirEntry | null, e: React.DragEvent) => {
    if (!acceptsTreeDrag(e) || !activeProject) return;
    e.preventDefault();
    e.stopPropagation();
    setDndHover(null);
    const payload = decodePayload(e.dataTransfer.getData(TREE_DND_MIME));
    if (!payload) return;
    const copy = e.ctrlKey;
    const destDir = resolveDropDir(entry, activeProject);
    const reason = dropDisallowed(payload, destDir);
    if (reason) {
      alert(reason);
      return;
    }
    const to = `${destDir}/${baseName(payload.path)}`;
    const srcParent = parentDir(payload.path);
    void (async () => {
      // 충돌 검사는 캐시가 아니라 실 디렉토리 목록으로 (미로딩 폴더 대비).
      // 조회 실패 시엔 백엔드 no-clobber가 최후 방어선.
      let exists = false;
      try {
        const entries = await invoke<DirEntry[]>("read_dir", { path: destDir });
        exists = entries.some((en) => en.path === to);
      } catch {
        exists = false;
      }
      if (exists) {
        setOpErr(null);
        setDialog({ kind: "dnd-overwrite", from: payload.path, to, destDir, srcParent, copy });
      } else {
        await doDnd(payload.path, to, destDir, srcParent, copy, false, false);
      }
    })();
  };

  const dnd: TreeDndHandlers = {
    hover: dndHover,
    onRowDragStart,
    onRowDragOver,
    onRowDrop,
    onRowDragEnd: () => setDndHover(null),
  };

  /** OS 파일 반입용 드롭 존 보조 창 — 메인 창은 dragDropEnabled:false(탭
   * 드래그 보존)라 OS 드롭을 못 받으므로, 이 창만 true로 열어 받는다.
   * 대상 폴더별 고정 label — 같은 폴더로 다시 열면 기존 창을 포커스(진행 중
   * 결과 표시 보존, 리뷰 D8), 다른 폴더면 별도 창. */
  const openDropZone = (dest: string) => {
    setMenu(null);
    if (!activeProject) return;
    if (dropZoneOpeningRef.current) return; // 연타 create race 방지 (post-fix P5)
    dropZoneOpeningRef.current = true;
    // label은 경로 전체를 hex 인코딩 — 해시 충돌로 다른 폴더의 창에 합쳐지는
    // 일이 없다(post-fix P4). 허용 문자(a-zA-Z0-9-/:_)만 사용.
    const hex = Array.from(new TextEncoder().encode(dest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const label = `dropzone-${hex}`;
    void (async () => {
      try {
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await existing.setFocus().catch(() => {});
          return;
        }
        const w = new WebviewWindow(label, {
          url: `${window.location.pathname}#dropzone=${encodeURIComponent(dest)}::${encodeURIComponent(activeProject)}`,
          title: "파일 가져오기 — 드롭 존",
          width: 420,
          height: 300,
          alwaysOnTop: true,
          dragDropEnabled: true,
        });
        // 생성은 비동기 — created/error 이벤트까지 가드를 쥔다 (post-fix 2차:
        // 즉시 해제하면 후속 호출의 getByLabel이 아직 null이라 중복 생성).
        await new Promise<void>((resolve) => {
          void w.once("tauri://created", () => resolve());
          void w.once("tauri://error", () => resolve());
        });
      } finally {
        dropZoneOpeningRef.current = false;
      }
    })();
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
      className={`tree${dndHover === "" ? " tree-drop-root" : ""}`}
      id="folder-tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onDragOver={(e) => onRowDragOver(null, e)}
      onDrop={(e) => onRowDrop(null, e)}
      onDragLeave={(e) => {
        // 트리 밖으로 나갈 때만 해제 (자식 행 진입은 유지).
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDndHover(null);
      }}
      onContextMenu={(e) => {
        // Right-click on empty space → operate on the project root.
        e.preventDefault();
        onContext(null, e.clientX, e.clientY);
      }}
    >
      {rootChildren.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} onContext={onContext} dnd={dnd} />
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
            <button
              className="tree-menu-item"
              title="OS 파일매니저에서 파일을 끌어다 넣는 보조 창을 엽니다 (이 폴더로 복사)"
              onClick={() => openDropZone(menu.dir)}
            >
              파일 가져오기 (드롭 존)
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
            {dialog.kind === "dnd-overwrite" ? (
              <>
                <div className="tree-dialog-head">덮어쓰기 확인</div>
                <div className="tree-dialog-msg">
                  대상 폴더에 <code>{baseName(dialog.to)}</code> 이(가) 이미 있습니다.
                  <br />
                  기존 항목을 삭제하고 {dialog.copy ? "복사" : "이동"}할까요?
                </div>
                {opErr && <div className="tree-dialog-err">{opErr}</div>}
                <div className="tree-dialog-foot">
                  <button onClick={() => setDialog(null)}>취소</button>
                  <button
                    className="tree-menu-danger"
                    disabled={dndBusy}
                    onClick={() =>
                      void doDnd(
                        dialog.from,
                        dialog.to,
                        dialog.destDir,
                        dialog.srcParent,
                        dialog.copy,
                        true,
                        true,
                      )
                    }
                  >
                    {dndBusy ? "처리 중…" : "덮어쓰기"}
                  </button>
                </div>
              </>
            ) : dialog.kind === "delete" ? (
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
                        () => invoke("delete_path", { path: dialog.node.path, root: activeProject }),
                        dirname(dialog.node.path),
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
