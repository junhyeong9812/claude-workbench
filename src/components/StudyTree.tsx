import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../state/store";
import { useShallow } from "zustand/react/shallow";
import type { DirEntry } from "../types";
import { copyText } from "./ContextMenu";
import { useTreeCrud } from "./treeCrud";
import { basename } from "../utils/path";

interface VisNode {
  entry: DirEntry;
  depth: number;
  /** gitignored (inherited down the subtree) — rendered dimmed. */
  ignored: boolean;
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
  /** 트리 인스턴스 키(좌/우 독립의 전제 — studyExpanded 키. 리뷰 P3-3:
   * optional이면 좌우 동일 root에서 확장이 연동되는 충돌이 가능해 필수). */
  id: string;
  /** Bump to force an immediate disk re-read (manual refresh button). */
  reloadSignal?: number;
}) {
  const loadChildren = useAppStore((s) => s.loadChildren);
  const reloadDir = useAppStore((s) => s.reloadDir);
  const closeStudyTabsUnder = useAppStore((s) => s.closeStudyTabsUnder);
  // P5 F-g: expanded를 store로 승격(키 = 인스턴스 id ?? root — 좌/우 독립 유지).
  // 캐시 상한 keep-set이 스터디 확장 dir를 볼 수 있게 하는 전제. 수명 계약은
  // 기존대로 ephemeral(비영속) + root 전환 시 리셋.
  const expandedKey = id;
  const EMPTY_EXPANDED = useMemo<string[]>(() => [], []);
  const expandedArr = useAppStore((s) => s.studyExpanded[expandedKey]) ?? EMPTY_EXPANDED;
  const setStudyExpanded = useAppStore((s) => s.setStudyExpanded);
  const expanded = useMemo(() => new Set(expandedArr), [expandedArr]);
  // P5 F-g: childrenCache 통째 구독 제거 — 이 트리가 실제로 그리는 dir
  // (root + 확장 목록)의 슬라이스만 구독한다. 다른 프로젝트/dir 폴링이 이
  // 트리를 리렌더하지 못한다(P2 identity 보존과 결합해 무변화 폴링은 완전
  // 무비용). useShallow = 원소 identity 비교.
  const visibleDirs = useMemo(() => [root, ...expandedArr], [root, expandedArr]);
  const childrenSlices = useAppStore(
    useShallow((s) => visibleDirs.map((d) => s.childrenCache[d])),
  );
  const cacheOf = useMemo(() => {
    const m = new Map<string, DirEntry[] | undefined>();
    visibleDirs.forEach((d, i) => m.set(d, childrenSlices[i]));
    return m;
  }, [visibleDirs, childrenSlices]);
  const [cursor, setCursor] = useState<string | null>(null);
  // Re-read the root + every expanded dir from disk (reflects external add/delete).
  const expandedRef = useRef(expandedArr);
  expandedRef.current = expandedArr;
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

  // 언마운트 시 확장 목록 정리 — 승격 전 컴포넌트 로컬 Set의 수명 계약 복원
  // (리뷰: 잔존 시 keep-set이 비표시 dir를 축출 금지로 고정 + 재진입 첫
  // 렌더에 구 확장이 깜빡).
  useEffect(
    () => () => {
      useAppStore.getState().setStudyExpanded(expandedKey, []);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    void loadChildren(root);
    setStudyExpanded(expandedKey, []);
    setCursor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, loadChildren]);

  // Flattened list of currently-visible nodes (for ↑/↓ traversal).
  const visible = useMemo<VisNode[]>(() => {
    const out: VisNode[] = [];
    const walk = (dir: string, depth: number, parentIgnored: boolean) => {
      for (const e of cacheOf.get(dir) ?? []) {
        const ignored = parentIgnored || !!e.is_ignored;
        out.push({ entry: e, depth, ignored });
        if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1, ignored);
      }
    };
    walk(root, 0, false);
    return out;
  }, [root, cacheOf, expanded]);

  const expand = (dir: string) => {
    if (expanded.has(dir)) return;
    void loadChildren(dir);
    setStudyExpanded(expandedKey, [...expandedArr, dir]); // 항상 새 배열(메모 계약)
  };
  const collapse = (dir: string) => {
    if (!expanded.has(dir)) return;
    setStudyExpanded(
      expandedKey,
      expandedArr.filter((d) => d !== dir),
    );
  };

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

  // 우클릭 CRUD는 파일 탭 트리와 **같은 훅**을 쓴다 (새 파일·새 폴더·이름 변경·
  // 삭제 + brace 다중 생성). containment 루트는 이 트리의 root — 스터디 반대쪽
  // 폴더로 나가는 경로는 백엔드 ensure_within이 거부한다.
  const crud = useTreeCrud({
    root,
    reloadDir,
    expandDir: expand,
    // 다중 생성이면 첫 파일만 연다 (탭 폭증 방지).
    onCreated: (paths) => onActivate(paths[0]),
    onDeleted: (path) => closeStudyTabsUnder(path), // prune now-dead tabs
    onOpenTerminal: (dir) => useAppStore.getState().requestTerminalOpen({ cwd: dir, title: basename(dir) }),
    extraItems: (node) =>
      node ? [{ label: "경로 복사", onClick: () => void copyText(node.path) }] : [],
  });

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
        onContextMenu={(e) => {
          // 빈 영역 우클릭 = 트리 루트 대상 (파일 탭 트리 선례). 폴더가 텅 비어
          // 있을 때 첫 파일을 만들 진입점이 여기밖에 없다.
          e.preventDefault();
          crud.openMenu(null, e.clientX, e.clientY);
        }}
      >
        {visible.map(({ entry, depth, ignored }): ReactNode => (
          <div
            key={entry.path}
            className={`study-tree-row${entry.is_dir ? "" : " study-tree-file"}${
              cursor === entry.path ? " cursor" : ""
            }${ignored ? " study-tree-row-ignored" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 + (entry.is_dir ? 0 : 12) }}
            title={entry.path}
            onClick={() => onRowClick(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation(); // 행 우클릭이 컨테이너(루트 대상)로 번지지 않게
              setCursor(entry.path);
              crud.openMenu(entry, e.clientX, e.clientY);
            }}
          >
            {entry.is_dir && <span className="study-tree-caret">{expanded.has(entry.path) ? "▾" : "▸"}</span>}
            <span className="study-tree-name">{entry.name}</span>
          </div>
        ))}
      </div>
      {crud.ui}
    </>
  );
}
