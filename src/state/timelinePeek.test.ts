import { describe, expect, it, vi } from "vitest";
import {
  PEEK_KIND,
  closeIfEphemeralPanel,
  closePeekPanels,
  isPeekParams,
  openTimelinePeek,
  peekPanelId,
  type PeekDock,
} from "./timelinePeek";

/** 최소 dock 스텁 — addPanel은 호출 인자를 기록하고 패널 목록에 반영한다. */
function fakeDock(initial: { id: string; params?: unknown }[] = []) {
  const added: Parameters<PeekDock["addPanel"]>[0][] = [];
  const setActive = vi.fn();
  const close = vi.fn();
  type FakePanel = { id: string; params?: unknown; api: { setActive: () => void; close: () => void } };
  const panels: FakePanel[] = initial.map((p) => ({ ...p, api: { setActive, close } }));
  const dock: PeekDock = {
    getPanel: (id) => panels.find((p) => p.id === id),
    addPanel: (opts) => {
      added.push(opts);
      panels.push({ id: opts.id, params: opts.params, api: { setActive, close } });
      return null;
    },
    panels,
  };
  return { dock, added, setActive, close, panels };
}

describe("openTimelinePeek — 우측 배치 · 세션당 1개", () => {
  const args = {
    sourcePanelId: "claudeterm-m-1-1",
    uuid: "u-1",
    project: "/repo",
    title: "작업 A",
  };

  it("없으면 결정적 id로 원 탭 오른쪽에 연다", () => {
    const { dock, added } = fakeDock([{ id: args.sourcePanelId, params: { kind: "claudeterm" } }]);
    expect(openTimelinePeek(dock, args)).toBe("opened");
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(peekPanelId("u-1"));
    expect(added[0].component).toBe(PEEK_KIND);
    expect(added[0].position).toEqual({
      referencePanel: args.sourcePanelId,
      direction: "right",
    });
    // 세션 종료 처리(claude_detach)는 params.sessionId로만 트리거된다 — peek는
    // 세션을 소유하지 않으므로 그 키를 절대 갖지 않는다.
    expect(added[0].params).not.toHaveProperty("sessionId");
    expect(added[0].params).toMatchObject({
      kind: PEEK_KIND,
      uuid: "u-1",
      project: "/repo",
      sourcePanelId: args.sourcePanelId,
    });
  });

  it("같은 세션을 다시 열면 새로 만들지 않고 기존 패널을 포커스한다", () => {
    const { dock, added, setActive } = fakeDock([
      { id: args.sourcePanelId, params: { kind: "claudeterm" } },
    ]);
    openTimelinePeek(dock, args);
    added.length = 0;
    expect(openTimelinePeek(dock, args)).toBe("focused");
    expect(added).toHaveLength(0);
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it("다른 세션은 별도 패널", () => {
    const { dock, added } = fakeDock([{ id: args.sourcePanelId, params: { kind: "claudeterm" } }]);
    openTimelinePeek(dock, args);
    openTimelinePeek(dock, { ...args, uuid: "u-2" });
    expect(added.map((a) => a.id)).toEqual([peekPanelId("u-1"), peekPanelId("u-2")]);
  });

  it("project 없음(활성 프로젝트 미확정)이면 params에서 생략한다", () => {
    const { dock, added } = fakeDock();
    openTimelinePeek(dock, { ...args, project: null });
    expect(added[0].params).not.toHaveProperty("project");
  });
});

describe("closePeekPanels — 복원 시 비부활", () => {
  it("복원된 레이아웃의 peek만 닫고 나머지는 둔다", () => {
    const { dock, panels } = fakeDock([
      { id: "claudeterm-m-1-1", params: { kind: "claudeterm", sessionId: 7 } },
      { id: peekPanelId("u-1"), params: { kind: PEEK_KIND, uuid: "u-1" } },
      { id: "editor-m-1-2", params: { kind: "editor" } },
      { id: peekPanelId("u-2"), params: { kind: PEEK_KIND, uuid: "u-2" } },
    ]);
    const closed: string[] = [];
    for (const p of panels) p.api.close = () => closed.push(p.id);
    expect(closePeekPanels(dock)).toBe(2);
    expect(closed).toEqual([peekPanelId("u-1"), peekPanelId("u-2")]);
  });

  it("peek가 없으면 아무것도 닫지 않는다", () => {
    const { dock, close } = fakeDock([{ id: "editor-m-1-2", params: { kind: "editor" } }]);
    expect(closePeekPanels(dock)).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("closeIfEphemeralPanel — 창 간 전송 차단", () => {
  it("peek는 옮기지 않고 그 자리에서 닫는다(전송 중단 신호 true)", () => {
    const close = vi.fn();
    const panel = { params: { kind: PEEK_KIND, uuid: "u-1" }, api: { close } };
    expect(closeIfEphemeralPanel(panel)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("일반 패널은 건드리지 않는다(전송 계속)", () => {
    const close = vi.fn();
    for (const params of [
      { kind: "claudeterm", sessionId: 7 },
      { kind: "editor" },
      undefined,
    ]) {
      expect(closeIfEphemeralPanel({ params, api: { close } })).toBe(false);
    }
    expect(close).not.toHaveBeenCalled();
  });
});

describe("isPeekParams", () => {
  it("kind로만 판정한다 (params 없음/형식 이상도 안전)", () => {
    expect(isPeekParams({ kind: PEEK_KIND })).toBe(true);
    expect(isPeekParams({ kind: "claudeterm" })).toBe(false);
    expect(isPeekParams(undefined)).toBe(false);
    expect(isPeekParams(null)).toBe(false);
    expect(isPeekParams("timelinepeek")).toBe(false);
  });
});
