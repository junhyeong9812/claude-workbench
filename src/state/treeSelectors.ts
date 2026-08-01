/**
 * 트리 파생 셀렉터/헬퍼 (리팩토링 P2 — 동작 보존 최적화, 순수 모듈).
 *
 * 보존 계약(특성테스트 treeSelectors.test.ts):
 * - expandedSetOf(s).has(p) ≡ 기존 `active.tree_state.expanded.includes(p)`
 *   (활성 프로젝트 없음/미확장 = false). 노드당 O(E) includes가 store set마다
 *   전 노드에서 돌던 것을, expanded 배열 identity 키 메모 Set의 O(1)로 대체.
 * - sameEntries: read_dir 결과 전 필드 동일성 — 폴링 리로드가 내용 무변화면
 *   기존 배열 identity를 유지해(스킵) 불필요 리렌더를 없애기 위한 판정.
 * - pruneTreeCache: 닫힌 프로젝트 루트 아래 키 제거, 단 남은 프로젝트/스터디
 *   폴더 아래는 보존(중첩 프로젝트 대비). 제거할 게 없으면 원본 identity 반환.
 */
import type { DirEntry } from "../types";

interface TreeStateSlice {
  projects: { path: string; tree_state: { expanded: string[] } }[];
  activeProject: string | null;
}

const EMPTY_EXPANDED: string[] = [];
let memoArr: readonly string[] = EMPTY_EXPANDED;
let memoSet: ReadonlySet<string> = new Set();

/** 활성 프로젝트의 expanded 목록을 lookup Set으로 (배열 identity 메모 — 같은
 * 배열이면 같은 Set 인스턴스). 셀렉터 안에서 매 store set마다 호출돼도 toggle
 * 시에만 재구축된다. */
export function expandedSetOf(s: TreeStateSlice): ReadonlySet<string> {
  const arr =
    s.projects.find((p) => p.path === s.activeProject)?.tree_state.expanded ?? EMPTY_EXPANDED;
  if (arr !== memoArr) {
    memoArr = arr;
    memoSet = new Set(arr);
  }
  return memoSet;
}

/** 두 read_dir 결과의 전 필드 동일성 (표시에 쓰이는 필드 전부). */
export function sameEntries(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.path !== y.path ||
      x.is_dir !== y.is_dir ||
      !!x.is_ignored !== !!y.is_ignored ||
      x.project_types.length !== y.project_types.length ||
      x.project_types.some((t, j) => t !== y.project_types[j])
    ) {
      return false;
    }
  }
  return true;
}

const under = (key: string, root: string) => key === root || key.startsWith(`${root}/`);

/** 닫힌 프로젝트 루트 아래의 캐시 키를 제거한다(F3 축출). keepRoots(남은
 * 프로젝트·스터디 폴더) 아래 키는 보존 — 중첩 프로젝트가 같은 경로를 공유할
 * 수 있다. 변화가 없으면 원본 객체 identity를 그대로 반환한다. */
export function pruneTreeCache<T>(
  cache: Record<string, T>,
  closedRoot: string,
  keepRoots: (string | null | undefined)[],
): Record<string, T> {
  const keeps = keepRoots.filter((r): r is string => !!r);
  const doomed = Object.keys(cache).filter(
    (k) => under(k, closedRoot) && !keeps.some((r) => under(k, r)),
  );
  if (doomed.length === 0) return cache;
  const next = { ...cache };
  for (const k of doomed) delete next[k];
  return next;
}
