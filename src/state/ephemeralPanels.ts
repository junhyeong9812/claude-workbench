/**
 * **단발성 패널** 공통 규칙 — 지금은 두 종류가 있다: 우측 타임라인 peek
 * (`state/timelinePeek`)와 프롬프트 정리 세션(`state/promptRefine`).
 *
 * 둘은 목적도 내용도 다르지만 수명 계약이 같다:
 *
 * - **재시작 부활 없음** — dockview `toJSON()`은 모든 패널을 담으므로 저장은 된다.
 *   막는 지점은 **복원 직후**다: `fromJSON` 뒤에 {@link closeEphemeralPanels}가
 *   즉시 닫는다(레이아웃 저장 구독 전에 호출하므로 재저장도 유발하지 않는다).
 *   저장을 막는 대신 복원을 막는 이유는 직렬화 blob을 재구성하는 것보다 안전하고
 *   (그리드 트리를 손대지 않는다) 전송·팝아웃으로 옮겨간 패널까지 같은 규칙으로
 *   걸리기 때문.
 * - **창 간 이동 없음** — 옮기려 하면 그 자리에서 닫는다
 *   ({@link closeIfEphemeralPanel}). peek은 정확성 요건(숫자 id↔uuid 매핑이 웹뷰
 *   로컬이라 옮기면 죽은 화면이 된다 — timelinePeek 참조), 정리 세션은 원본 탭
 *   옆에 붙어 있어야 [적용]의 대상이 성립한다는 요건.
 *
 * 규칙이 한 곳에만 있도록 판정 술어는 각 모듈이 소유하고 여기서 합친다.
 */
import { isPeekParams } from "./timelinePeek";
import { isRefineParams } from "./promptRefine";

/** 이 패널 params가 단발성인가 (복원 시 제거·전송 차단 대상). */
export function isEphemeralParams(params: unknown): boolean {
  return isPeekParams(params) || isRefineParams(params);
}

/** 단발성 패널이면 그 자리에서 닫는다 (반환 true = 전송 중단). */
export function closeIfEphemeralPanel(panel: {
  params?: unknown;
  api: { close(): void };
}): boolean {
  if (!isEphemeralParams(panel.params)) return false;
  panel.api.close();
  return true;
}

/** 복원된 레이아웃에서 단발성 패널을 전부 닫는다 (닫은 개수 반환). */
export function closeEphemeralPanels(dock: {
  readonly panels: readonly { params?: unknown; api: { close(): void } }[];
}): number {
  let n = 0;
  for (const p of [...dock.panels]) {
    if (!isEphemeralParams(p.params)) continue;
    p.api.close();
    n++;
  }
  return n;
}
