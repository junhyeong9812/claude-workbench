import { describe, it, expect } from "vitest";
import { errText } from "./error";

describe("errText", () => {
  it("passes a string error through", () => {
    expect(errText("boom")).toBe("boom");
    expect(errText("boom", "fallback")).toBe("boom");
  });

  it("uses .message of an Error / object", () => {
    expect(errText(new Error("nope"))).toBe("nope");
    expect(errText({ message: "obj msg" })).toBe("obj msg");
    expect(errText({ message: "obj msg" }, "fallback")).toBe("obj msg");
  });

  it("uses the fallback when there is no message", () => {
    expect(errText({}, "읽기 실패")).toBe("읽기 실패");
    expect(errText(null, "diff 실패")).toBe("diff 실패");
    expect(errText(undefined, "x")).toBe("x");
  });

  it("falls back to String(e) when no fallback is given", () => {
    expect(errText(42)).toBe("42");
    expect(errText(null)).toBe("null");
    expect(errText({})).toBe("[object Object]");
  });
});
