import { describe, expect, it, vi } from "vitest";

// The module wires Tauri listeners inside its hooks; the pure helpers under test
// don't touch them, but importing the module must not pull the real IPC in.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import {
  adoptInlineBodies,
  ctxOccupancy,
  ctxWindow,
  mergeSubagents,
  needsSubagentFetch,
  sumTokenTotals,
  type LazyAgentEntry,
  type SubagentFrame,
  type TokenUsage,
} from "./useClaudeTimeline";
import type { TimelineItem } from "../types";

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

// 메모리 1단계 B — 완료 서브에이전트 lazy 조회. 계약: payload에 본문이 없어도
// 헤더(진행도·상태)는 같은 값이고, 본문 미도착은 **표시로 드러난다**(무음 금지).
const it0 = (id: string): TimelineItem =>
  ({ tool_call_id: id, turn: 1, seq: 1, agent_status: "completed" }) as unknown as TimelineItem;

const frame = (f: Partial<SubagentFrame>): SubagentFrame => ({
  id: "a1",
  parent: null,
  turn: 3,
  total: 12,
  completed: 11,
  last_status: "completed",
  rev: 7,
  items: null,
  ...f,
});

describe("mergeSubagents — 프레임(메타) + lazy 본문 캐시 → 뷰 모델", () => {
  it("활성 프레임은 payload 본문을 그대로 쓴다(loaded)", () => {
    const its = [it0("x")];
    const [v] = mergeSubagents([frame({ items: its, total: 1, completed: 1 })], new Map());
    expect(v.items).toBe(its);
    expect([v.loaded, v.loading, v.failed]).toEqual([true, false, false]);
  });

  it("완료 프레임은 캐시 없으면 본문 없이(loaded=false) 메타만 — 진행도는 유지", () => {
    const [v] = mergeSubagents([frame({})], new Map());
    expect(v.items).toEqual([]);
    expect(v.loaded).toBe(false);
    expect([v.total, v.completed, v.lastStatus]).toEqual([12, 11, "completed"]);
  });

  it("같은 rev의 캐시가 있으면 본문이 붙는다 / 진행·실패 상태가 드러난다", () => {
    const its = [it0("y")];
    const ready = new Map<string, LazyAgentEntry>([["a1", { state: "ready", rev: 7, items: its }]]);
    expect(mergeSubagents([frame({})], ready)[0]).toMatchObject({ items: its, loaded: true });
    const loading = new Map<string, LazyAgentEntry>([["a1", { state: "loading", rev: 7 }]]);
    expect(mergeSubagents([frame({})], loading)[0]).toMatchObject({ loading: true, loaded: false });
    const err = new Map<string, LazyAgentEntry>([["a1", { state: "error", rev: 7 }]]);
    expect(mergeSubagents([frame({})], err)[0]).toMatchObject({ failed: true, loaded: false });
  });

  it("rev가 어긋난 캐시는 무시한다 — 재활성→재완료한 에이전트의 낡은 본문 표시 금지", () => {
    const stale = new Map<string, LazyAgentEntry>([
      ["a1", { state: "ready", rev: 6, items: [it0("old")] }],
    ]);
    const [v] = mergeSubagents([frame({ rev: 7 })], stale);
    expect(v.items).toEqual([]);
    expect(v.loaded).toBe(false);
  });
});

describe("needsSubagentFetch — 언제 조회하나", () => {
  it("활성 프레임(본문 인라인)은 조회하지 않는다", () => {
    expect(needsSubagentFetch(frame({ items: [it0("x")] }), undefined)).toBe(false);
  });
  it("캐시 없음 → 조회 / 같은 rev 캐시(진행·완료·실패) → 재조회 안 함", () => {
    expect(needsSubagentFetch(frame({}), undefined)).toBe(true);
    expect(needsSubagentFetch(frame({}), { state: "loading", rev: 7 })).toBe(false);
    expect(needsSubagentFetch(frame({}), { state: "ready", rev: 7, items: [] })).toBe(false);
    // 실패는 자동 재시도하지 않는다(폭주 방지) — 뷰의 "다시 시도"가 force로 뚫는다.
    expect(needsSubagentFetch(frame({}), { state: "error", rev: 7 })).toBe(false);
  });
  it("rev가 달라진 프레임은 다시 조회한다", () => {
    expect(needsSubagentFetch(frame({ rev: 8 }), { state: "ready", rev: 7, items: [] })).toBe(true);
  });
  it("프레임이 없으면 no-op", () => {
    expect(needsSubagentFetch(undefined, undefined)).toBe(false);
  });
});

describe("adoptInlineBodies — 활성 본문 승계(완료 전이 시 화면이 비지 않게)", () => {
  it("활성 프레임의 본문을 캐시에 넣고, 완료 전이 후에도 같은 rev로 살아남는다", () => {
    const its = [it0("x")];
    const live = frame({ items: its, rev: 9 });
    const cache = adoptInlineBodies([live], new Map());
    expect(cache.get("a1")).toEqual({ state: "ready", rev: 9, items: its });
    // 다음 emit에서 같은 에이전트가 완료 프레임(본문 없음)으로 와도 표시 유지.
    const [v] = mergeSubagents([frame({ items: null, rev: 9 })], cache);
    expect(v.items).toBe(its);
    expect(v.loaded).toBe(true);
  });

  it("완료 프레임은 승계 대상이 아니고, 변화가 없으면 같은 Map을 돌려준다", () => {
    const empty = new Map<string, LazyAgentEntry>();
    expect(adoptInlineBodies([frame({ items: null })], empty)).toBe(empty);
    const its = [it0("x")];
    const c1 = adoptInlineBodies([frame({ items: its, rev: 9 })], empty);
    // 같은 rev의 재수신은 캐시를 건드리지 않는다(불필요한 재렌더 방지).
    expect(adoptInlineBodies([frame({ items: its, rev: 9 })], c1)).toBe(c1);
    // rev가 오르면(본문 변경) 새 본문으로 교체.
    const its2 = [it0("x"), it0("y")];
    const c2 = adoptInlineBodies([frame({ items: its2, rev: 10 })], c1);
    expect(c2).not.toBe(c1);
    expect(c2.get("a1")).toEqual({ state: "ready", rev: 10, items: its2 });
  });
});
