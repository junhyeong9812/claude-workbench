import { describe, expect, it } from "vitest";
import { PENDING_MAX_CHARS, decodePtyData, ptyEventName, pushPendingCapped } from "./pty";

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
