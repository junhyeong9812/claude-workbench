/**
 * 반응형 접기(인프라 B)의 계약 실증.
 *
 * 두 가지가 핵심이다:
 *  (a) **증거 없으면 안 접는다** — 폭을 못 재는 환경(ResizeObserver 부재·폭 0)
 *      에서는 항상 base(펼친) 렌더. 넓은 폭 회귀 0의 근거.
 *  (b) 임계 미만이면 seg는 `<select>`로, 보조 버튼군은 "⋯" 하나로 접히되
 *      **동작(onChange·자식 핸들러)은 그대로**다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CollapsibleControls, CollapsibleSeg, shouldCollapse } from "./CollapsibleControls";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** host 행 폭을 고정하고 ResizeObserver를 즉시 1회 콜백하는 대역으로 세운다. */
function stubWidth(width: number) {
  const orig = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = orig;
  };
}

const SEG = [
  { id: "memo", label: "메모" },
  { id: "timeline", label: "타임라인" },
  { id: "term", label: "터미널" },
] as const;

describe("shouldCollapse", () => {
  it("임계 미만이면 접는다", () => {
    expect(shouldCollapse(500, 720)).toBe(true);
    expect(shouldCollapse(719.5, 720)).toBe(true);
  });
  it("임계 이상이면 안 접는다", () => {
    expect(shouldCollapse(720, 720)).toBe(false);
    expect(shouldCollapse(1200, 720)).toBe(false);
  });
  it("폭 0(측정 불가)은 절대 접지 않는다 — 넓은 폭 렌더 보존", () => {
    expect(shouldCollapse(0, 720)).toBe(false);
    expect(shouldCollapse(-1, 720)).toBe(false);
  });
});

describe("CollapsibleSeg / CollapsibleControls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    restore?.();
    restore = null;
  });

  it("측정 수단이 없으면 base(세그 버튼) 렌더 그대로다", () => {
    let picked = "";
    act(() => {
      root.render(
        <div>
          <CollapsibleSeg
            threshold={720}
            items={SEG}
            value="memo"
            onChange={(v) => (picked = v)}
            ariaLabel="정리 패널 뷰"
          />
        </div>,
      );
    });
    expect(host.querySelector("select")).toBeNull();
    const btns = [...host.querySelectorAll("button.seg-item")];
    expect(btns.map((b) => b.textContent)).toEqual(["메모", "타임라인", "터미널"]);
    expect(btns[0].getAttribute("aria-pressed")).toBe("true");
    act(() => (btns[1] as HTMLButtonElement).click());
    expect(picked).toBe("timeline");
  });

  it("host가 임계보다 좁으면 select로 접히고 선택은 그대로 전달된다", () => {
    restore = stubWidth(500);
    let picked = "";
    act(() => {
      root.render(
        <div>
          <CollapsibleSeg
            threshold={720}
            items={SEG}
            value="memo"
            onChange={(v) => (picked = v)}
            ariaLabel="정리 패널 뷰"
          />
        </div>,
      );
    });
    const sel = host.querySelector("select") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(host.querySelector("button.seg-item")).toBeNull();
    expect([...sel.options].map((o) => o.value)).toEqual(["memo", "timeline", "term"]);
    expect(sel.value).toBe("memo");
    act(() => {
      sel.value = "term";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picked).toBe("term");
  });

  it("넓으면 보조 버튼군을 그대로, 좁으면 ⋯ 하나로 접는다", () => {
    const render = () =>
      root.render(
        <div>
          <CollapsibleControls threshold={560} label="추가 컨트롤">
            <button className="a">아카이브</button>
            <button className="b">시드 재주입</button>
          </CollapsibleControls>
        </div>,
      );

    act(render);
    expect(host.querySelectorAll("button.a, button.b")).toHaveLength(2);
    expect(host.querySelector("button.collapse-more")).toBeNull();

    act(() => root.unmount());
    restore = stubWidth(400);
    root = createRoot(host);
    act(render);
    expect(host.querySelectorAll("button.a, button.b")).toHaveLength(0);
    const more = host.querySelector("button.collapse-more") as HTMLButtonElement;
    expect(more).not.toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("⋯를 열면 원래 자식이 포털 메뉴에 그대로 살아 있다(핸들러 보존)", () => {
    restore = stubWidth(400);
    let clicked = 0;
    act(() => {
      root.render(
        <div>
          <CollapsibleControls threshold={560} label="추가 컨트롤">
            <button className="a" onClick={() => (clicked += 1)}>
              아카이브
            </button>
          </CollapsibleControls>
        </div>,
      );
    });
    const more = host.querySelector("button.collapse-more") as HTMLButtonElement;
    act(() => more.click());
    const menu = document.querySelector(".collapse-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("data-popover-layer")).toBe("");
    const inner = menu.querySelector("button.a") as HTMLButtonElement;
    act(() => inner.click());
    expect(clicked).toBe(1);
    // 항목을 누르면 메뉴는 닫힌다.
    expect(document.querySelector(".collapse-menu")).toBeNull();
  });
});
