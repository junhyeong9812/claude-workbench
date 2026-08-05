/**
 * **단발성 패널** 공통 규칙 — 지금은 두 종류가 있다: 우측 타임라인 peek
 * (`state/timelinePeek`)와 프롬프트 정리 세션(`state/promptRefine`).
 *
 * 둘은 수명 계약을 공유하지만 **소유물이 다르다**. peek는 읽기 전용 뷰라 언제든
 * 버려도 잃을 게 없고, 정리 세션은 살아 있는 PTY와 사용자가 대화로 쌓은 초안을
 * 들고 있다. 그래서 규칙이 종류별로 갈라진다:
 *
 * - **재시작 부활 없음(공통)** — dockview `toJSON()`은 모든 패널을 담으므로 저장은
 *   된다. 막는 지점은 **복원 직후**다: `fromJSON` 뒤에
 *   {@link closeEphemeralPanels}가 즉시 닫는다(레이아웃 저장 구독 전에 호출하므로
 *   재저장도 유발하지 않는다). 저장을 막는 대신 복원을 막는 이유는 직렬화 blob을
 *   재구성하는 것보다 안전하고(그리드 트리를 손대지 않는다) 전송·팝아웃으로
 *   옮겨간 패널까지 같은 규칙으로 걸리기 때문.
 * - **창 간 이동(종류별)** — {@link closeIfEphemeralPanel}. peek는 그 자리에서
 *   **닫는다**(정확성 요건: 숫자 id↔uuid 매핑이 웹뷰 로컬이라 옮기면 죽은 화면이
 *   된다 — timelinePeek 참조). 정리 세션은 **전송만 취소한다**(리뷰 #12): 옮길 수
 *   없다는 이유로 사용자가 대화로 쌓은 초안을 파기하는 건 과한 대가다. 드래그가
 *   무시되고 패널은 제자리에 남는다.
 */
import { closePanelSession } from "./panelSession";
import { isPeekParams } from "./timelinePeek";
import { isRefineParams } from "./promptRefine";

/** 단발성 패널의 종류 — 규칙이 갈리는 축. 단발성이 아니면 null. */
export type EphemeralKind = "peek" | "refine";
export function ephemeralKindOf(params: unknown): EphemeralKind | null {
  if (isPeekParams(params)) return "peek";
  if (isRefineParams(params)) return "refine";
  return null;
}

/** 이 패널 params가 단발성인가 (복원 시 제거·전송 차단 대상). */
export function isEphemeralParams(params: unknown): boolean {
  return ephemeralKindOf(params) !== null;
}

/**
 * 단발성 패널의 창 간 이동을 막는다 — 반환 true = 전송 중단.
 *
 * peek는 닫고, 정리 세션은 **닫지 않고 취소만** 한다(모듈 주석 참조).
 */
export function closeIfEphemeralPanel(panel: {
  params?: unknown;
  api: { close(): void };
}): boolean {
  const kind = ephemeralKindOf(panel.params);
  if (kind === null) return false;
  if (kind === "peek") panel.api.close();
  return true;
}

/** 패널을 닫기 전에 그 세션을 놓아주는 기본 동작 (fire-and-forget). */
const detachSession = (params: unknown): void => {
  void closePanelSession(params as never, { closeIfLast: true });
};

/**
 * 복원된 레이아웃에서 단발성 패널을 전부 닫는다 (닫은 개수 반환).
 *
 * 정리 세션 패널은 **닫기 전에 detach**한다(리뷰 #11). 여기 오는 경로는 두 가지고
 * 둘의 필요가 다르다:
 *
 * - **프로젝트 전환 왕복** — dockview가 살아 있는 채로 다시 복원된다. 이때 패널이
 *   들고 있는 `sessionId`는 **진짜 살아 있는 PTY**를 가리키고, 이 호출은 세션
 *   종료를 담당하는 `onDidRemovePanel`이 아직 구독되기 **전**이라 그냥 닫으면
 *   정리 세션이 고아로 남아 계속 돈다. detach가 그 누수를 막는다.
 * - **앱 재시작 직후** — 같은 자리에서 stale한 옛 id로 detach를 부르게 되는데,
 *   백엔드 세션 카운터는 프로세스와 함께 리셋됐고 이 복원은 어떤 스폰보다도
 *   먼저다. 즉 그 id로 등록된 세션이 존재할 수 없어 no-op으로 끝난다 — 남의
 *   세션을 잘못 끊을 위험이 없는 근거가 바로 이 **순서**다.
 *
 * peek는 세션을 소유하지 않아(`params.sessionId` 없음) detach가 그대로 no-op이다.
 * `detach`를 인자로 받는 것은 테스트가 그 부작용을 관측하기 위해서다.
 */
export function closeEphemeralPanels(
  dock: { readonly panels: readonly { params?: unknown; api: { close(): void } }[] },
  detach: (params: unknown) => void = detachSession,
): number {
  let n = 0;
  for (const p of [...dock.panels]) {
    const kind = ephemeralKindOf(p.params);
    if (kind === null) continue;
    if (kind === "refine") detach(p.params);
    p.api.close();
    n++;
  }
  return n;
}
