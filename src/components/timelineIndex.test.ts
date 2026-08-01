import { describe, expect, it } from "vitest";
import { groupItemsByTurn } from "./timelineIndex";

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
