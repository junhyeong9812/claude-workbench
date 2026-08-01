import { describe, expect, it } from "vitest";
import { resolveVisibleDual } from "./dualSurface";

const P = ["/a", "/b", "/c"];

describe("resolveVisibleDual", () => {
  it("정상: 다른 프로젝트 + 멤버십 충족 → 표시", () => {
    expect(resolveVisibleDual("/b", "/a", P)).toBe("/b");
  });
  it("동일 프로젝트 양쪽 금지 — 겹침 프레임 0 (D1)", () => {
    expect(resolveVisibleDual("/a", "/a", P)).toBeNull();
  });
  it("닫힌 프로젝트·hydration 전(빈 목록) → 숨김", () => {
    expect(resolveVisibleDual("/x", "/a", P)).toBeNull();
    expect(resolveVisibleDual("/b", "/a", [])).toBeNull();
  });
  it("마지막 프로젝트를 닫아 목록이 비면 우측도 숨김 (D7)", () => {
    expect(resolveVisibleDual("/b", null, [])).toBeNull();
  });
  it("dual 없음 → null", () => {
    expect(resolveVisibleDual(null, "/a", P)).toBeNull();
  });
});
