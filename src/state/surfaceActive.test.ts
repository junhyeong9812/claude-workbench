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
  emit: vi.fn(() => Promise.resolve()),
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
    useAppStore.setState({ projects: [], activeProject: null });
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
    // 가시성 술어(G4)는 우측이 **열린 탭**이고 좌측과 다를 것을 요구.
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
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
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
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

  it("우측을 좌측과 같은 프로젝트로 바꾸면(숨김 겹침) 활성이 primary로 정규화", () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    // 우측을 좌측(activeProject="/a")과 동일하게 → resolveVisibleDual이 숨김 →
    // 유령 활성 방지로 primary 복귀.
    useAppStore.getState().setDualProject("/a");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("addProject(surface:'secondary')는 좌측 앵커를 유지하고 우측 표면에 싣는다", async () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    await useAppStore.getState().addProject("/b", { surface: "secondary" });
    const g = useAppStore.getState();
    expect(g.activeProject).toBe("/a"); // 좌측 앵커 유지
    expect(g.dualProject).toBe("/b"); // 우측 표면에 실림
    expect(g.projects.some((p) => p.path === "/b")).toBe(true); // 카탈로그 추가
  });

  it("크로스윈도우 전환이 좌측을 우측과 같게 만들면 활성이 primary로 정규화", () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    // 다른 창이 이 창의 좌측을 "/b"(=우측 표면)로 전환 → 우측 숨김 → primary 복귀.
    useAppStore.getState().applyRemoteActive("/b");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("addProject(기본)은 좌측 활성으로 연다(종전 동작)", async () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    useAppStore.getState().setDualProject(null);
    await useAppStore.getState().addProject("/c");
    expect(useAppStore.getState().activeProject).toBe("/c");
  });

  // ── 듀얼 리뷰 findings ──────────────────────────────────────────────
  it("[G1] primary를 닫아 재인덱스로 좌측이 우측과 같아지면 활성이 primary로 정규화", () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    // /a(primary) 닫음 → projects=[/b], activeProject=/b(재인덱스) → 우측 /b가
    // 좌측과 겹쳐 숨김 → 활성 정규화.
    useAppStore.getState().closeProject("/a");
    expect(useAppStore.getState().activeProject).toBe("/b");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  // [G2 + codex 감사 폴백] 슬롯 라우팅 계약 = 무음 유실 0.
  //  · picker-UI(termMenu·claudePicker·focusMain)는 항상 primary — 팝오버가
  //    primary `.main-menus`에만 렌더되므로 primary에 떠서 primary dock에 연다
  //    (항상 보임). 활성 표면 툴바 피커는 P5.
  //  · panel-destination(claude/codex/run/terminal/editor/diff/resume/memo/detach)은
  //    활성 표면(secondary) — 그 표면 dock에 패널이 열려 보인다.
  // 어느 쪽도 렌더되지 않는 표면으로 라우팅되지 않는다(무음 유실 0).
  it("[G2] 슬롯 재분류 — picker-UI는 항상 primary, panel-destination은 활성 표면", () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a" });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    const g = useAppStore.getState();
    // picker-UI-open → 항상 primary(팝오버/포커스가 primary 크롬에만 렌더).
    g.requestTermMenu();
    g.requestClaudePicker();
    g.requestFocusMain();
    expect(useAppStore.getState().termMenuRequest.targetSurfaceId).toBe("primary");
    expect(useAppStore.getState().claudePickerRequest.targetSurfaceId).toBe("primary");
    expect(useAppStore.getState().focusMainRequest.targetSurfaceId).toBe("primary");
    // panel-destination → 활성 표면(secondary).
    g.requestClaudeOpen({ project: "/b" });
    g.requestCodexOpen({ project: "/b" });
    g.requestRun({ project: "/b", cmd: "x", title: "t" });
    g.requestTerminalOpen({ cwd: "/b", title: "t" });
    g.requestEditorOpen("/b/f.ts");
    g.requestDiff({ title: "d", cwd: "/b", path: "a" });
    g.requestSessionResume({ uuid: "u", project: "/b", title: "t" });
    g.requestMemo();
    g.requestDetachPanel();
    const h = useAppStore.getState();
    expect(h.claudeOpenRequest?.targetSurfaceId).toBe("secondary");
    expect(h.codexOpenRequest?.targetSurfaceId).toBe("secondary");
    expect(h.runRequest?.targetSurfaceId).toBe("secondary");
    expect(h.terminalOpenRequest?.targetSurfaceId).toBe("secondary");
    expect(h.editorOpenRequest?.targetSurfaceId).toBe("secondary");
    expect(h.diffRequest?.targetSurfaceId).toBe("secondary");
    expect(h.sessionResumeRequest?.targetSurfaceId).toBe("secondary");
    expect(h.memoRequest.targetSurfaceId).toBe("secondary");
    expect(h.detachPanelRequest.targetSurfaceId).toBe("secondary");
  });

  it("[G3] 주 표면이 dev로 진입하면 활성이 primary로 정규화(오버레이가 dual 가림)", () => {
    useAppStore.setState({ projects: [{ path: "/a", name: "a", project_types: [], tree_state: { expanded: [] } }, { path: "/b", name: "b", project_types: [], tree_state: { expanded: [] } }], activeProject: "/a", projectModes: {} });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    // 좌측(activeProject="/a")이 dev 진입 → DevView 오버레이가 dual 전체를 가림.
    useAppStore.getState().setProjectMode("/a", "dev");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });
});
