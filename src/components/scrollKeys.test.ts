import { describe, it, expect, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { handleScrollKey } from "./scrollKeys";

function fakeScroller(init: Partial<HTMLElement> = {}): HTMLElement {
  return { scrollTop: 0, clientHeight: 100, scrollHeight: 1000, ...init } as unknown as HTMLElement;
}

function fakeEvent(key: string) {
  const preventDefault = vi.fn();
  return { e: { key, preventDefault } as unknown as KeyboardEvent, preventDefault };
}

describe("handleScrollKey", () => {
  it("ArrowDown/Up scroll by arrowStep (default 48) and consume the key", () => {
    const el = fakeScroller();
    const down = fakeEvent("ArrowDown");
    expect(handleScrollKey(down.e, el)).toBe(true);
    expect(el.scrollTop).toBe(48);
    expect(down.preventDefault).toHaveBeenCalledOnce();

    const up = fakeEvent("ArrowUp");
    expect(handleScrollKey(up.e, el)).toBe(true);
    expect(el.scrollTop).toBe(0);
  });

  it("PageDown/Up scroll by clientHeight * pageFactor (default 0.9)", () => {
    const el = fakeScroller({ clientHeight: 200 } as Partial<HTMLElement>);
    expect(handleScrollKey(fakeEvent("PageDown").e, el)).toBe(true);
    expect(el.scrollTop).toBe(180);
    expect(handleScrollKey(fakeEvent("PageUp").e, el)).toBe(true);
    expect(el.scrollTop).toBe(0);
  });

  it("respects custom arrowStep / pageFactor", () => {
    const el = fakeScroller({ clientHeight: 100 } as Partial<HTMLElement>);
    handleScrollKey(fakeEvent("ArrowDown").e, el, { arrowStep: 10 });
    expect(el.scrollTop).toBe(10);
    handleScrollKey(fakeEvent("PageDown").e, el, { pageFactor: 0.5 });
    expect(el.scrollTop).toBe(60);
  });

  it("Home/End are off by default (return false, no scroll, no preventDefault)", () => {
    const el = fakeScroller({ scrollTop: 500 } as Partial<HTMLElement>);
    const home = fakeEvent("Home");
    expect(handleScrollKey(home.e, el)).toBe(false);
    expect(el.scrollTop).toBe(500);
    expect(home.preventDefault).not.toHaveBeenCalled();

    const end = fakeEvent("End");
    expect(handleScrollKey(end.e, el)).toBe(false);
    expect(el.scrollTop).toBe(500);
  });

  it("Home/End jump to top/bottom when homeEnd is enabled", () => {
    const el = fakeScroller({ scrollTop: 500, scrollHeight: 1000 } as Partial<HTMLElement>);
    expect(handleScrollKey(fakeEvent("Home").e, el, { homeEnd: true })).toBe(true);
    expect(el.scrollTop).toBe(0);
    expect(handleScrollKey(fakeEvent("End").e, el, { homeEnd: true })).toBe(true);
    expect(el.scrollTop).toBe(1000);
  });

  it("returns false for a null scroller and does not throw", () => {
    expect(handleScrollKey(fakeEvent("ArrowDown").e, null)).toBe(false);
  });

  it("returns false for keys it does not handle (no preventDefault)", () => {
    const el = fakeScroller();
    const other = fakeEvent("a");
    expect(handleScrollKey(other.e, el)).toBe(false);
    expect(el.scrollTop).toBe(0);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});
