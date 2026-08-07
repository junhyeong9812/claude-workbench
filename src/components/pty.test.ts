import { describe, expect, it } from "vitest";
import {
  PENDING_MAX_CHARS,
  PTY_READY_SIGNAL,
  decodePtyData,
  makePtyReadyDetector,
  type PtyReadyDetector,
  ptyEventName,
  pushPendingCapped,
} from "./pty";

/** P3 특성테스트 — base64 왕복 무손실(손계산 픽스처)·pending 상한. */

describe("decodePtyData", () => {
  it("ASCII 왕복 — btoa 인코딩과 손계산 바이트 일치", () => {
    // "hi\n" = [104, 105, 10] → base64 "aGkK"
    expect(Array.from(decodePtyData("aGkK"))).toEqual([104, 105, 10]);
  });
  it("바이너리(0x00·0xFF·ESC) 무손실", () => {
    const bytes = [0x00, 0xff, 0x1b, 0x5b, 0x33, 0x31, 0x6d]; // \x00 \xff ESC[31m
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(decodePtyData(b64))).toEqual(bytes);
  });
  it("멀티바이트 UTF-8(한글) 바이트 시퀀스 보존", () => {
    const bytes = Array.from(new TextEncoder().encode("한글")); // ed 95 9c ea b8 80
    expect(bytes).toEqual([0xed, 0x95, 0x9c, 0xea, 0xb8, 0x80]); // 손계산 고정
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(decodePtyData(b64))).toEqual(bytes);
    expect(new TextDecoder().decode(decodePtyData(b64))).toBe("한글");
  });
  it("빈 payload → 빈 배열", () => {
    expect(decodePtyData("").length).toBe(0);
  });
});

describe("ptyEventName", () => {
  it("세션 id 스코프", () => {
    expect(ptyEventName(42)).toBe("terminal-output-42");
  });
});

describe("makePtyReadyDetector", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  /** 기본 호출은 live — 이 감지기의 본업이 실시간 스트림이라 테스트도 그렇게 읽힌다. */
  const live = (d: PtyReadyDetector, s: string) => d.push(enc(s), "live");
  const replay = (d: PtyReadyDetector, s: string) => d.push(enc(s), "replay");
  const ALT = "\x1b[?1049h";
  /** 실측(2026-08-07, claude 2.1.223)한 **신호 이전 전량** — 51바이트.
   * 준비 전에 오는 것이 이게 전부라, 여기서 ready가 뜨면 그것이 곧 오탐이다. */
  const PRELUDE = "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b[?2031h\x1b[>0q\x1b[c";

  it("신호 바이트는 ESC[?1049h (대체 화면 진입)", () => {
    expect(Array.from(PTY_READY_SIGNAL)).toEqual(Array.from(enc(ALT)));
    expect(PRELUDE.length).toBe(51); // 실측 고정
  });

  it("실측 프렐루드 51바이트 전체 — ready 없음(오탐 0)", () => {
    const d = makePtyReadyDetector();
    expect(live(d, PRELUDE)).toBe(false);
    expect(d.ready).toBe(false);
  });

  it("프렐루드 → 신호 청크 = 그 청크에서 ready", () => {
    const d = makePtyReadyDetector();
    expect(live(d, PRELUDE)).toBe(false);
    expect(live(d, `${ALT}\x1b[2J\x1b[H\x1b[?1000h`)).toBe(true);
    expect(d.ready).toBe(true);
  });

  it("청크 경계로 쪼개져 도착해도 잡는다 — 바이트 단위 전 분할", () => {
    const stream = `${PRELUDE}${ALT}rest`;
    for (let cut = 0; cut <= stream.length; cut++) {
      const d = makePtyReadyDetector();
      live(d, stream.slice(0, cut));
      live(d, stream.slice(cut));
      expect(d.ready).toBe(true);
    }
  });

  it("한 바이트씩 도착 — 신호 마지막 바이트에서 정확히 한 번 true", () => {
    const d = makePtyReadyDetector();
    const bytes = enc(`${PRELUDE}${ALT}`);
    const hits: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (d.push(bytes.subarray(i, i + 1), "live")) hits.push(i);
    }
    expect(hits).toEqual([bytes.length - 1]);
  });

  it("가짜 시작(ESC ESC[·중도 이탈) 뒤 진짜 신호 — 되감기 정확", () => {
    // ESC 뒤에 또 ESC: 되감기가 0이면 두 번째 ESC를 놓친다.
    expect(live(makePtyReadyDetector(), `\x1b${ALT}`)).toBe(true);
    // 중간까지 갔다가 이탈한 뒤 다시 시작.
    expect(live(makePtyReadyDetector(), `\x1b[?10${ALT}`)).toBe(true);
    // 접두사만 있고 끝나지 않으면 ready 아님.
    const d = makePtyReadyDetector();
    expect(live(d, "\x1b[?1049")).toBe(false);
    expect(d.ready).toBe(false);
    expect(live(d, "h")).toBe(true);
  });

  it("비슷하지만 다른 시퀀스는 무시 (?1049l 복귀·?1047h 구형)", () => {
    const d = makePtyReadyDetector();
    expect(live(d, "\x1b[?1049l\x1b[?1047h\x1b[?2004h")).toBe(false);
    expect(d.ready).toBe(false);
  });

  it("1회성 — 이후 신호가 또 와도 true는 한 번뿐", () => {
    const d = makePtyReadyDetector();
    expect(live(d, ALT)).toBe(true);
    expect(live(d, ALT)).toBe(false);
    expect(d.ready).toBe(true);
  });

  it("빈 청크는 상태를 바꾸지 않는다", () => {
    const d = makePtyReadyDetector();
    expect(d.push(new Uint8Array(0), "live")).toBe(false);
    expect(live(d, "\x1b[?1049")).toBe(false);
    expect(d.push(new Uint8Array(0), "live")).toBe(false);
    expect(live(d, "h")).toBe(true);
  });

  // ---- 재생분은 준비가 아니다 (codex P2) ----------------------------------

  it("**backfill에만** 신호가 있으면 ready 아님 — 이미 돌던 세션의 과거 진입", () => {
    // 실경로: 스크롤백 스냅샷에는 그 세션이 예전에 화면을 넘겨받을 때 쓴
    // ESC[?1049h가 그대로 들어 있다. 이걸 지금의 준비로 읽으면 권한 대화가 떠
    // 있든 말든 300ms 뒤 주입 = 고정 3000ms보다 이른 회귀.
    const d = makePtyReadyDetector();
    expect(replay(d, `${PRELUDE}${ALT}\x1b[2J\x1b[H과거 대화 내용…`)).toBe(false);
    expect(d.ready).toBe(false);
  });

  it("출처를 안 넘기면 replay 취급 — 기본값이 안전한 쪽", () => {
    const d = makePtyReadyDetector();
    expect(d.push(enc(ALT))).toBe(false);
    expect(d.ready).toBe(false);
  });

  it("backfill에 신호가 있어도 그 뒤 live 신호는 정상 인정(fast path 유지)", () => {
    const d = makePtyReadyDetector();
    replay(d, `${ALT}과거 화면`);
    expect(d.ready).toBe(false);
    expect(live(d, `${PRELUDE}${ALT}`)).toBe(true);
  });

  it("live 부분 일치가 재생분에 걸쳐 완성되지 않는다 — 이어진 바이트가 아니다", () => {
    // 드롭 갭 재스냅샷이 live 스트림 중간에 끼어드는 실경로. 앞뒤를 이어 붙여
    // 매칭하면 있지도 않은 신호를 만들어 낸다.
    const d = makePtyReadyDetector();
    expect(live(d, "\x1b[?1049")).toBe(false);
    expect(replay(d, "\x1bc")).toBe(false); // RIS
    expect(live(d, "h")).toBe(false); // 걸친 매칭 없음
    expect(d.ready).toBe(false);
    expect(live(d, ALT)).toBe(true); // 온전한 live 신호는 그대로 잡힌다
  });
});

describe("pushPendingCapped", () => {
  const ev = (data: string) => ({ data });
  it("상한 이하 — 전부 유지·dropped=false·토탈 누적", () => {
    const p: { data: string }[] = [];
    let r = pushPendingCapped(p, ev("aaaa"), 0, 10);
    r = pushPendingCapped(p, ev("bbbb"), r.total, 10);
    expect(p.map((x) => x.data)).toEqual(["aaaa", "bbbb"]);
    expect(r).toEqual({ total: 8, dropped: false });
  });
  it("초과 시 오래된 것부터 드롭 + dropped 신호 (손계산)", () => {
    const p: { data: string }[] = [];
    let r = pushPendingCapped(p, ev("aaaa"), 0, 10); // 4
    r = pushPendingCapped(p, ev("bbbb"), r.total, 10); // 8
    r = pushPendingCapped(p, ev("cccc"), r.total, 10); // 12 → "aaaa" 드롭 → 8
    expect(p.map((x) => x.data)).toEqual(["bbbb", "cccc"]);
    expect(r).toEqual({ total: 8, dropped: true });
  });
  it("단일 대형 청크도 전부 드롭 가능(상한 엄격 — 재스냅샷이 회수 전제)", () => {
    const p: { data: string }[] = [];
    const r = pushPendingCapped(p, ev("x".repeat(20)), 0, 10);
    expect(p.length).toBe(0);
    expect(r).toEqual({ total: 0, dropped: true });
  });
  it("기본 상한 상수 노출", () => {
    expect(PENDING_MAX_CHARS).toBeGreaterThan(0);
  });
});
