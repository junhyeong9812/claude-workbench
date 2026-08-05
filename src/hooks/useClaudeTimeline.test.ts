import { describe, expect, it, vi } from "vitest";

// The module wires Tauri listeners inside its hooks; the pure helpers under test
// don't touch them, but importing the module must not pull the real IPC in.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { ctxOccupancy, ctxWindow, sumTokenTotals, type TokenUsage } from "./useClaudeTimeline";

const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  ...u,
});

// 훅 추출(ClaudeTermPanel → useClaudeTimeline)의 순수 부분 특성테스트: 헤더
// 토큰 합계·컨텍스트 게이지가 이동 전과 같은 값을 내는지 고정한다.
describe("sumTokenTotals — 세션 토큰 합계 (↑=input+cache_creation, ↓=output)", () => {
  it("턴별 usage를 합산한다", () => {
    expect(
      sumTokenTotals([
        [1, usage({ input: 100, output: 20, cache_creation: 5, cache_read: 999 })],
        [2, usage({ input: 10, output: 2, cache_creation: 1 })],
      ]),
    ).toEqual({ input: 116, output: 22 });
  });

  it("tokens 없음(구 스냅샷)은 0/0", () => {
    expect(sumTokenTotals(undefined)).toEqual({ input: 0, output: 0 });
    expect(sumTokenTotals([])).toEqual({ input: 0, output: 0 });
  });
});

describe("ctxOccupancy — 게이지 분자 = 마지막 assistant 메시지 점유", () => {
  it("input + cache_read + cache_creation", () => {
    expect(ctxOccupancy(usage({ input: 5, cache_read: 30, cache_creation: 7, output: 900 }))).toBe(42);
  });
  it("usage 없음 → 0 (게이지 숨김)", () => {
    expect(ctxOccupancy(null)).toBe(0);
    expect(ctxOccupancy(undefined)).toBe(0);
  });
});

describe("ctxWindow — 모델 id → 컨텍스트 창", () => {
  it("[1m]/-1m 변형은 1M", () => {
    expect(ctxWindow("claude-opus-5[1m]")).toBe(1_000_000);
    expect(ctxWindow("claude-sonnet-4-5-1m")).toBe(1_000_000);
  });
  it("그 외 claude 모델은 200k", () => {
    expect(ctxWindow("claude-fable-5")).toBe(200_000);
  });
  it("모르는/비-claude 모델은 0 — 지어낸 창 대신 게이지를 숨긴다", () => {
    expect(ctxWindow(null)).toBe(0);
    expect(ctxWindow(undefined)).toBe(0);
    expect(ctxWindow("gpt-4o")).toBe(0);
  });
});
