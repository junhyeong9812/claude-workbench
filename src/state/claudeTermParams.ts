/**
 * Claude 터미널 패널 params의 **1회성 필드** 규칙 — 순수 함수.
 *
 * 패널 params는 dockview 레이아웃에 직렬화돼 앱 재시작 후에도 살아난다. 그래서
 * "이번 한 번만" 뜻하는 필드(seed 주입, 인수 시 live 재검증)와 "계속 유지돼야
 * 하는" 필드(spawnCwd)를 반드시 갈라 둬야 한다. 섞이면 리마운트·재시작마다
 * 일회성 동작이 되살아난다.
 */

/** 이 모듈이 다루는 params 부분집합. */
export interface OpenParams {
  project?: string;
  /** PTY를 띄울 디렉토리 — **유지**(재시작 후에도 원 디렉토리에서 resume해야
   * 한다). */
  spawnCwd?: string;
  /** 인수 직전 live 재검증 요청 — **1회성**. */
  adoptPending?: boolean;
  /** 최초 1회 주입 프롬프트 — 1회성. */
  seed?: string;
  /** 스폰 때 못박을 모델 별칭(`--model`) — **유지**. 세션의 모델은 스폰 인자라
   * 나중에 못 바꾸므로(재스폰 = 대화 파기), 재시작 후에도 같은 모델로 다시
   * 떠야 "이 탭은 opus 탭"이라는 사용자의 기대가 유지된다. */
  model?: string;
  /** 스폰 때 못박을 추론 강도(`--effort`) — **유지**(model과 같은 이유).
   * 없거나 빈 값이면 백엔드가 플래그를 아예 붙이지 않는다. */
  effort?: string;
}

/** `claude_open_or_attach`에 보낼 cwd·adopt 인자. */
export function openArgs(
  params: OpenParams,
  project: string | null,
): { cwd: string | null; adopt: boolean } {
  return {
    cwd: params.spawnCwd ?? project,
    // spawnCwd로 유도하면 안 된다: 인수는 한 번 일어나는 사건이고, 그 뒤로 이
    // 세션은 앱 소유다. 계속 켜져 있으면 같은 디렉토리의 무관한 claude 하나가
    // 앱이 자기 세션을 여는 것까지 막는다(감사 B1).
    adopt: params.adoptPending === true,
  };
}

/** 세션이 열린 뒤 패널이 저장할 params — 나머지는 그대로 두고 1회성 필드만
 * 지운다(`undefined`는 JSON 직렬화에서 키째 사라진다 = 재시작 후에도 꺼짐). */
export function paramsAfterOpen<T extends OpenParams>(
  params: T,
  opened: { id: number; session_uuid: string },
): T & { sessionId: number; sessionUuid: string } {
  return {
    ...params,
    sessionId: opened.id,
    sessionUuid: opened.session_uuid,
    seed: undefined,
    adoptPending: undefined,
  };
}
