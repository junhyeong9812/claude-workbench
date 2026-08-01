/**
 * PTY 이벤트 payload 헬퍼 (리팩토링 P3 — 순수 모듈, 특성테스트 pty.test.ts).
 *
 * 백엔드 `emit_terminal_output`(commands.rs)가 세션별 이벤트
 * `terminal-output-{id}`에 base64 `data`를 싣는다. 보존 계약: base64 왕복은
 * PTY 바이트를 1도 바꾸지 않는다(바이너리·멀티바이트 UTF-8 포함) — xterm은
 * 이전과 동일한 바이트 시퀀스를 받는다.
 */

/** 세션별 PTY 출력 이벤트명 — 백엔드 emit과 한 쌍. */
export const ptyEventName = (sessionId: number): string => `terminal-output-${sessionId}`;

/** base64 → 원시 바이트 (xterm write 입력). 손상 payload는 빈 배열 + 경고
 * (리스너 콜백 내부 throw로 청크 처리 자체가 죽는 것 방지 — 방어선). */
export function decodePtyData(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    console.warn("decodePtyData: invalid base64 payload dropped");
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ready 전 수신 버퍼 상한(디코드 전 base64 문자 기준 ≈ 원시 바이트 ×1.33).
 * 초과 시 오래된 청크부터 드롭 — 스크롤백 상단 소실과 같은 의미(spec F3).
 * ready 전 한정이라 스냅샷 backfill(seq 게이트)이 정확성을 지킨다. */
export const PENDING_MAX_CHARS = 700 * 1024; // ≈ 512KB 원시 바이트

/** pending에 ev를 넣고 상한 초과분을 앞에서 드롭한다. 반환 = 새 총 문자수와
 * 드롭 발생 여부. **드롭이 있었으면 호출부(패널)는 drain 직전 스냅샷을 다시
 * 떠야 한다** — 스냅샷 시각 이후 도착분이 드롭되면 "상단 소실"이 아니라
 * 스트림 중간 갭(ESC 절단 → 화면 손상)이 되기 때문(리뷰 P1/P2). 재스냅샷이
 * 갭을 잇는 전제라 단일 대형 청크도 전부 드롭 가능(0개까지). 호출부가 러닝
 * 토탈을 유지한다(매 push O(n) 재계산 방지). */
export function pushPendingCapped<T extends { data: string }>(
  pending: T[],
  ev: T,
  total: number,
  maxChars: number = PENDING_MAX_CHARS,
): { total: number; dropped: boolean } {
  pending.push(ev);
  let next = total + ev.data.length;
  let dropped = false;
  while (next > maxChars && pending.length > 0) {
    const evicted = pending.shift()!;
    next -= evicted.data.length;
    dropped = true;
  }
  return { total: next, dropped };
}
