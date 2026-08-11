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
import { secondaryProject } from "./surfaceTree";

describe("store: setDualProject → 트리 + 이중 기록", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().setDualProject(null);
  });

  it("열기: 트리 secondary(메모리 정본) + 단일 legacy 키만 디스크 기록 (FB)", () => {
    useAppStore.getState().setDualProject("/b");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/b");
    // 메모리 트리에 secondary 멤버십.
    expect(JSON.stringify(s.surfaceTree)).toContain("/b");
    // 디스크 정본 = 단일 legacy 키(구버전 앱이 읽는 유일 키).
    expect(localStorage.getItem("dualProject")).toBe("/b");
    // 트리 블롭은 디스크에 쓰지 않는다(분기 원천 소멸 — FB).
    expect(localStorage.getItem("surfaceTree")).toBeNull();
  });

  it("닫기: primary 단독 + 단일 legacy 키 제거(구버전 앱도 닫힘 반영)", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject(null);
    const s = useAppStore.getState();
    expect(s.dualProject).toBeNull();
    expect(secondaryProject(s.surfaceTree)).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
    expect(localStorage.getItem("surfaceTree")).toBeNull();
  });

  it("교체: secondary 재지정 시 중복 없이 최신 프로젝트만", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject("/c");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/c");
    expect(localStorage.getItem("dualProject")).toBe("/c");
  });
});

describe("store: closeProject가 우측 표면·미러·키를 정리 (FD)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ projects: [] });
    useAppStore.getState().setDualProject(null);
  });

  it("마지막 프로젝트를 닫아 목록이 비어도 우측 표면 잔존 0", () => {
    // 우측 표면 = "/b" (목록이 비어 있어도 예전 projects.length>0 가드가 정리를
    // 막던 케이스). closeProject가 갱신 안에서 함께 제거해야 한다.
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().closeProject("/b");
    const s = useAppStore.getState();
    expect(secondaryProject(s.surfaceTree)).toBeNull();
    expect(s.dualProject).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
  });

  it("우측이 아닌 다른 프로젝트를 닫으면 우측 표면은 그대로", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().closeProject("/a");
    const s = useAppStore.getState();
    expect(secondaryProject(s.surfaceTree)).toBe("/b");
    expect(localStorage.getItem("dualProject")).toBe("/b");
  });
});
