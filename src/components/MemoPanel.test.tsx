/**
 * 메모 패널의 **언마운트 유실 0** 실증 (load-bearing 가정 1).
 *
 * `makeAutoSaver` 단위 테스트는 "flush를 부르면 저장된다"까지만 보증한다. 여기서
 * 확인하는 건 그 위 한 칸 — 실제 패널이 dockview 탭 전환으로 언마운트될 때
 * **cleanup이 flush를 실제로 부르는가**다. dockview는 기본 renderer가
 * `onlyWhenVisible`이라 비활성 탭의 패널을 언마운트하고(리포 전체가 이 성질에
 * 기대고 있다 — ClaudeTermPanel "Mount = activation under onlyWhenVisible"),
 * React는 그때 effect cleanup을 부른다. 그래서 여기서는 진짜 MemoPanel을
 * 마운트했다가 언마운트하고 `memo_write`가 마지막 편집으로 나갔는지 본다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IDockviewPanelProps } from "dockview-react";
import { EditorView } from "codemirror";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { MemoPanel, type MemoParams } from "./MemoPanel";
import { MEMO_SAVE_DELAY } from "../state/projectMemo";

// CodeMirror measures its DOM; jsdom has no ResizeObserver.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom은 레이아웃이 없다 — CM6의 measure 단계가 Range.getClientRects를 부르면
// TypeError를 던진다(테스트는 통과하지만 stderr가 시끄러워져 진짜 실패를 가린다).
// 빈 사각형을 돌려주면 측정이 "보이는 게 없다"로 조용히 끝난다.
const emptyRects = Object.assign([] as unknown as DOMRectList, { item: () => null });
Range.prototype.getClientRects = () => emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();
// act(...) 경고 억제 — 이 파일은 실제로 act로 감싸고 있다.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** IDockviewPanelProps 중 MemoPanel이 실제로 쓰는 최소 표면. */
function panelProps(params: MemoParams): IDockviewPanelProps<MemoParams> {
  return {
    params,
    api: {
      isActive: true,
      onDidActiveChange: () => ({ dispose: () => {} }),
    },
  } as unknown as IDockviewPanelProps<MemoParams>;
}

/** 저장 호출만 추려낸다 (읽기 호출과 섞이지 않게). */
const writes = () =>
  invoke.mock.calls.filter((c) => c[0] === "memo_write").map((c) => c[1] as { text: string });

describe("MemoPanel — 언마운트 유실 0", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    // 자동 저장은 실제 IPC를 타므로 전부 목. 읽기는 저장된 본문을 돌려준다.
    invoke.mockImplementation((cmd: string) =>
      cmd === "memo_read"
        ? Promise.resolve({ text: "저장돼 있던 본문", hash: "h0" })
        : Promise.resolve({ status: "saved", hash: "h1" }),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    invoke.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** 패널을 마운트하고 CodeMirror가 붙을 때까지(=memo_read 해소) 기다린다. */
  const mount = async (project = "/home/u/repo") => {
    await act(async () => {
      root.render(<MemoPanel {...panelProps({ kind: "memo", project })} />);
    });
    const cm = host.querySelector(".cm-content") as HTMLElement | null;
    expect(cm, "CodeMirror가 마운트되어야 한다").toBeTruthy();
    return cm!;
  };

  /** 사용자가 타이핑한 것과 같은 문서 변경을 일으킨다. */
  const type = (cm: HTMLElement, text: string) => {
    // CodeMirror의 EditorView를 DOM에서 되찾아 트랜잭션을 넣는다 — 합성 키
    // 이벤트보다 확실하고, 우리가 검증하려는 건 입력 방식이 아니라 배관이다.
    const view = EditorView.findFromDOM(cm);
    expect(view, "EditorView를 찾아야 한다").toBeTruthy();
    act(() => {
      view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: text } });
    });
  };

  it("마운트하면 저장된 본문을 읽어 온다", async () => {
    await mount();
    expect(invoke).toHaveBeenCalledWith("memo_read", { project: "/home/u/repo" });
    expect(writes()).toEqual([]); // 읽기만으로 되쓰기가 일어나면 안 된다
  });

  it("타이핑 직후 언마운트해도(디바운스 창 안) 마지막 편집이 저장된다", async () => {
    vi.useFakeTimers();
    const cm = await mount();
    type(cm, "탭을 바로 전환한다");
    // 디바운스가 아직 안 끝난 상태 — 여기서 저장이 나가 있으면 안 된다.
    vi.advanceTimersByTime(MEMO_SAVE_DELAY - 1);
    expect(writes()).toEqual([]);
    // dockview 탭 전환 = 언마운트.
    act(() => root.unmount());
    expect(writes()).toEqual([{ project: "/home/u/repo", text: "탭을 바로 전환한다" }]);
    // 다시 render할 수 있도록 root를 되살린다 (afterEach의 unmount는 no-op).
    root = createRoot(host);
  });

  it("가만히 두면 디바운스 후 1회 저장한다 (언마운트로 중복되지 않는다)", async () => {
    vi.useFakeTimers();
    const cm = await mount();
    type(cm, "천천히 쓴 메모");
    act(() => {
      vi.advanceTimersByTime(MEMO_SAVE_DELAY);
    });
    expect(writes()).toEqual([{ project: "/home/u/repo", text: "천천히 쓴 메모" }]);
    act(() => root.unmount());
    expect(writes()).toHaveLength(1); // 언마운트 flush는 대기 값이 없으면 no-op
    root = createRoot(host);
  });

  it("편집이 없으면 언마운트가 빈 쓰기를 만들지 않는다", async () => {
    await mount();
    act(() => root.unmount());
    expect(writes()).toEqual([]);
    root = createRoot(host);
  });

  it("읽기 실패면 에디터를 만들지 않는다 — 빈 기반이 파일을 덮는 경로 차단", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "memo_read" ? Promise.reject(new Error("permission denied")) : Promise.resolve(),
    );
    await act(async () => {
      root.render(<MemoPanel {...panelProps({ kind: "memo", project: "/home/u/repo" })} />);
    });
    expect(host.querySelector(".cm-content"), "에디터가 없어야 한다").toBeNull();
    expect(host.querySelector(".memo-err")?.textContent).toContain("읽지 못했습니다");
    expect(writes()).toEqual([]);

    // 재시도 — 이번엔 성공하면 에디터가 뜬다.
    invoke.mockImplementation((cmd: string) =>
      cmd === "memo_read" ? Promise.resolve({ text: "돌아온 본문", hash: "h0" }) : Promise.resolve(),
    );
    const retry = host.querySelector(".memo-retry") as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => {
      retry.click();
    });
    expect(host.querySelector(".cm-content")?.textContent).toContain("돌아온 본문");
    expect(host.querySelector(".memo-err")).toBeNull();
  });

  it("프로젝트가 없으면 에디터를 만들지 않고 사유를 보여준다", async () => {
    await act(async () => {
      root.render(<MemoPanel {...panelProps({ kind: "memo" })} />);
    });
    expect(host.querySelector(".memo-err")?.textContent).toContain("프로젝트");
    expect(invoke).not.toHaveBeenCalled();
  });
});
