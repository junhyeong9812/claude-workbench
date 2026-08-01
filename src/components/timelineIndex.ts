/**
 * 타임라인 턴 인덱스 (리팩토링 P0 F1 — 동작 보존 최적화).
 *
 * 보존 계약(특성): 각 턴의 아이템 목록은 기존 렌더 경로의
 * `items.filter(x => x.turn === turn).sort((a, b) => a.seq - b.seq)` 와
 * **집합·순서 동일**해야 한다. JS의 filter(안정)+안정 sort와 같도록,
 * 삽입 순서를 유지한 뒤 seq 안정 정렬한다.
 *
 * 목적: 렌더마다 턴 수 × 전체 아이템(O(T×I))을 2회 훑던 것을, items 변경
 * 시 1회 O(I) 인덱스 빌드로 대체한다(nav 경로·렌더 경로 공유).
 */
export function groupItemsByTurn<T extends { turn: number; seq: number }>(
  items: readonly T[],
): Map<number, T[]> {
  const by = new Map<number, T[]>();
  for (const it of items) {
    const arr = by.get(it.turn);
    if (arr) arr.push(it);
    else by.set(it.turn, [it]);
  }
  for (const arr of by.values()) arr.sort((a, b) => a.seq - b.seq);
  return by;
}
