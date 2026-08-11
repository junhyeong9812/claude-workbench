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
const EMPTY_SET: ReadonlySet<string> = new Set();
/** 프로젝트별 배열-identity 메모 (P5 F2 — 두 표면이 서로 다른 프로젝트 트리를
 * 동시에 조회하므로 단일 홀더는 서로를 thrash한다). key=프로젝트 경로. */
const expandedMemo = new Map<string, { arr: readonly string[]; set: ReadonlySet<string> }>();

/** **한 프로젝트의** expanded 목록을 lookup Set으로 (배열 identity 메모 — 같은
 * 배열이면 같은 Set 인스턴스). `project` 생략 시 활성 프로젝트(하위호환). 셀렉터
 * 안에서 매 store set마다 호출돼도 toggle 시에만 재구축된다.
 *
 * **P5 F2**: 프로젝트를 인자로 받는다 — FolderTree가 자기 표면 프로젝트를 넘겨
 * 각 트리가 **자기 프로젝트의** 확장 상태를 읽는다(부 표면 확장이 주 프로젝트
 * 확장을 오염시키지 않게).
 * 계약: expanded 배열은 **절대 in-place 변경 금지**(toggleExpandedFor는 항상 새
 * 배열 생성) — push 한 줄이면 이 메모가 조용히 stale해진다(리뷰 P3). */
export function expandedSetOf(s: TreeStateSlice, project?: string | null): ReadonlySet<string> {
  const proj = project === undefined ? s.activeProject : project;
  if (proj == null) return EMPTY_SET;
  const arr = s.projects.find((p) => p.path === proj)?.tree_state.expanded ?? EMPTY_EXPANDED;
  if (arr === EMPTY_EXPANDED) return EMPTY_SET;
  const cached = expandedMemo.get(proj);
  if (cached && cached.arr === arr) return cached.set;
  const set = new Set(arr);
  expandedMemo.set(proj, { arr, set });
  return set;
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

/** childrenCache 엔트리 상한 (P5 F-g — P2 이관 'F3 후반'). 초과 시 keep-set
 * 밖(접힌·비표시 dir)만 축출 — 재확장 시 loadChildren이 다시 읽으므로 표시
 * 회귀 없음. */
export const TREE_CACHE_MAX = 400;

/** 축출 금지 집합: 열린 프로젝트 루트+확장 dir, 스터디 폴더 루트+확장 dir —
 * "표시 중이거나 즉시 표시될 수 있는" dir 전부. 이 밖의 캐시는 편의 사본. */
export function computeTreeKeepSet(
  projects: { path: string; tree_state: { expanded: string[] } }[],
  studyFolders: { left: string | null; right: string | null },
  studyExpanded: Record<string, string[]>,
): Set<string> {
  const keep = new Set<string>();
  for (const p of projects) {
    keep.add(p.path);
    for (const d of p.tree_state.expanded) keep.add(d);
  }
  for (const r of [studyFolders.left, studyFolders.right]) if (r) keep.add(r);
  for (const dirs of Object.values(studyExpanded)) for (const d of dirs) keep.add(d);
  return keep;
}

/** 상한 강제: size ≤ max면 원본 identity 그대로, 초과면 keep 밖 키를 순서대로
 * 지워 max 이하로. keep 키는 절대 축출하지 않는다(초과 잔존 허용 — 표시 우선). */
export function capTreeCache<T>(
  cache: Record<string, T>,
  keep: ReadonlySet<string>,
  max: number = TREE_CACHE_MAX,
): Record<string, T> {
  const keys = Object.keys(cache);
  if (keys.length <= max) return cache;
  const next = { ...cache };
  let size = keys.length;
  let deleted = 0;
  for (const k of keys) {
    if (size <= max) break;
    if (keep.has(k)) continue;
    delete next[k];
    size--;
    deleted++;
  }
  // 실제 삭제 0(keep만으로 초과)이면 원본 identity — 호출부의 epoch 연동이
  // "축출 발생"과 정확히 동치가 되게(감사: 아니면 keep 초과 상태에서 매 쓰기
  // 마다 전 in-flight 무효화 폭주).
  return deleted === 0 ? cache : next;
}

/** key가 root 자신이거나 그 아래인가 (구분자 `/`·`\` 둘 다 + root의 후행
 * 구분자 정규화 — Windows·"C:\\"·"/xx/" 형태 대비, 리뷰 #7·감사 개선). */
export const underRoot = (key: string, root: string) => {
  const r = root.replace(/[\\/]+$/, "");
  return key === root || key === r || key.startsWith(`${r}/`) || key.startsWith(`${r}\\`);
};

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
    (k) => underRoot(k, closedRoot) && !keeps.some((r) => underRoot(k, r)),
  );
  if (doomed.length === 0) return cache;
  const next = { ...cache };
  for (const k of doomed) delete next[k];
  return next;
}
