import { describe, expect, it } from "vitest";
import { buildItemIndex, groupItemsByTurn, sliceRecentTurns } from "./timelineIndex";

/** P0 F1 특성테스트 — 기대값은 손계산(자기참조 금지). 추가로 기존 렌더
 * 경로의 naive filter+sort와의 동치를 같은 픽스처로 검증한다. */

interface It {
  turn: number;
  seq: number;
  id: string;
}
const item = (turn: number, seq: number, id: string): It => ({ turn, seq, id });

// 턴 섞임 + seq 역순 + 중복 seq(안정성 확인용, 삽입 역순) 픽스처.
const FIX: It[] = [
  item(2, 5, "a"),
  item(1, 3, "b"),
  item(2, 1, "c"),
  item(1, 3, "b2"), // seq 중복 — filter 안정성상 b 다음
  item(3, 9, "d"),
  item(1, 2, "e"),
];

const naive = (items: readonly It[], turn: number): It[] =>
  items.filter((x) => x.turn === turn).sort((a, b) => a.seq - b.seq);

describe("groupItemsByTurn", () => {
  it("손계산 기대값과 일치 (집합·순서·안정성)", () => {
    const by = groupItemsByTurn(FIX);
    expect(by.get(1)?.map((x) => x.id)).toEqual(["e", "b", "b2"]);
    expect(by.get(2)?.map((x) => x.id)).toEqual(["c", "a"]);
    expect(by.get(3)?.map((x) => x.id)).toEqual(["d"]);
    expect(by.get(4)).toBeUndefined();
  });

  it("기존 경로(naive filter+sort)와 전 턴 동치", () => {
    const by = groupItemsByTurn(FIX);
    for (const turn of [1, 2, 3]) {
      expect(by.get(turn)).toEqual(naive(FIX, turn));
    }
  });

  it("빈 입력 → 빈 인덱스", () => {
    expect(groupItemsByTurn([]).size).toBe(0);
  });
});

describe("sliceRecentTurns", () => {
  it("상한 이하는 전체·hidden 0", () => {
    expect(sliceRecentTurns([1, 2, 3], 30)).toEqual({ visible: [1, 2, 3], hiddenCount: 0 });
  });
  it("초과 시 최근 N턴만 + hidden 수", () => {
    const nos = Array.from({ length: 50 }, (_, i) => i + 1);
    const r = sliceRecentTurns(nos, 30);
    expect(r.visible.length).toBe(30);
    expect(r.visible[0]).toBe(21); // 오래된 20턴이 숨김
    expect(r.visible[29]).toBe(50);
    expect(r.hiddenCount).toBe(20);
  });
  it("limit<=0은 전체(방어)", () => {
    expect(sliceRecentTurns([1, 2], 0).visible).toEqual([1, 2]);
  });
});

describe("buildItemIndex", () => {
  interface P {
    tool_call_id: string;
    tag: string;
  }
  const p = (tool_call_id: string, tag: string): P => ({ tool_call_id, tag });

  it("flat().find 동치 — 중복 id는 main이 승리, 서브는 목록 순서", () => {
    const main = [p("dup", "main"), p("m2", "main")];
    const subs = [[p("dup", "subA"), p("s1", "subA")], [p("s1", "subB"), p("s2", "subB")]];
    const idx = buildItemIndex(main, subs);
    expect(idx.get("dup")?.tag).toBe("main"); // 기존 flat 순서상 main 먼저
    expect(idx.get("s1")?.tag).toBe("subA"); // 서브 간에도 먼저 온 목록 승리
    expect(idx.get("s2")?.tag).toBe("subB");
    expect(idx.get("none")).toBeUndefined();
  });
});
