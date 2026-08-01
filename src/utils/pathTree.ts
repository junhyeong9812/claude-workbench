/**
 * 경로 목록 → 폴더 트리(trie) 빌더 (P4 공통화 — GitPanel의 buildTree(변경
 * 파일)와 rootTree(중첩 repo) 인라인이 동일 알고리즘이던 것의 단일 출처).
 *
 * 보존 계약(특성테스트 pathTree.test.ts): Map 삽입 순서 = 입력 순서(기존
 * 렌더 순서), 경로는 `/` 분할 + 빈 세그먼트 제거, 마지막 세그먼트 노드에
 * leaf 페이로드. 누적 path는 기존 두 구현(slice+join / rel 누적)과 동치.
 * 같은 경로가 두 번 오면 나중 leaf가 이긴다(기존과 동일).
 */
export interface PathNode<T> {
  name: string;
  /** 루트("")부터의 누적 상대 경로. */
  path: string;
  /** 이 노드가 항목의 끝 세그먼트일 때 그 페이로드. */
  leaf?: T;
  children: Map<string, PathNode<T>>;
}

export function buildPathTree<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
): PathNode<T> {
  const root: PathNode<T> = { name: "", path: "", children: new Map() };
  for (const item of items) {
    const parts = pathOf(item).split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          children: new Map(),
        };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.leaf = item;
      node = child;
    });
  }
  return root;
}
