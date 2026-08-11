/**
 * 활성 표면 (멀티프로젝트 P4', 범위 축소본) — store 배선.
 *
 * P4'는 **활성 표면 추적 + 표시 반영 + 시각 지시자**만 한다(목적지 라우팅은 P5).
 * 이 테스트는 ① setActiveSurface 추적/정규화(우측이 뚜렷이 안 보이면 primary로)와
 * ② **모든 요청버스 발행이 항상 primary로 stamp됨**(활성 표면과 무관 — 무음 유실
 * 구조적 불가)을 고정한다.
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

const proj = (p: string) => ({ path: p, name: p, project_types: [], tree_state: { expanded: [] } });
/** /a(primary)+/b(secondary, 활성) 구성으로 만든다(가시 우측 표면 + 활성=secondary). */
const dualActiveSecondary = (modes: Record<string, "integrated" | "dev"> = {}) => {
  useAppStore.setState({ projects: [proj("/a"), proj("/c"), proj("/b")], activeProject: "/a", projectModes: modes });
  const s = useAppStore.getState();
  s.setDualProject("/b");
  s.setActiveSurface("secondary");
  expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
};

describe("활성 표면 추적/정규화 (P4' 범위 축소)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ projects: [], activeProject: null, projectModes: {} });
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
  });

  it("우측 표면이 있으면 활성 전환(추적) — 상태·seam이 secondary", () => {
    dualActiveSecondary();
    expect(activeSurfaceId()).toBe("secondary");
  });

  it("우측 표면을 닫으면(setDualProject null) 활성이 primary로 되돌아온다", () => {
    dualActiveSecondary();
    useAppStore.getState().setDualProject(null);
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("우측 표면 프로젝트를 closeProject하면 활성이 primary로 정규화", () => {
    dualActiveSecondary();
    useAppStore.getState().closeProject("/b");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("우측을 좌측과 같은 프로젝트로 바꾸면(숨김 겹침) 활성이 primary로 정규화", () => {
    dualActiveSecondary();
    // 우측을 좌측(activeProject="/a")과 동일하게 → resolveVisibleDual이 숨김.
    useAppStore.getState().setDualProject("/a");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("크로스윈도우 전환이 좌측을 우측과 같게 만들면 활성이 primary로 정규화", () => {
    dualActiveSecondary();
    useAppStore.getState().applyRemoteActive("/b"); // 좌측이 우측(/b)과 겹침 → 숨김
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("addProject(기본)은 좌측 활성으로 연다", async () => {
    useAppStore.setState({ projects: [proj("/a")], activeProject: "/a" });
    await useAppStore.getState().addProject("/c");
    expect(useAppStore.getState().activeProject).toBe("/c");
  });

  it("[G1] primary를 닫아 재인덱스로 좌측이 우측과 같아지면 활성이 primary로 정규화", () => {
    useAppStore.setState({ projects: [proj("/a"), proj("/b")], activeProject: "/a" });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary");
    // /a 닫음 → projects=[/b], activeProject=/b(재인덱스) → 우측 /b 겹쳐 숨김 → 정규화.
    useAppStore.getState().closeProject("/a");
    expect(useAppStore.getState().activeProject).toBe("/b");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("[G3] 주 표면이 dev로 진입하면 활성이 primary로 정규화(오버레이가 dual 가림)", () => {
    dualActiveSecondary();
    useAppStore.getState().setProjectMode("/a", "dev");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("[H1a] applyRemoteActive로 좌측이 이미-dev인 프로젝트로 바뀌면 활성 정규화", () => {
    dualActiveSecondary({ "/c": "dev" });
    useAppStore.getState().applyRemoteActive("/c"); // dev 오버레이가 dual 가림
    expect(useAppStore.getState().activeProject).toBe("/c");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });

  it("[H1b] closeProject 재인덱스가 dev 프로젝트를 primary로 만들면 활성 정규화", () => {
    // 순서 [/a, /c(dev), /b] — /a 닫으면 projects[0]=/c(dev)가 새 activeProject.
    useAppStore.setState({ projects: [proj("/a"), proj("/c"), proj("/b")], activeProject: "/a", projectModes: { "/c": "dev" } });
    const s = useAppStore.getState();
    s.setDualProject("/b");
    s.setActiveSurface("secondary");
    useAppStore.getState().closeProject("/a");
    expect(useAppStore.getState().activeProject).toBe("/c");
    expect(useAppStore.getState().activeSurfaceId).toBe("primary");
  });
});

describe("요청버스는 항상 primary로 발행 (P4' 범위 축소 — 목적지 라우팅 P5)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      projects: [], activeProject: null, projectModes: {},
      editorOpenRequest: null, diffRequest: null, claudeOpenRequest: null, codexOpenRequest: null,
      runRequest: null, terminalOpenRequest: null, sessionResumeRequest: null,
    });
    useAppStore.getState().setDualProject(null);
    useAppStore.getState().setActiveSurface("primary");
  });

  it("활성=secondary여도 모든 슬롯이 targetSurfaceId='primary'로 stamp된다(무손실)", () => {
    dualActiveSecondary();
    expect(useAppStore.getState().activeSurfaceId).toBe("secondary"); // 추적은 secondary
    const g = useAppStore.getState();
    g.requestClaudeOpen({ project: "/b" });
    g.requestCodexOpen({ project: "/b" });
    g.requestRun({ project: "/b", cmd: "x", title: "t" });
    g.requestTerminalOpen({ cwd: "/b", title: "t" });
    g.requestEditorOpen("/b/f.ts");
    g.requestDiff({ title: "d", cwd: "/b", path: "a" });
    g.requestSessionResume({ uuid: "u", project: "/b", title: "t" });
    g.requestMemo();
    g.requestDetachPanel();
    g.requestTermMenu();
    g.requestClaudePicker();
    g.requestFocusMain();
    const h = useAppStore.getState();
    // 활성 추적은 secondary지만 **발행은 전부 primary**(pre-P4' 정상 경로 — 항상 가시).
    expect(h.claudeOpenRequest?.targetSurfaceId).toBe("primary");
    expect(h.codexOpenRequest?.targetSurfaceId).toBe("primary");
    expect(h.runRequest?.targetSurfaceId).toBe("primary");
    expect(h.terminalOpenRequest?.targetSurfaceId).toBe("primary");
    expect(h.editorOpenRequest?.targetSurfaceId).toBe("primary");
    expect(h.diffRequest?.targetSurfaceId).toBe("primary");
    expect(h.sessionResumeRequest?.targetSurfaceId).toBe("primary");
    expect(h.memoRequest.targetSurfaceId).toBe("primary");
    expect(h.detachPanelRequest.targetSurfaceId).toBe("primary");
    expect(h.termMenuRequest.targetSurfaceId).toBe("primary");
    expect(h.claudePickerRequest.targetSurfaceId).toBe("primary");
    expect(h.focusMainRequest.targetSurfaceId).toBe("primary");
  });
});
