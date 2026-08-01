/**
 * 타임라인 턴 인덱스 (리팩토링 P0 F1 — 동작 보존 최적화).
 *
 * 보존 계약(특성): 각 턴의 아이템 목록은 기존 렌더 경로의
 * `items.filter(x => x.turn === turn).sort((a, b) => a.seq - b.seq)` 와
 * **집합·순서 동일**해야 한다. JS의 filter(안정)+안정 sort와 같도록,
 * 삽입 순서를 유지한 뒤 seq 안정 정렬한다.
 *
 * 목적: 렌더마다 턴 수 × 전체 아이템(O(T×I))을 2회 훑던 것을, items 변경
 * 시 1회 O(I + Σ nₜ log nₜ) 인덱스 빌드로 대체한다(nav·렌더 경로 공유).
 *
 * 전제(리뷰 명시): items/subagents는 payload 수신마다 **새 배열로 교체**된다
 * (백엔드 직렬화 결과) — in-place 변이는 memo를 stale하게 만든다.
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

/**
 * tool_call_id → item 인덱스 (P0 F2). 보존 계약: 기존
 * `[items, ...subLists].flat().find(id)` 와 동일한 우선순위 — 본 items 먼저,
 * 그다음 서브 목록 순서·각 배열 순서. "먼저 넣은 것 유지"가 first-match와
 * 동치(특성테스트: 중복 id는 main 승리).
 */
/**
 * 최근 N턴만 렌더 (P1 렌더 캡 — 전체 가상화의 전 단계). 잘린 턴은 "접힘"이
 * 아니라 미렌더 — nav도 화면과 일치해야 하므로 nav·렌더가 같은 목록을 쓴다.
 * turnNos는 오름차순 전제(호출부 sort).
 */
export function sliceRecentTurns(
  turnNos: readonly number[],
  limit: number,
): { visible: number[]; hiddenCount: number } {
  if (limit <= 0 || turnNos.length <= limit) {
    return { visible: [...turnNos], hiddenCount: 0 };
  }
  return { visible: turnNos.slice(-limit), hiddenCount: turnNos.length - limit };
}

export function buildItemIndex<T extends { tool_call_id: string }>(
  items: readonly T[],
  subItemLists: readonly (readonly T[])[],
): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) if (!m.has(it.tool_call_id)) m.set(it.tool_call_id, it);
  for (const its of subItemLists) {
    for (const it of its) if (!m.has(it.tool_call_id)) m.set(it.tool_call_id, it);
  }
  return m;
}
