/**
 * 터미널 색상 설정의 **진입점 이동**(T3) 회귀 방어.
 *
 * 옮긴 것은 여는 자리뿐이라, 이 테스트가 붙잡는 것도 두 가지다:
 *   (a) 새 진입점이 실제로 모달을 띄우는가 — 그것도 **패널 밖(document.body)**
 *       으로. dockview 패널 안에서 그대로 렌더하면 조상 transform이 fixed
 *       백드롭을 패널 안에 가둔다(포털을 쓰는 이유).
 *   (b) 그 모달에서 고른 색이 **예전과 같은 경로로** 저장·적용되는가 —
 *       localStorage `termColors` 키 + xtermTheme 병합. 진입점을 옮기면서
 *       이 경로가 딸려 바뀌지 않았음을 실증한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(() => undefined),
}));

import { TermSettingsButton } from "./TermSettingsButton";
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

/** 모달 안에서 라벨이 정확히 일치하는 버튼 찾기 (프리셋 이름 = 버튼 텍스트). */
const findButton = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

describe("TermSettingsButton (터미널 색상 진입점)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<TermSettingsButton className="terminal-gear" />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useAppStore.getState().setTermColors(null);
  });

  it("클릭 전에는 모달이 없고, 클릭하면 열린다", async () => {
    expect(document.querySelector(".term-settings")).toBeNull();
    const gear = host.querySelector("button.terminal-gear");
    expect(gear, "진입점 버튼이 있어야 한다").toBeTruthy();
    // 스크린리더가 읽을 이름 — 아이콘 한 글자뿐이라 aria-label이 유일한 이름이다.
    expect(gear!.getAttribute("aria-label")).toBe("터미널 색상 설정");
    await click(gear!);
    expect(document.querySelector(".term-settings"), "모달이 떠야 한다").toBeTruthy();
  });

  it("모달은 패널 밖(document.body)에 포털로 걸린다", async () => {
    await click(host.querySelector("button.terminal-gear")!);
    const backdrop = document.querySelector(".modal-backdrop")!;
    expect(backdrop).toBeTruthy();
    expect(host.contains(backdrop), "버튼이 사는 서브트리 안이면 안 된다").toBe(false);
    expect(backdrop.parentElement).toBe(document.body);
  });

  it("프리셋 선택이 기존 저장·적용 경로를 그대로 탄다", async () => {
    await click(host.querySelector("button.terminal-gear")!);
    const [name, palette] = Object.entries(TERM_PRESETS)[0];
    const preset = findButton(name);
    expect(preset, `프리셋 "${name}" 버튼`).toBeTruthy();
    await click(preset!);

    // 스토어 → localStorage("termColors") → xtermTheme 병합, 셋 다 이동 전과 동일.
    expect(useAppStore.getState().termColors).toEqual(palette);
    expect(JSON.parse(localStorage.getItem("termColors")!)).toEqual(palette);
    const applied = xtermTheme("dark", useAppStore.getState().termColors);
    expect(applied.background).toBe(palette.background);
  });

  it("'테마 따라가기'는 저장값을 지운다", async () => {
    await click(host.querySelector("button.terminal-gear")!);
    await click(findButton(Object.keys(TERM_PRESETS)[0])!);
    expect(localStorage.getItem("termColors")).not.toBeNull();
    await click(findButton("테마 따라가기")!);
    expect(useAppStore.getState().termColors).toBeNull();
    expect(localStorage.getItem("termColors")).toBeNull();
  });

  it("닫기 버튼이 모달을 닫는다", async () => {
    await click(host.querySelector("button.terminal-gear")!);
    const close = document.querySelector(".term-settings .modal-head button")!;
    await click(close);
    expect(document.querySelector(".term-settings")).toBeNull();
  });
});
