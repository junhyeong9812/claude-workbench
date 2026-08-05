import { describe, expect, it, vi } from "vitest";
import {
  closeEphemeralPanels,
  closeIfEphemeralPanel,
  ephemeralKindOf,
  isEphemeralParams,
} from "./ephemeralPanels";
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

describe("closeEphemeralPanels — 복원 시 비부활 + 정리 세션 detach", () => {
  const mkDock = (rows: { id: string; params: unknown }[], closed: string[]) => ({
    panels: rows.map((r) => ({ ...r, api: { close: () => closed.push(r.id) } })),
  });

  it("복원된 레이아웃의 단발성 패널만 닫고 나머지는 둔다", () => {
    const closed: string[] = [];
    const dock = mkDock(
      [
        { id: "claudeterm-m-1-1", params: { kind: "claudeterm", sessionId: 7 } },
        { id: peekPanelId("u-1"), params: peek("u-1") },
        { id: "editor-m-1-2", params: { kind: "editor" } },
        { id: refinePanelId("claudeterm-m-1-1"), params: refine("claudeterm-m-1-1") },
      ],
      closed,
    );
    expect(closeEphemeralPanels(dock, () => {})).toBe(2);
    expect(closed).toEqual([peekPanelId("u-1"), refinePanelId("claudeterm-m-1-1")]);
  });

  it("정리 세션은 **닫기 전에** detach된다 (프로젝트 전환 왕복 시 PTY 고아화 방지)", () => {
    const events: string[] = [];
    const params = refine("claudeterm-m-1-1");
    const dock = {
      panels: [
        {
          id: refinePanelId("claudeterm-m-1-1"),
          params,
          api: { close: () => events.push("close") },
        },
      ],
    };
    closeEphemeralPanels(dock, (p) => {
      expect(p).toBe(params);
      events.push("detach");
    });
    expect(events).toEqual(["detach", "close"]);
  });

  it("peek는 세션을 소유하지 않으므로 detach하지 않는다", () => {
    const detached: unknown[] = [];
    const dock = mkDock([{ id: peekPanelId("u-1"), params: peek("u-1") }], []);
    closeEphemeralPanels(dock, (p) => detached.push(p));
    expect(detached).toEqual([]);
  });

  it("단발성 패널이 없으면 아무것도 닫지 않는다", () => {
    const close = vi.fn();
    const panels = [{ id: "editor-m-1-2", params: { kind: "editor" }, api: { close } }];
    expect(closeEphemeralPanels({ panels }, () => {})).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("closeIfEphemeralPanel — 창 간 전송: peek는 파기, 정리 세션은 취소", () => {
  it("peek는 옮기지 않고 그 자리에서 닫는다(전송 중단 true)", () => {
    const close = vi.fn();
    expect(closeIfEphemeralPanel({ params: peek("u-1"), api: { close } })).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("정리 세션은 전송만 취소하고 **닫지 않는다** — 초안을 파기하지 않는다", () => {
    const close = vi.fn();
    expect(
      closeIfEphemeralPanel({ params: refine("claudeterm-m-1-1"), api: { close } }),
    ).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("일반 패널은 건드리지 않는다(전송 계속)", () => {
    const close = vi.fn();
    for (const params of [{ kind: "claudeterm", sessionId: 7 }, { kind: "editor" }, undefined]) {
      expect(closeIfEphemeralPanel({ params, api: { close } })).toBe(false);
    }
    expect(close).not.toHaveBeenCalled();
  });
});

describe("ephemeralKindOf", () => {
  it("종류를 구분해 돌려준다", () => {
    expect(ephemeralKindOf(peek("u-1"))).toBe("peek");
    expect(ephemeralKindOf(refine("claudeterm-m-1-1"))).toBe("refine");
    expect(ephemeralKindOf({ kind: "claudeterm", sessionId: 7 })).toBeNull();
    expect(ephemeralKindOf(undefined)).toBeNull();
  });
});
