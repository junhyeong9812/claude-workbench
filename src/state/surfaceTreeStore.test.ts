/**
 * store 배선 통합 테스트 (멀티프로젝트 P3') — setDualProject가 트리 API로
 * 매핑되며 두 localStorage 키(surfaceTree + 레거시 dualProject)를 함께 기록해
 * 다운그레이드 안전을 유지하는지 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// store.ts는 @tauri-apps/api를 import 하지만 이 테스트가 부르는 경로(setDualProject)
// 는 invoke를 타지 않는다 — 안전하게 no-op 목킹.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

import { useAppStore } from "./store";

describe("store: setDualProject → 트리 + 이중 기록", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().setDualProject(null);
  });

  it("열기: 트리 secondary 설정 + 두 키 동기 기록", () => {
    useAppStore.getState().setDualProject("/b");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/b");
    // 레거시 키 = 구버전 앱이 읽는 우측 분할 경로.
    expect(localStorage.getItem("dualProject")).toBe("/b");
    // 신 트리 키 = 정본. 파싱하면 secondary 멤버십 복원.
    const tree = JSON.parse(localStorage.getItem("surfaceTree")!);
    expect(tree.version).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(tree)).toContain("/b");
    expect(s.surfaceTree).toEqual(tree);
  });

  it("닫기: primary 단독 + 레거시 키 제거(구버전 앱도 닫힘 반영)", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject(null);
    const s = useAppStore.getState();
    expect(s.dualProject).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
    // 신 트리는 여전히 존재하되 secondary 없음.
    expect(localStorage.getItem("surfaceTree")).toContain("primary");
  });

  it("교체: secondary 재지정 시 중복 없이 최신 프로젝트만", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject("/c");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/c");
    expect(localStorage.getItem("dualProject")).toBe("/c");
  });
});
