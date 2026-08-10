/**
 * 메모 툴바의 **되돌릴 수 없는 두 순간**을 실증한다.
 *
 * ① [저장하기] — 프로젝트 안의 진짜 파일을 쓴다. 그래서 여기서 보는 건 "무엇을
 *   백엔드에 넘겼는가"와 **기존 파일이 확인 없이 덮이지 않는가**다(백엔드가
 *   `exists`로 되돌려주는 확인 턱이 UI에 실제로 뜨는가).
 * ② [정리] — AI 결과로 사용자의 글을 통째로 갈아 끼운다. 미리보기 전에는 한 글자도
 *   바뀌지 않아야 하고, 적용 뒤에는 직전 본문으로 1회 되돌아갈 수 있어야 한다.
 *   실패는 무해해야 한다(메모 불변 + 사유).
 *
 * 자동 저장(#72 유실 0)은 이 파일의 대상이 아니지만 **회귀는 여기서도 드러난다**:
 * 적용/되돌리기가 CodeMirror 트랜잭션을 타므로 `write`가 그 본문으로 나가야 한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "codemirror";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { MemoEditor, type MemoDoc, type MemoSaveResult } from "./MemoEditor";
import { resetStash } from "../state/projectMemo";
import { defaultMemoPath } from "../state/memoTools";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const emptyRects = Object.assign([] as unknown as DOMRectList, { item: () => null });
Range.prototype.getClientRects = () => emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "/home/u/repo";

describe("메모 툴바 — 저장하기 · 정리", () => {
  let host: HTMLDivElement;
  let root: Root;
  const writes: string[] = [];

  const read = async (): Promise<MemoDoc> => ({ text: "원래 메모", hash: "h0" });
  const write = async (_k: string, text: string): Promise<MemoSaveResult> => {
    writes.push(text);
    return { status: "saved", hash: "h1" };
  };

  beforeEach(() => {
    resetStash();
    localStorage.clear();
    writes.length = 0;
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    invoke.mockReset();
    vi.unstubAllGlobals();
  });

  // `null` = 저장 루트 없음. (`undefined`를 쓰면 기본 인자 ROOT로 되살아난다.)
  const mount = async (projectRoot: string | null = ROOT) => {
    await act(async () => {
      root.render(
        <MemoEditor
          storeKey="/home/u/repo"
          read={read}
          write={write}
          projectRoot={projectRoot ?? undefined}
        />,
      );
    });
    const cm = host.querySelector(".cm-content") as HTMLElement | null;
    expect(cm, "CodeMirror가 마운트되어야 한다").toBeTruthy();
    return cm!;
  };

  /** 라벨로 버튼을 찾는다 (클래스가 아니라 사용자가 보는 것으로). */
  const btn = (label: string): HTMLButtonElement => {
    const hit = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    expect(hit, `[${label}] 버튼이 있어야 한다`).toBeTruthy();
    return hit as HTMLButtonElement;
  };
  const has = (label: string) =>
    [...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
  const click = async (label: string) => {
    await act(async () => {
      btn(label).click();
    });
  };
  /** 경로 입력 — React가 값 변화를 인식하도록 네이티브 setter로 넣는다(제어
   * 컴포넌트는 자기가 쓴 값을 기억하고 있어 `input.value =`만으론 무시된다). */
  const setPath = async (v: string) => {
    const input = host.querySelector(".memo-save-path") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const docText = () =>
    EditorView.findFromDOM(host.querySelector(".cm-content") as HTMLElement)!.state.doc.toString();
  const exportCalls = () =>
    invoke.mock.calls.filter((c) => c[0] === "memo_export").map((c) => c[1] as Record<string, unknown>);

  it("저장 대상 루트가 없으면 [저장하기]를 아예 내지 않는다", async () => {
    await mount(null);
    expect(has("저장하기")).toBe(false);
    expect(has("정리"), "정리는 루트와 무관하다").toBe(true);
  });

  it("메모를 읽지 못했으면 툴바를 내지 않는다 — 빈 본문이 파일을 덮는 경로 차단", async () => {
    await act(async () => {
      root.render(
        <MemoEditor
          storeKey="/home/u/repo"
          read={async () => {
            throw new Error("permission denied");
          }}
          write={write}
          projectRoot={ROOT}
        />,
      );
    });
    expect(host.querySelector(".cm-content"), "에디터가 없다").toBeNull();
    expect(has("저장하기"), "저장할 본문이 없는데 저장 버튼이 있으면 안 된다").toBe(false);
    expect(has("정리")).toBe(false);
  });

  it("기본 제안 경로로 프로젝트 안에 저장한다", async () => {
    invoke.mockResolvedValue({ status: "saved", path: `${ROOT}/docs/x.md` });
    await mount();
    await click("저장하기");
    const input = host.querySelector(".memo-save-path") as HTMLInputElement;
    expect(input.value).toBe(defaultMemoPath());
    await click("저장");
    expect(exportCalls()).toEqual([
      { root: ROOT, rel: defaultMemoPath(), text: "원래 메모", overwrite: false },
    ]);
    expect(host.querySelector(".memo-note")?.textContent).toContain(defaultMemoPath());
    expect(host.querySelector(".memo-save"), "저장 후 폼은 닫힌다").toBeNull();
  });

  it("**기존 파일은 확인 없이 덮이지 않는다** — exists면 턱이 뜨고, 눌러야 덮는다", async () => {
    invoke.mockResolvedValueOnce({ status: "exists", path: `${ROOT}/a.md` });
    await mount();
    await click("저장하기");
    await setPath("a.md");
    await click("저장");
    // 확인 턱: 아직 아무것도 안 썼다(overwrite:false 1회뿐).
    expect(exportCalls()).toEqual([{ root: ROOT, rel: "a.md", text: "원래 메모", overwrite: false }]);
    expect(host.querySelector(".memo-save-warn")?.textContent).toContain("이미 있는 파일");
    expect(has("덮어쓰기")).toBe(true);

    invoke.mockResolvedValueOnce({ status: "saved", path: `${ROOT}/a.md` });
    await click("덮어쓰기");
    expect(exportCalls()[1]).toEqual({ root: ROOT, rel: "a.md", text: "원래 메모", overwrite: true });
    expect(host.querySelector(".memo-note")?.textContent).toContain("a.md");
  });

  it("프로젝트 밖 경로는 백엔드에 가기 전에 사유와 함께 막힌다", async () => {
    await mount();
    await click("저장하기");
    await setPath("../secret.md");
    await click("저장");
    expect(exportCalls(), "IPC가 나가면 안 된다").toEqual([]);
    expect(host.querySelector(".memo-save-err")?.textContent).toContain("..");
  });

  it("저장 실패는 폼을 닫지 않고 사유를 남긴다", async () => {
    invoke.mockRejectedValue({ message: "권한이 없습니다" });
    await mount();
    await click("저장하기");
    await click("저장");
    expect(host.querySelector(".memo-save"), "폼은 열린 채").toBeTruthy();
    expect(host.querySelector(".memo-save-err")?.textContent).toContain("권한이 없습니다");
  });

  it("정리는 미리보기까지만 — 적용 전에는 메모가 한 글자도 안 바뀐다", async () => {
    invoke.mockResolvedValue("정리된 메모");
    await mount();
    await click("정리");
    await click("정리 실행");
    // 기본 모델은 sonnet(공통 목록).
    expect(invoke).toHaveBeenCalledWith("memo_tidy", { text: "원래 메모", model: "sonnet" });
    expect(host.querySelector(".memo-tidy-preview")?.textContent).toBe("정리된 메모");
    expect(docText(), "미리보기는 메모를 건드리지 않는다").toBe("원래 메모");
    expect(writes, "저장도 나가지 않는다").toEqual([]);
  });

  it("[적용]은 메모를 교체하고, [되돌리기]는 직전 본문으로 1회 되돌린다", async () => {
    invoke.mockResolvedValue("정리된 메모");
    await mount();
    await click("정리");
    await click("정리 실행");
    await click("적용");
    expect(docText()).toBe("정리된 메모");
    expect(host.querySelector(".memo-tidy-preview"), "적용하면 미리보기는 닫힌다").toBeNull();
    // 교체는 평범한 편집과 같은 길을 탄다 — 자동 저장이 그 본문으로 나간다.
    await act(async () => {
      (host.querySelector(".cm-content") as HTMLElement).dispatchEvent(
        new FocusEvent("blur", { bubbles: true }),
      );
    });
    expect(writes).toEqual(["정리된 메모"]);

    await click("되돌리기");
    expect(docText()).toBe("원래 메모");
    // **1회**다 — 되돌린 뒤에는 버튼이 사라진다.
    expect(has("되돌리기")).toBe(false);
  });

  it("[버리기]는 결과만 버린다 (메모 불변)", async () => {
    invoke.mockResolvedValue("정리된 메모");
    await mount();
    await click("정리");
    await click("정리 실행");
    await click("버리기");
    expect(host.querySelector(".memo-tidy-preview")).toBeNull();
    expect(docText()).toBe("원래 메모");
    expect(has("되돌리기"), "적용한 적이 없으니 되돌릴 것도 없다").toBe(false);
  });

  it("정리 실패는 무해하다 — 메모 불변 + 사유", async () => {
    invoke.mockRejectedValue({ message: "claude 를 실행할 수 없습니다" });
    await mount();
    await click("정리");
    await click("정리 실행");
    expect(host.querySelector(".memo-save-err")?.textContent).toContain("claude");
    expect(docText()).toBe("원래 메모");
    expect(host.querySelector(".memo-tidy-preview")).toBeNull();
  });
});
