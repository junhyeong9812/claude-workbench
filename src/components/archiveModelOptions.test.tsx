/**
 * 아카이브 설정의 모델 선택지가 **공통 어휘 그대로**인지 못박는다.
 *
 * 아카이브 추출 모델은 원래 자기 목록을 들고 있었고, 지금은 새 세션 옵션 팝오버와
 * 같은 출처(`state/agentOptions` → `AgentOptionFields`)를 쓴다. 그래서 어휘가
 * 늘어나면(예: fable) 아카이브에도 **자동으로** 따라와야 한다 — 여기서 깨지는
 * 방식은 조용하다: 누군가 이 화면에 목록을 다시 하드코딩하면 아무 테스트도 실패하지
 * 않은 채 선택지만 낡는다.
 *
 * 함께 못박는 것: 자유 입력("직접 입력…")은 아카이브에만 있는 선택지이고, 큐레이션
 * 목록이 늘어나도 사라지지 않는다(전체 모델명을 넣고 싶은 사용자의 유일한 길).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ModelSelect } from "./AgentOptionFields";
import { MODEL_CHOICES } from "../state/agentOptions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("아카이브 설정 — 모델 선택지", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** ArchivePanel의 호출 형태 그대로 (기본 라벨 + 자유 입력 허용). */
  const render = async (value = "") => {
    await act(async () => {
      root.render(
        <ModelSelect value={value} defaultLabel="기본 (opus)" allowCustom onChange={() => {}} />,
      );
    });
    return [...host.querySelectorAll("option")];
  };

  it("공통 목록을 그대로 낸다 (fable·sonnet 포함)", async () => {
    const opts = await render();
    expect(opts.map((o) => o.value)).toEqual(["", ...MODEL_CHOICES, "custom"]);
    // 목록이 어디서 오는지가 요점 — 여기 값을 직접 적으면 그게 곧 이중 출처다.
    expect(MODEL_CHOICES).toContain("fable");
    expect(MODEL_CHOICES).toContain("sonnet");
  });

  it("기본(미지정)과 자유 입력은 그대로 남는다", async () => {
    const opts = await render();
    expect(opts[0].value, "빈 값 = 백엔드 기본(opus)").toBe("");
    expect(opts[0].textContent).toBe("기본 (opus)");
    expect(opts[opts.length - 1].value, "전체 모델명을 넣을 유일한 길").toBe("custom");
  });

  it("저장돼 있던 값이 목록에 있으면 그 값이 선택된다", async () => {
    const opts = await render("sonnet");
    expect(opts.find((o) => o.selected)?.value).toBe("sonnet");
  });
});
