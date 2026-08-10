/**
 * 활성 표면 + 포커스 모델 (멀티프로젝트 P4') — store 배선 + 요청버스 seam 라우팅.
 *
 * setActiveSurface가 상태와 `activeSurfaceId()` seam 홀더를 함께 갱신해, 이후
 * 요청버스 발행이 활성 표면으로 stamp되는지 고정한다. 또 우측 표면이 없거나
 * 사라질 때 활성이 primary로 정규화(유령 활성 방지)되는지 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

import { useAppStore } from "./store";
import { activeSurfaceId } from "./surfaceContext";

describe("활성 표면 + 요청버스 seam 라우팅 (P4')", () => {
  beforeEach(() => {
    localStorage.clear();
    const s = useAppStore.getState();
    s.setDualProject(null);
    s.setActiveSurface("primary");
    useAppStore.setState({ claudeOpenRequest: null, memoRequest: { targetSurfaceId: "primary", nonce: 0 } });
  });

  it("기본 활성 표면은 primary (seam + 상태 정합)", () => {
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
    expect(activeSurfaceId()).toBe("primary");
  });

  it("우측 표면이 없으면 setActiveSurface('secondary')는 primary로 정규화", () => {
    useAppStore.getState().setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
    expect(activeSurfaceId()).toBe("primary");
  });

  it("우측 표면이 있으면 활성 전환 → seam·상태·요청버스 stamp가 secondary", () => {
    const s = useAppStore.getState();
    s.setDualProject("/b"); // 우측 표면 생성
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    expect(activeSurfaceId()).toBe("secondary");
    // 발행 시점 seam을 읽어 stamp — 소비부(MainArea)가 이 키로 라우팅한다.
    useAppStore.getState().requestClaudeOpen({ project: "/b" });
    expect(useAppStore.getState().claudeOpenRequest?.targetSurfaceId).toBe("secondary");
    useAppStore.getState().requestMemo();
    expect(useAppStore.getState().memoRequest.targetSurfaceId).toBe("secondary");
  });

  it("우측 표면을 닫으면(setDualProject null) 활성이 primary로 되돌아온다", () => {
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    useAppStore.getState().setDualProject(null);
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
    expect(activeSurfaceId()).toBe("primary");
    // 되돌린 뒤 발행은 primary로 stamp.
    useAppStore.getState().requestClaudeOpen({ project: "/a" });
    expect(useAppStore.getState().claudeOpenRequest?.targetSurfaceId).toBe("primary");
  });

  it("우측 표면 프로젝트를 closeProject하면 활성이 primary로 정규화", () => {
    const s = useAppStore.getState();
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    useAppStore.getState().closeProject("/b");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
    expect(activeSurfaceId()).toBe("primary");
  });
});
