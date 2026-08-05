import { describe, expect, it } from "vitest";
import { fmtAgo } from "./time";

/** 2026-08-05 12:00:00 KST 기준. now는 ms, 입력 t는 초. */
const NOW = 1_785_900_000_000;
const secAgo = (s: number) => Math.floor(NOW / 1000) - s;

describe("fmtAgo — 외부 세션의 '마지막 활동' 표기", () => {
  it("1분 미만은 '방금'", () => {
    expect(fmtAgo(secAgo(0), NOW)).toBe("방금");
    expect(fmtAgo(secAgo(59), NOW)).toBe("방금");
  });

  it("분·시간·일 단위로 올라간다", () => {
    expect(fmtAgo(secAgo(60), NOW)).toBe("1분 전");
    expect(fmtAgo(secAgo(59 * 60), NOW)).toBe("59분 전");
    expect(fmtAgo(secAgo(3600), NOW)).toBe("1시간 전");
    expect(fmtAgo(secAgo(23 * 3600), NOW)).toBe("23시간 전");
    expect(fmtAgo(secAgo(24 * 3600), NOW)).toBe("1일 전");
    expect(fmtAgo(secAgo(29 * 24 * 3600), NOW)).toBe("29일 전");
  });

  it("한 달을 넘기면 상대 표기 대신 날짜", () => {
    const old = fmtAgo(secAgo(400 * 24 * 3600), NOW);
    expect(old).not.toMatch(/전$/);
    expect(old).toMatch(/\d/);
  });

  it("빈 값은 빈 문자열 (0·null·undefined)", () => {
    expect(fmtAgo(undefined, NOW)).toBe("");
    expect(fmtAgo(null, NOW)).toBe("");
    expect(fmtAgo(0, NOW)).toBe("");
  });

  it("미래 시각(시계 어긋남)은 '방금'으로 접는다 — 음수 '전' 금지", () => {
    expect(fmtAgo(secAgo(-3600), NOW)).toBe("방금");
  });
});
