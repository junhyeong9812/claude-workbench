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

/**
 * claude TUI가 **입력을 받기 시작했다**는 신호 — 대체 화면 진입 `ESC [ ? 1049 h`.
 *
 * **실측(2026-08-07, claude CLI 2.1.223, 실 PTY + 전사 `type=="user"` 판정)**.
 * 스폰 직후의 PTY는 바이트를 받고도 버린다(#74가 고정 지연을 1800→3000ms로
 * 올린 이유). 그 "받기 시작하는 순간"이 출력의 어디에 대응하는지 재 봤다.
 *
 * 시작~준비까지 PTY가 뱉는 것은 **51바이트의 터미널 모드 설정뿐**이고(6초 관측
 * 1060바이트 중 신호는 정확히 1회):
 *
 * ```text
 * ESC7 ESC[r ESC8 ESC[?25h · ESC[?25l ESC[?2004h ESC[?1004h ESC[?2031h · ESC[>0q ESC[c
 * ↑ t≈0.81s                  ↑ t≈0.87s                                  ↑ t≈0.91s
 *   … (JS 번들 로드 ~0.9s) …
 * ESC[?1049h ESC[2J ESC[H ESC[?1000h…   ← 이 신호. t≈1.59~2.12s
 * ```
 *
 * 즉 신호 **이전에는 배너도 스피너도 없다** — 오탐으로 삼을 출력 자체가 없고,
 * 신호는 관측 창 전체에서 한 번만 나온다(TUI가 화면을 넘겨받는 그 순간).
 *
 * 임계와의 순서(핵심):
 *
 * | 주입 시점 | 결과 |
 * |---|---|
 * | `ESC[?2004h` 직후 (t≈0.85s) | **NOT_SUBMITTED** 2/2 |
 * | 신호보다 0.37·0.27s 앞 | **NOT_SUBMITTED** 2/2 |
 * | 신호보다 0.12·0.11·0.05s 앞 | SUBMITTED 3/3 |
 * | **신호 직후(+0ms)** | **SUBMITTED 6/6** (실주입 1.67~2.12s) |
 * | **신호 +300ms** | **SUBMITTED 3/3** |
 *
 * 실제 임계는 신호보다 **120~270ms 앞**에 있다 — 신호는 언제나 임계 뒤이고,
 * 그 여유가 {@link SEED_READY_SETTLE}이 지키려는 마진이다.
 *
 * 같은 날 **고정 1.8s는 2/2 제출됐다** — #74에서 2/2 실패했던 그 값이다. 벽시계는
 * 기계·캐시 상태마다 움직이지만 이 신호는 그 세션의 실제 준비를 따라간다. 그것이
 * 고정 지연을 신호로 바꾸는 이유 전부다.
 *
 * 버전이 바뀌어 이 시퀀스가 사라지면 감지가 그냥 안 될 뿐이고, 주입은
 * {@link SEED_READY_DELAY} 폴백으로 예전과 똑같이 동작한다(조용히 더 일찍
 * 넣는 실패 모드는 만들지 않는다).
 */
export const PTY_READY_SIGNAL = new Uint8Array([
  0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68,
]); // ESC [ ? 1 0 4 9 h

/** PTY 출력 스트림에서 {@link PTY_READY_SIGNAL}을 찾는 1회성 감지기. */
export interface PtyReadyDetector {
  /** 청크 하나를 먹인다. **이 청크에서 신호가 처음 완성됐으면** true (이후
   * 호출은 항상 false — 준비는 한 번만 일어나는 사건이다). */
  push(bytes: Uint8Array): boolean;
  /** 지금까지 신호를 봤는가 (호출부가 뒤늦게 물어볼 수 있게 — 시드 예약이
   * 스크롤백 backfill보다 **뒤에** 오므로 이 조회가 필요하다). */
  readonly ready: boolean;
}

/**
 * 청크 경계를 가로지르는 매칭 — 신호가 `ESC[?1049` / `h`로 쪼개져 도착해도 잡는다.
 *
 * 이어 맞은 접두사 길이 하나만 들고 다닌다(꼬리 버퍼 없음). 불일치 시 0으로
 * 되감고 현재 바이트만 다시 보는 것이 **이 패턴에 한해** 정확하다: `ESC`(0x1b)가
 * 패턴의 0번에만 있어서 어떤 접두사의 진부분 접미사도 `ESC`로 시작할 수 없다 —
 * 즉 KMP border가 항상 0이다. (다른 신호로 바꾸려면 이 전제부터 다시 봐야 한다.)
 */
export function makePtyReadyDetector(signal: Uint8Array = PTY_READY_SIGNAL): PtyReadyDetector {
  let matched = 0;
  let ready = false;
  return {
    get ready() {
      return ready;
    },
    push(bytes: Uint8Array): boolean {
      if (ready) return false;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === signal[matched]) {
          matched++;
          if (matched === signal.length) {
            ready = true;
            return true;
          }
        } else {
          matched = bytes[i] === signal[0] ? 1 : 0;
        }
      }
      return false;
    },
  };
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
