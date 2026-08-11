/**
 * 아카이브 설정의 모델 선택지가 **공통 어휘 그대로**인지 못박는다.
 *
 * 아카이브 추출 모델은 원래 자기 목록을 들고 있었고, 지금은 새 세션 옵션 팝오버와
 * 같은 출처(`state/agentOptions` → `AgentOptionFields`)를 쓴다. 그래서 어휘가
 * 늘어나면(예: fable) 아카이브에도 **자동으로** 따라와야 한다 — 여기서 깨지는
 * 방식은 조용하다: 누군가 이 화면에 목록을 다시 하드코딩하면 아무 테스트도 실패하지
 * 않은 채 선택지만 낡는다.
 *
 * 그래서 `ModelSelect`를 따로 렌더하지 않고 **ArchivePanel을 실제로 띄워** 설정을
 * 연다. 하드코딩 회귀는 정확히 "이 화면이 무엇을 그리는가"의 문제라, 부품만 보면
 * 화면이 그 부품을 계속 쓰는지는 아무도 보증하지 않는다.
 *
 * 함께 못박는 것: 자유 입력("직접 입력…")은 아카이브에만 있는 선택지이고, 큐레이션
 * 목록이 늘어나도 사라지지 않는다(전체 모델명을 넣고 싶은 사용자의 유일한 길).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: async () => () => {} }),
}));

import { ArchivePanel } from "./ArchivePanel";
import { MODEL_CHOICES } from "../state/agentOptions";
import { useAppStore } from "../state/store";
import { SurfaceProvider } from "../state/surfaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("아카이브 설정 — 모델 선택지", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoke.mockResolvedValue([]); // archive_list — 빈 목록
    useAppStore.setState({ archiveRoot: null, archiveModel: null, archiveEffort: null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    invoke.mockReset();
  });

  /** 패널을 띄우고 [설정]을 눌러 모델 `<select>`를 돌려준다. */
  const openSettings = async (): Promise<HTMLSelectElement> => {
    await act(async () => {
      // P5: ArchivePanel은 표면 컨텍스트 안에서만 렌더된다(useSurfaceId — "이어서"를
      // 자기 표면 dock에 연다). 테스트도 SurfaceProvider로 감싼다.
      root.render(
        <SurfaceProvider surfaceId="primary" project="/repo">
          <ArchivePanel />
        </SurfaceProvider>,
      );
    });
    const settings = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "설정",
    );
    expect(settings, "[설정] 버튼").toBeTruthy();
    await act(async () => {
      settings!.click();
    });
    const sel = host.querySelector(".archive-settings select") as HTMLSelectElement | null;
    expect(sel, "모델 선택 select").toBeTruthy();
    return sel!;
  };

  it("공통 목록을 그대로 낸다 (fable·sonnet 포함)", async () => {
    const sel = await openSettings();
    const values = [...sel.querySelectorAll("option")].map((o) => o.value);
    expect(values).toEqual(["", ...MODEL_CHOICES, "custom"]);
    // 목록이 어디서 오는지가 요점 — 이 화면에 값을 직접 적으면 그게 곧 이중 출처다.
    expect(MODEL_CHOICES).toContain("fable");
    expect(MODEL_CHOICES).toContain("sonnet");
  });

  it("기본(미지정)과 자유 입력은 그대로 남는다", async () => {
    const sel = await openSettings();
    const opts = [...sel.querySelectorAll("option")];
    expect(opts[0].value, "빈 값 = 백엔드 기본(opus)").toBe("");
    expect(opts[0].textContent).toBe("기본 (opus)");
    expect(opts[opts.length - 1].value, "전체 모델명을 넣을 유일한 길").toBe("custom");
  });

  it("저장돼 있던 값이 목록에 있으면 그 값으로 열린다 (어휘 확장이 곧 반영)", async () => {
    useAppStore.setState({ archiveModel: "fable" });
    const sel = await openSettings();
    expect(sel.value).toBe("fable");
    // 큐레이션 값이므로 자유 입력 칸은 뜨지 않는다.
    expect(host.querySelectorAll(".archive-settings-row").length).toBe(3);
  });

  it("목록 밖 값은 자유 입력으로 열린다 (기존 저장값 의미 불변)", async () => {
    useAppStore.setState({ archiveModel: "claude-opus-4-8" });
    const sel = await openSettings();
    expect(sel.value).toBe("custom");
    const custom = host.querySelector(
      '.archive-settings input[placeholder^="예:"]',
    ) as HTMLInputElement | null;
    expect(custom?.value).toBe("claude-opus-4-8");
  });
});
