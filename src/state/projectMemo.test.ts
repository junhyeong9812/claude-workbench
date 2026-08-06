import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMO_KIND,
  MEMO_SAVE_DELAY,
  isMemoParams,
  makeAutoSaver,
  memoPanelId,
  openProjectMemo,
  type MemoDock,
} from "./projectMemo";
import { isEphemeralParams } from "./ephemeralPanels";

/** 최소 dock 스텁 — addPanel은 호출 인자를 기록하고 패널 목록에 반영한다. */
function fakeDock(initial: { id: string; params?: unknown }[] = []) {
  const added: Parameters<MemoDock["addPanel"]>[0][] = [];
  const setActive = vi.fn();
  type FakePanel = { id: string; params?: unknown; api: { setActive: () => void } };
  const panels: FakePanel[] = initial.map((p) => ({ ...p, api: { setActive } }));
  const dock: MemoDock = {
    getPanel: (id) => panels.find((p) => p.id === id),
    addPanel: (opts) => {
      added.push(opts);
      panels.push({ id: opts.id, params: opts.params, api: { setActive } });
      return null;
    },
  };
  return { dock, added, setActive };
}

describe("openProjectMemo — 프로젝트당 1개", () => {
  it("없으면 결정적 id로 연다", () => {
    const { dock, added } = fakeDock();
    expect(openProjectMemo(dock, "/home/u/repo")).toBe("opened");
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(memoPanelId("/home/u/repo"));
    expect(added[0].component).toBe(MEMO_KIND);
    expect(added[0].title).toBe("메모 — repo");
    expect(added[0].params).toMatchObject({ kind: MEMO_KIND, project: "/home/u/repo" });
    // 세션 종료 처리(claude_detach)는 params.sessionId로만 트리거된다 — 메모는
    // 세션을 소유하지 않으므로 그 키를 절대 갖지 않는다.
    expect(added[0].params).not.toHaveProperty("sessionId");
  });

  it("같은 프로젝트를 다시 열면 새로 만들지 않고 기존 패널을 포커스한다", () => {
    const { dock, added, setActive } = fakeDock();
    openProjectMemo(dock, "/home/u/repo");
    added.length = 0;
    expect(openProjectMemo(dock, "/home/u/repo")).toBe("focused");
    expect(added).toHaveLength(0);
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it("다른 프로젝트는 별도 패널", () => {
    const { dock, added } = fakeDock();
    openProjectMemo(dock, "/a/one");
    openProjectMemo(dock, "/b/two");
    expect(added.map((a) => a.id)).toEqual([memoPanelId("/a/one"), memoPanelId("/b/two")]);
  });
});

describe("isMemoParams", () => {
  it("kind로만 판정한다 (params 없음/형식 이상도 안전)", () => {
    expect(isMemoParams({ kind: MEMO_KIND })).toBe(true);
    expect(isMemoParams({ kind: "claudeterm" })).toBe(false);
    expect(isMemoParams(undefined)).toBe(false);
    expect(isMemoParams(null)).toBe(false);
    expect(isMemoParams("memo")).toBe(false);
  });

  it("메모는 단발성이 **아니다** — 레이아웃 복원으로 되살아난다", () => {
    // closeEphemeralPanels가 복원 직후 닫아 버리면 프로젝트 왕복마다 메모 탭이
    // 사라진다. 메모는 프로젝트에 딸린 문서라 부활이 정상 동작이다.
    expect(isEphemeralParams({ kind: MEMO_KIND })).toBe(false);
  });
});

describe("makeAutoSaver — 디바운스 · flush · 유실 0", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("입력이 멎고 delay가 지나야 1회 저장한다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, MEMO_SAVE_DELAY);
    s.schedule("a");
    vi.advanceTimersByTime(MEMO_SAVE_DELAY - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save.mock.calls).toEqual([["a"]]);
  });

  it("타이핑 버스트는 마지막 값 하나로 합쳐진다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("a");
    vi.advanceTimersByTime(300);
    s.schedule("ab");
    vi.advanceTimersByTime(300);
    s.schedule("abc");
    vi.advanceTimersByTime(1000);
    expect(save.mock.calls).toEqual([["abc"]]);
  });

  it("저장이 나가면 대기 값이 비워져 같은 값을 두 번 쓰지 않는다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("a");
    vi.advanceTimersByTime(1000);
    expect(s.pending()).toBe(false);
    s.flush();
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("**언마운트 flush: 디바운스 창 안에서 탭이 전환돼도 유실 0**", () => {
    // dockview는 비활성 탭 패널을 언마운트한다 — 그 순간이 디바운스 창 안이면
    // 타이머는 클로저와 함께 사라지고 마지막 편집이 증발한다. flush가 그 창을
    // 막는 유일한 경로다 (핵심 불변식).
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("마지막 편집");
    vi.advanceTimersByTime(10); // 아직 디바운스 창 안
    expect(s.pending()).toBe(true);
    s.flush(); // 언마운트
    expect(save.mock.calls).toEqual([["마지막 편집"]]);
    expect(s.pending()).toBe(false);
  });

  it("flush는 타이머도 끈다 — flush 뒤 시간이 흘러도 재저장이 없다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("x");
    s.flush();
    vi.advanceTimersByTime(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("대기 값이 없으면 flush는 no-op (언마운트마다 빈 쓰기 금지)", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.flush();
    s.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("빈 문자열도 대기 값으로 취급한다 (메모 전체 지우기가 저장돼야 한다)", () => {
    const save = vi.fn();
    const s = makeAutoSaver<string>(save, 1000);
    s.schedule("");
    expect(s.pending()).toBe(true);
    s.flush();
    expect(save.mock.calls).toEqual([[""]]);
  });

  it("cancel은 저장하지 않고 버린다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("버릴 값");
    s.cancel();
    expect(s.pending()).toBe(false);
    s.flush();
    vi.advanceTimersByTime(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it("flush 후 다시 타이핑하면 새 디바운스가 정상 동작한다", () => {
    const save = vi.fn();
    const s = makeAutoSaver(save, 1000);
    s.schedule("1");
    s.flush();
    s.schedule("2");
    vi.advanceTimersByTime(1000);
    expect(save.mock.calls).toEqual([["1"], ["2"]]);
  });
});
