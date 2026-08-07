/**
 * codex 타임라인 공급의 순수부 — 백엔드 페이로드가 화면 상태가 되는 변환.
 *
 * 여기서 고정하는 것 두 가지: ①컨텍스트 창은 **전사가 알려 준 값**을 쓴다
 * (claude 모델명 매칭인 `ctxWindow()`는 codex 모델에서 항상 0이라 게이지가
 * 조용히 죽는다 — survey R1-7) ②아이템은 seq 순서로 정렬해 넘긴다.
 */
import { describe, expect, it } from "vitest";
import { stateFromSnapshot, type CodexRolloutSnapshot } from "./useCodexTimeline";
import { ctxWindow } from "./useClaudeTimeline";
import type { TimelineItem } from "../types";

const item = (id: string, seq: number): TimelineItem => ({
  turn: 1,
  session_id: "s",
  tool_call_id: id,
  seq,
  kind: "execute",
  title: id,
  locations: [],
  project_label: null,
  diffs: [],
  content_text: null,
  raw_input: null,
  agent_status: "completed",
  write_status: "none",
  revision: 0,
});

const snap = (over: Partial<CodexRolloutSnapshot> = {}): CodexRolloutSnapshot => ({
  session_id: "019f",
  cwd: "/proj",
  items: [],
  turns: [[1, "질문"]],
  answers: [[1, "답변"]],
  dates: [[1, "2026-08-07"]],
  tokens: [[1, { input: 100, output: 20, cache_read: 900, cache_creation: 0 }]],
  model: "gpt-5.6-sol",
  effort: "high",
  context_window: 258400,
  last_usage: { input: 100, output: 20, cache_read: 900, cache_creation: 0 },
  lines: 10,
  bad_lines: 0,
  skipped: [],
  ...over,
});

describe("stateFromSnapshot", () => {
  it("컨텍스트 창은 전사가 준 값을 쓴다 (claude 모델명 매칭은 codex에서 0이다)", () => {
    const s = stateFromSnapshot(snap(), "/r/a.jsonl");
    expect(ctxWindow("gpt-5.6-sol")).toBe(0); // 대조군 — 그래서 이 경로가 필요하다
    expect(s.ctxWindow).toBe(258400);
    expect(s.ctxTokens).toBe(1000); // input + cache_read + cache_creation
  });

  it("창을 모르는 전사면 게이지가 숨는다 (0을 지어내지 않는다)", () => {
    expect(stateFromSnapshot(snap({ context_window: null }), null).ctxWindow).toBe(0);
  });

  it("아이템은 seq 순으로 정렬해 넘긴다", () => {
    const s = stateFromSnapshot(snap({ items: [item("b", 2), item("a", 0), item("c", 1)] }), null);
    expect(s.items.map((i) => i.tool_call_id)).toEqual(["a", "c", "b"]);
  });

  it("대화·토큰·모델이 그대로 실린다", () => {
    const s = stateFromSnapshot(snap(), "/r/a.jsonl");
    expect(s.status).toBe("matched");
    expect(s.note).toBeNull();
    expect(s.path).toBe("/r/a.jsonl");
    expect(s.turns.get(1)).toBe("질문");
    expect(s.answers.get(1)).toBe("답변");
    expect(s.dates.get(1)).toBe("2026-08-07");
    // 세션 합계는 새로 처리한 입력(input + cache_creation)과 출력.
    expect(s.tokenTotal).toEqual({ input: 100, output: 20 });
    expect(s.model).toBe("gpt-5.6-sol");
    expect(s.effort).toBe("high");
  });

  it("파싱 이상은 상태에 남는다 (조용히 삼키지 않는다)", () => {
    const s = stateFromSnapshot(snap({ bad_lines: 3, skipped: [["event_msg/new_thing", 2]] }), null);
    expect(s.badLines).toBe(3);
    expect(s.skipped).toEqual([["event_msg/new_thing", 2]]);
  });
});
