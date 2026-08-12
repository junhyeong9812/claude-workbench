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

  /* 아래 202 / 위 52 — 어느 쪽에도 260이 통째로 안 들어간다. 예전에는 아래로 두고
     `vh - h - margin`(=36)으로 클램프해 **트리거(60~90)를 통째로 덮었다**. 넓은
     쪽(아래)에 붙이고 그 공간으로 높이를 제한하는 것이 옳다. */
  it("어느 쪽에도 다 안 들어가면 넓은 쪽에 붙이고 트리거를 덮지 않는다", () => {
    const anchor = { left: 100, right: 140, top: 60, bottom: 90 };
    const p = computeAnchoredPosition(anchor, { width: 200, height: 260 }, { width: 1000, height: 300 });
    expect(p.top).toBe(94); // bottom(90) + gap(4) — 트리거 아래에서 시작
    expect(p.top).toBeGreaterThanOrEqual(anchor.bottom);
    expect(p.maxHeight).toBe(202); // 300 - 4 - 94 = 아래 가용 공간
  });

  /* 위 392 / 아래 68, 팝오버 420 — 부분 높이 flip. 전체가 들어갈 때만 뒤집던
     조건에서는 아래로 두고 top=76 으로 클램프돼 트리거(400~424)를 덮었다. */
  it("부분 높이여도 위가 더 넓으면 위로 뒤집는다(트리거를 덮지 않는다)", () => {
    const anchor = { left: 100, right: 140, top: 400, bottom: 424 };
    const p = computeAnchoredPosition(anchor, { width: 200, height: 420 }, { width: 1000, height: 500 }, {
      maxHeight: 420,
    });
    expect(p.maxHeight).toBe(392); // 위 가용 공간 = 400 - 4 - 4
    expect(p.top).toBe(4); // 400 - 4 - 392
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(anchor.top); // 트리거 위에서 끝난다
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
