import { describe, expect, it, vi } from "vitest";
import { closeEphemeralPanels, closeIfEphemeralPanel, isEphemeralParams } from "./ephemeralPanels";
import { PEEK_KIND, peekPanelId } from "./timelinePeek";
import { REFINE_KIND, refinePanelId } from "./promptRefine";

const peek = (uuid: string) => ({ kind: PEEK_KIND, uuid });
const refine = (src: string) => ({
  // 정리 패널은 claudeterm 그대로다 — 표식은 refineKind 쪽에 있다.
  kind: "claudeterm",
  refineKind: REFINE_KIND,
  sessionId: 12,
  sourcePanelId: src,
});

describe("isEphemeralParams — 두 종류를 모두 단발성으로 본다", () => {
  it("peek·정리 세션은 true, 나머지는 false", () => {
    expect(isEphemeralParams(peek("u-1"))).toBe(true);
    expect(isEphemeralParams(refine("claudeterm-m-1-1"))).toBe(true);
    expect(isEphemeralParams({ kind: "claudeterm", sessionId: 7 })).toBe(false);
    expect(isEphemeralParams({ kind: "editor" })).toBe(false);
    expect(isEphemeralParams(undefined)).toBe(false);
    expect(isEphemeralParams(null)).toBe(false);
    expect(isEphemeralParams("promptrefine")).toBe(false);
  });
});

describe("closeEphemeralPanels — 복원 시 비부활", () => {
  it("복원된 레이아웃의 단발성 패널만 닫고 나머지는 둔다", () => {
    const closed: string[] = [];
    const mk = (id: string, params: unknown) => ({
      id,
      params,
      api: { close: () => closed.push(id) },
    });
    const panels = [
      mk("claudeterm-m-1-1", { kind: "claudeterm", sessionId: 7 }),
      mk(peekPanelId("u-1"), peek("u-1")),
      mk("editor-m-1-2", { kind: "editor" }),
      mk(refinePanelId("claudeterm-m-1-1"), refine("claudeterm-m-1-1")),
    ];
    expect(closeEphemeralPanels({ panels })).toBe(2);
    expect(closed).toEqual([peekPanelId("u-1"), refinePanelId("claudeterm-m-1-1")]);
  });

  it("단발성 패널이 없으면 아무것도 닫지 않는다", () => {
    const close = vi.fn();
    const panels = [{ id: "editor-m-1-2", params: { kind: "editor" }, api: { close } }];
    expect(closeEphemeralPanels({ panels })).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("closeIfEphemeralPanel — 창 간 전송 차단", () => {
  it("peek·정리 세션은 옮기지 않고 그 자리에서 닫는다(전송 중단 신호 true)", () => {
    for (const params of [peek("u-1"), refine("claudeterm-m-1-1")]) {
      const close = vi.fn();
      expect(closeIfEphemeralPanel({ params, api: { close } })).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it("일반 패널은 건드리지 않는다(전송 계속)", () => {
    const close = vi.fn();
    for (const params of [{ kind: "claudeterm", sessionId: 7 }, { kind: "editor" }, undefined]) {
      expect(closeIfEphemeralPanel({ params, api: { close } })).toBe(false);
    }
    expect(close).not.toHaveBeenCalled();
  });
});
