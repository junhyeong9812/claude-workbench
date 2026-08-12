import { describe, expect, it } from "vitest";
import { computeAnchoredPosition } from "./useAnchoredPosition";

/**
 * 팝오버 뷰포트 클램프(반응형 1차 인프라 C)의 경계 — 좁은 표면·창 가장자리에서
 * 화면 밖으로 나가지 않는가, 아래가 모자라면 위로 뒤집는가, 잔여 높이 상한은
 * 맞는가. 배지(B1)가 쓰던 값이 그대로 기본값이므로 이 테스트는 그 회귀도 겸한다.
 */

const VP = { width: 1000, height: 800 };
const POP = { width: 200, height: 120 };

describe("computeAnchoredPosition", () => {
  it("여유가 충분하면 트리거 좌변·바로 아래", () => {
    const p = computeAnchoredPosition(
      { left: 300, right: 340, top: 100, bottom: 120 },
      POP,
      VP,
    );
    expect(p.left).toBe(300);
    expect(p.top).toBe(124); // bottom + gap(4)
  });

  it("우측 가장자리 트리거는 뷰포트 안으로 클램프된다", () => {
    const p = computeAnchoredPosition(
      { left: 960, right: 995, top: 40, bottom: 60 },
      POP,
      VP,
    );
    // 1000 - 200 - 4
    expect(p.left).toBe(796);
  });

  it("좌측 가장자리에서도 음수 좌표가 되지 않는다", () => {
    const p = computeAnchoredPosition({ left: -30, right: 10, top: 40, bottom: 60 }, POP, VP);
    expect(p.left).toBe(4); // margin 하한
  });

  it("팝오버가 뷰포트보다 넓어도 margin 하한이 이긴다", () => {
    const p = computeAnchoredPosition(
      { left: 10, right: 50, top: 10, bottom: 30 },
      { width: 2000, height: 100 },
      { width: 300, height: 800 },
    );
    expect(p.left).toBe(4);
  });

  it("align:end 는 트리거 우변에 맞춘다", () => {
    const p = computeAnchoredPosition(
      { left: 500, right: 560, top: 100, bottom: 120 },
      POP,
      VP,
      { align: "end" },
    );
    expect(p.left).toBe(360); // 560 - 200
  });

  it("아래 공간이 부족하고 위가 넉넉하면 위로 뒤집는다", () => {
    const p = computeAnchoredPosition(
      { left: 100, right: 140, top: 700, bottom: 730 },
      POP,
      VP,
    );
    expect(p.top).toBe(576); // 700 - gap(4) - 120
  });

  it("위아래 모두 부족하면 뒤집지 않고 아래로 클램프한다", () => {
    const p = computeAnchoredPosition(
      { left: 100, right: 140, top: 60, bottom: 90 },
      { width: 200, height: 260 },
      { width: 1000, height: 300 },
    );
    // openUp 조건(위 여유 > margin) 불만족 → 아래 배치 후 vh - h - margin 클램프
    expect(p.top).toBe(36); // 300 - 260 - 4
  });

  it("maxHeight 는 상한과 잔여 공간 중 작은 쪽, 단 minHeight 아래로는 안 간다", () => {
    const roomy = computeAnchoredPosition(
      { left: 0, right: 40, top: 0, bottom: 20 },
      { width: 200, height: 1000 },
      VP,
    );
    expect(roomy.maxHeight).toBe(260); // 기본 상한

    const tight = computeAnchoredPosition(
      { left: 0, right: 40, top: 0, bottom: 20 },
      { width: 200, height: 1000 },
      { width: 1000, height: 200 },
    );
    // top 은 클램프로 아래로 밀리지만 잔여 높이가 minHeight(80) 아래면 하한 적용
    expect(tight.maxHeight).toBeGreaterThanOrEqual(80);
    expect(tight.maxHeight).toBeLessThanOrEqual(260);
  });

  it("gap/margin 을 바꾸면 그대로 반영된다", () => {
    const p = computeAnchoredPosition(
      { left: 300, right: 340, top: 100, bottom: 120 },
      POP,
      VP,
      { gap: 10, margin: 20 },
    );
    expect(p.top).toBe(130);
    expect(p.left).toBe(300);
  });
});
