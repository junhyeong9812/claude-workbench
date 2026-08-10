/**
 * 터미널·알림 설정의 **진입점 이동**(T3) + 리뷰 V1·V2·V3 계약 실증.
 *
 * 옮긴 것은 여는 자리뿐이라, 이 테스트가 붙잡는 것은 두 갈래다:
 *   (a) 저장·적용 경로가 예전 그대로인가 — 스토어 → localStorage `termColors`
 *       → xtermTheme 병합.
 *   (b) 래퍼 층이 지어야 할 계약 — 창당 모달 하나(V2), 포커스 이동·Escape·
 *       트리거 복원·role/aria-modal(V2), 모달 안 키가 바깥으로 안 샘(V1),
 *       트리거가 사라져도 모달이 살아남음(V3의 팝오버 링크 경로).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(() => undefined),
}));

import {
  TermSettingsButton,
  TermSettingsLayer,
  __resetTermSettingsForTest,
} from "./TermSettingsButton";
import { useAppStore } from "../state/store";
import { TERM_PRESETS, xtermTheme } from "./xtermTheme";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 클릭 + 마이크로태스크 flush — 모달이 뜰 때 도는 알림 권한 조회(비동기
 * effect)까지 act 안에서 정착시킨다. */
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const key = async (el: Element, k: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
};

/** 라벨이 정확히 일치하는 버튼 (프리셋 이름 = 버튼 텍스트). */
const findButton = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

const modal = () => document.querySelector(".term-settings");
const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');

describe("터미널·알림 설정 진입점 (T3)", () => {
  let host: HTMLDivElement;
  let root: Root;
  /** 모달 밖(React 조상)이 키를 받았는지 — V1 회귀 감시. */
  let outerKeys: string[];

  const Harness = ({ triggers = 1, showTrigger = true }: { triggers?: number; showTrigger?: boolean }) => (
    <div onKeyDown={(e) => outerKeys.push(e.key)}>
      {showTrigger &&
        Array.from({ length: triggers }, (_, i) => (
          <TermSettingsButton key={i} className={`gear-${i}`} />
        ))}
      <TermSettingsLayer />
    </div>
  );

  const render = async (props: { triggers?: number; showTrigger?: boolean } = {}) => {
    await act(async () => root.render(<Harness {...props} />));
  };

  beforeEach(() => {
    outerKeys = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    __resetTermSettingsForTest();
    useAppStore.getState().setTermColors(null);
  });

  it("클릭 전에는 모달이 없고, 클릭하면 열린다", async () => {
    await render();
    expect(modal()).toBeNull();
    const gear = host.querySelector("button.gear-0")!;
    // 아이콘 한 글자뿐이라 aria-label이 스크린리더가 읽을 유일한 이름이다.
    expect(gear.getAttribute("aria-label")).toBe("터미널·알림 설정");
    await click(gear);
    expect(modal()).toBeTruthy();
  });

  it("모달은 패널 밖(document.body)에 포털로 걸리고 dialog 계약을 갖는다", async () => {
    await render();
    await click(host.querySelector("button.gear-0")!);
    const d = dialog()!;
    expect(d, "role=dialog + aria-modal").toBeTruthy();
    expect(host.contains(d), "트리거가 사는 서브트리 안이면 안 된다").toBe(false);
    expect(d.parentElement).toBe(document.body);
    expect(document.activeElement, "포커스가 모달로 옮겨와야 한다").toBe(d);
  });

  it("⚙이 둘이어도 모달은 하나만 뜬다 (V2)", async () => {
    await render({ triggers: 2 });
    await click(host.querySelector("button.gear-0")!);
    await click(host.querySelector("button.gear-1")!);
    expect(document.querySelectorAll(".term-settings")).toHaveLength(1);
  });

  it("Escape로 닫히고 포커스는 트리거로 돌아간다 (V2)", async () => {
    await render();
    const gear = host.querySelector("button.gear-0") as HTMLButtonElement;
    await click(gear);
    await key(dialog()!, "Escape");
    expect(modal()).toBeNull();
    expect(document.activeElement).toBe(gear);
  });

  it("모달 안의 키는 바깥 React 조상으로 새지 않는다 (V1)", async () => {
    await render();
    // 대조군: 모달 밖에서 온 키는 조상이 받는다(= 감시 자체가 살아 있다).
    await key(host.querySelector("button.gear-0")!, "ArrowLeft", { ctrlKey: true });
    expect(outerKeys).toEqual(["ArrowLeft"]);

    await click(host.querySelector("button.gear-0")!);
    const hex = document.querySelector(".term-settings input.ts-hex")!;
    await key(hex, "ArrowLeft", { ctrlKey: true });
    expect(outerKeys, "Ctrl+←가 패널 단축키로 새면 커서 이동이 취소된다").toEqual(["ArrowLeft"]);
  });

  it("트리거가 사라져도 모달은 살아 있다 (V3 — 팝오버 링크 경로)", async () => {
    await render();
    await click(host.querySelector("button.gear-0")!);
    // 팝오버가 닫히며 트리거만 언마운트되는 상황.
    await render({ showTrigger: false });
    expect(modal(), "레이어가 소유하므로 모달은 남아야 한다").toBeTruthy();
    // 돌려줄 트리거가 사라졌어도 닫기가 터지지 않는다.
    await click(document.querySelector(".term-settings .modal-head button")!);
    expect(modal()).toBeNull();
  });

  it("프리셋 선택이 기존 저장·적용 경로를 그대로 탄다", async () => {
    await render();
    await click(host.querySelector("button.gear-0")!);
    const [name, palette] = Object.entries(TERM_PRESETS)[0];
    const preset = findButton(name);
    expect(preset, `프리셋 "${name}" 버튼`).toBeTruthy();
    await click(preset!);

    expect(useAppStore.getState().termColors).toEqual(palette);
    expect(JSON.parse(localStorage.getItem("termColors")!)).toEqual(palette);
    const applied = xtermTheme("dark", useAppStore.getState().termColors);
    expect(applied.background).toBe(palette.background);
  });

  it("'테마 따라가기'는 저장값을 지운다", async () => {
    await render();
    await click(host.querySelector("button.gear-0")!);
    await click(findButton(Object.keys(TERM_PRESETS)[0])!);
    expect(localStorage.getItem("termColors")).not.toBeNull();
    await click(findButton("테마 따라가기")!);
    expect(useAppStore.getState().termColors).toBeNull();
    expect(localStorage.getItem("termColors")).toBeNull();
  });

  it("닫기 버튼이 모달을 닫는다", async () => {
    await render();
    await click(host.querySelector("button.gear-0")!);
    await click(document.querySelector(".term-settings .modal-head button")!);
    expect(modal()).toBeNull();
  });
});
