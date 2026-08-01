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

/** base64 → 원시 바이트 (xterm write 입력). */
export function decodePtyData(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ready 전 수신 버퍼 상한(디코드 전 base64 문자 기준 ≈ 원시 바이트 ×1.33).
 * 초과 시 오래된 청크부터 드롭 — 스크롤백 상단 소실과 같은 의미(spec F3).
 * ready 전 한정이라 스냅샷 backfill(seq 게이트)이 정확성을 지킨다. */
export const PENDING_MAX_CHARS = 700 * 1024; // ≈ 512KB 원시 바이트

/** pending에 ev를 넣고 상한 초과분을 앞에서 드롭한다. 반환 = 새 총 문자수.
 * (호출부가 러닝 토탈을 유지 — 매 push O(n) 재계산 방지.) */
export function pushPendingCapped<T extends { data: string }>(
  pending: T[],
  ev: T,
  total: number,
  maxChars: number = PENDING_MAX_CHARS,
): number {
  pending.push(ev);
  let next = total + ev.data.length;
  while (next > maxChars && pending.length > 1) {
    const dropped = pending.shift()!;
    next -= dropped.data.length;
  }
  return next;
}
