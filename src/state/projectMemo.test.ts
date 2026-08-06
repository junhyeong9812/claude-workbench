import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMO_CLOSE_FLUSH_MS,
  MEMO_KIND,
  MEMO_SAVE_DELAY,
  clearStash,
  flushAllMemos,
  isMemoParams,
  makeAutoSaver,
  memoPanelId,
  openProjectMemo,
  registerMemoSaver,
  resetMemoSavers,
  resetStash,
  stashMemo,
  takeStash,
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

describe("stash — 저장 못 한 편집의 임시 보관", () => {
  beforeEach(() => resetStash());

  it("넣은 값을 꺼내면서 지운다 (한 번만 복구)", () => {
    stashMemo("/p", "못 저장한 글");
    expect(takeStash("/p")).toBe("못 저장한 글");
    expect(takeStash("/p")).toBeUndefined();
  });

  it("프로젝트별로 격리된다", () => {
    stashMemo("/a", "A");
    stashMemo("/b", "B");
    expect(takeStash("/b")).toBe("B");
    expect(takeStash("/a")).toBe("A");
  });

  it("빈 문자열도 보관된다 (메모 전체 지우기가 유실되면 안 된다)", () => {
    stashMemo("/p", "");
    expect(takeStash("/p")).toBe("");
  });

  it("clearStash는 저장이 성공했을 때 보관분을 버린다", () => {
    stashMemo("/p", "x");
    clearStash("/p");
    expect(takeStash("/p")).toBeUndefined();
  });
});

describe("flushAllMemos — 창 종료 경로 (React cleanup이 안 도는 곳)", () => {
  beforeEach(() => resetMemoSavers());
  afterEach(() => {
    resetMemoSavers();
    vi.useRealTimers();
  });

  it("등록된 저장기를 모두 flush하고 완료를 기다린다", async () => {
    const a = { flush: vi.fn().mockResolvedValue(undefined) };
    const b = { flush: vi.fn().mockResolvedValue(undefined) };
    registerMemoSaver(a);
    registerMemoSaver(b);
    await flushAllMemos();
    expect(a.flush).toHaveBeenCalledTimes(1);
    expect(b.flush).toHaveBeenCalledTimes(1);
  });

  it("해제된 저장기는 부르지 않는다 (언마운트된 패널)", async () => {
    const a = { flush: vi.fn().mockResolvedValue(undefined) };
    const off = registerMemoSaver(a);
    off();
    await flushAllMemos();
    expect(a.flush).not.toHaveBeenCalled();
  });

  it("등록된 게 없으면 즉시 끝난다 (닫기를 지연시키지 않는다)", async () => {
    await expect(flushAllMemos()).resolves.toBeUndefined();
  });

  it("하나가 실패해도 나머지는 저장되고 전체는 성공으로 끝난다", async () => {
    const bad = { flush: vi.fn().mockRejectedValue(new Error("디스크 오류")) };
    const good = { flush: vi.fn().mockResolvedValue(undefined) };
    registerMemoSaver(bad);
    registerMemoSaver(good);
    await expect(flushAllMemos()).resolves.toBeUndefined();
    expect(good.flush).toHaveBeenCalledTimes(1);
  });

  it("**상한을 넘기면 기다리지 않는다** — 메모 하나가 앱을 못 닫게 하면 안 된다", async () => {
    vi.useFakeTimers();
    const stuck = { flush: vi.fn().mockReturnValue(new Promise<void>(() => {})) };
    registerMemoSaver(stuck);
    let done = false;
    const p = flushAllMemos(1200).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1199);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("상한은 메인 창 닫기 예산 안에 들어간다 (ack 2.5s + flush < watchdog 4s)", () => {
    expect(MEMO_CLOSE_FLUSH_MS + 2500).toBeLessThan(4000);
  });
});

describe("makeAutoSaver — 디바운스 · flush · 유실 0", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("입력이 멎고 delay가 지나야 1회 저장한다", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, MEMO_SAVE_DELAY);
    s.schedule("a");
    vi.advanceTimersByTime(MEMO_SAVE_DELAY - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save.mock.calls).toEqual([["a"]]);
  });

  it("타이핑 버스트는 마지막 값 하나로 합쳐진다", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("a");
    vi.advanceTimersByTime(300);
    s.schedule("ab");
    vi.advanceTimersByTime(300);
    s.schedule("abc");
    vi.advanceTimersByTime(1000);
    expect(save.mock.calls).toEqual([["abc"]]);
  });

  it("저장이 **성공한 뒤에야** 대기 값이 비워진다 (같은 값 두 번 쓰지 않음)", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("a");
    vi.advanceTimersByTime(1000);
    // 요청은 나갔지만 아직 성공 응답 전 — 여전히 dirty다 (P2-2).
    expect(s.pending()).toBe(true);
    await Promise.resolve();
    expect(s.pending()).toBe(false);
    await s.flush();
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("**언마운트 flush: 디바운스 창 안에서 탭이 전환돼도 유실 0**", async () => {
    // dockview는 비활성 탭 패널을 언마운트한다 — 그 순간이 디바운스 창 안이면
    // 타이머는 클로저와 함께 사라지고 마지막 편집이 증발한다. flush가 그 창을
    // 막는 유일한 경로다 (핵심 불변식).
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("마지막 편집");
    vi.advanceTimersByTime(10); // 아직 디바운스 창 안
    expect(s.pending()).toBe(true);
    const done = s.flush(); // 언마운트 — save는 동기적으로 출발해야 한다
    expect(save.mock.calls).toEqual([["마지막 편집"]]);
    await done;
    expect(s.pending()).toBe(false);
  });

  it("flush는 타이머도 끈다 — flush 뒤 시간이 흘러도 재저장이 없다", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("x");
    await s.flush();
    vi.advanceTimersByTime(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("대기 값이 없으면 flush는 no-op (언마운트마다 빈 쓰기 금지)", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    await s.flush();
    await s.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("빈 문자열도 대기 값으로 취급한다 (메모 전체 지우기가 저장돼야 한다)", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver<string>(save, 1000);
    s.schedule("");
    expect(s.pending()).toBe(true);
    await s.flush();
    expect(save.mock.calls).toEqual([[""]]);
  });

  it("**저장 실패는 dirty를 유지한다** — 다음 flush가 재시도해 성공한다", async () => {
    // "저장 요청을 보냈다"를 "저장됐다"로 세면 실패한 편집이 조용히 사라진다
    // (리뷰 P2-2). 실패 후에도 값이 남아 있어야 재시도가 가능하다.
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("디스크 오류"))
      .mockResolvedValue(undefined);
    const s = makeAutoSaver<string>(save, 1000);
    s.schedule("잃으면 안 되는 글");
    await s.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.pending(), "실패했으니 여전히 dirty").toBe(true);
    expect(s.peek()).toBe("잃으면 안 되는 글");

    await s.flush(); // 재시도
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.pending(), "성공했으니 clean").toBe(false);
    expect(s.peek()).toBeUndefined();
  });

  it("저장 중 들어온 새 편집은 늦게 온 성공 응답에 지워지지 않는다", async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    const s = makeAutoSaver<string>(save, 1000);
    s.schedule("v1");
    void s.flush(); // v1 저장 시작 (아직 미완)
    s.schedule("v2"); // 저장 중 새 편집
    release(); // v1 저장 성공 응답이 뒤늦게 도착
    await Promise.resolve();
    await Promise.resolve();
    expect(s.pending(), "v2는 아직 저장 전이므로 dirty여야 한다").toBe(true);
    expect(s.peek()).toBe("v2");
  });

  it("저장은 직렬화된다 — 같은 파일에 동시 쓰기를 걸지 않는다", async () => {
    let live = 0;
    let peak = 0;
    const save = vi.fn().mockImplementation(async () => {
      live++;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
    });
    const s = makeAutoSaver<string>(save, 1000);
    s.schedule("a");
    void s.flush();
    s.schedule("b");
    void s.flush();
    await s.flush();
    expect(peak).toBe(1);
  });

  it("cancel은 저장하지 않고 버린다", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("버릴 값");
    s.cancel();
    expect(s.pending()).toBe(false);
    await s.flush();
    vi.advanceTimersByTime(10_000);
    expect(save).not.toHaveBeenCalled();
  });

  it("flush 후 다시 타이핑하면 새 디바운스가 정상 동작한다", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = makeAutoSaver(save, 1000);
    s.schedule("1");
    await s.flush();
    s.schedule("2");
    vi.advanceTimersByTime(1000);
    expect(save.mock.calls).toEqual([["1"], ["2"]]);
  });
});
