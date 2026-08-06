/**
 * 초안 **편집 잠금**의 실증 (감사 I1).
 *
 * 순수 규칙(`refineMemoLocked`)은 "언제 잠글지"만 정한다. 여기서 보는 건 그 위
 * 한 칸 — 잠금이 CodeMirror에 실제로 걸리는가, 그리고 잠갔다 푸는 동안 **에디터가
 * 다시 만들어지지 않는가**다. 후자가 load-bearing이다: 에디터를 재생성하면
 * 커서·스크롤은 물론 아직 디스크에 못 들어간 편집(saver의 대기 값)이 함께
 * 날아가고, 그건 잠금이 막으려던 바로 그 유실이 된다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "codemirror";

import { MemoEditor, type MemoDoc, type MemoSaveResult } from "./MemoEditor";
import { resetStash } from "../state/projectMemo";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// jsdom에는 레이아웃이 없다 — CM6의 measure가 던지지 않도록 빈 사각형을 준다.
const emptyRects = Object.assign([] as unknown as DOMRectList, { item: () => null });
Range.prototype.getClientRects = () => emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** contenteditable 속성 — jsdom은 `contentEditable` **프로퍼티**를 반영하지
 * 않으므로 속성으로 읽는다(CM6가 쓰는 것도 이 속성이다). */
const editable = (v: EditorView) => v.contentDOM.getAttribute("contenteditable");

const read = async (): Promise<MemoDoc> => ({ text: "초안 본문", hash: "h0" });
const write = async (): Promise<MemoSaveResult> => ({ status: "saved", hash: "h1" });

describe("MemoEditor — 편집 잠금", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStash();
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = async (readOnly: boolean) => {
    await act(async () => {
      root.render(
        <MemoEditor
          storeKey="prompt-refine:panel-1"
          read={read}
          write={write}
          readOnly={readOnly}
          readOnlyNote="닫는 중 — 아카이브에 저장하고 있습니다"
        />,
      );
    });
    const cm = host.querySelector(".cm-content") as HTMLElement | null;
    expect(cm, "CodeMirror가 마운트되어야 한다").toBeTruthy();
    return EditorView.findFromDOM(cm!)!;
  };

  it("평상시엔 편집할 수 있다", async () => {
    const view = await render(false);
    expect(view.state.readOnly).toBe(false);
    expect(editable(view)).toBe("true");
    expect(host.querySelector(".memo-locked")).toBeNull();
  });

  it("잠그면 입력이 막히고 이유가 보인다", async () => {
    const view = await render(false);
    await render(true);
    // 두 축을 다 건다: readOnly는 편집 명령을, editable=false는 브라우저의
    // contenteditable 입력을 막는다. 하나만으로는 경로 하나가 열려 있다.
    expect(view.state.readOnly).toBe(true);
    expect(editable(view)).toBe("false");
    // 왜 안 써지는지 모르는 것이 최악이라 사유를 헤더에 남긴다.
    expect(host.querySelector(".memo-locked")?.textContent).toContain("닫는 중");
  });

  it("잠그고 푸는 동안 에디터가 다시 만들어지지 않는다 (대기 중인 편집 보존)", async () => {
    const view = await render(false);
    await render(true);
    await render(false);
    // 같은 EditorView 인스턴스 = 커서·스크롤·저장 대기 값이 그대로다.
    const after = EditorView.findFromDOM(host.querySelector(".cm-content") as HTMLElement);
    expect(after).toBe(view);
    expect(view.state.readOnly).toBe(false);
    expect(editable(view)).toBe("true");
    expect(view.state.doc.toString()).toBe("초안 본문");
  });
});
