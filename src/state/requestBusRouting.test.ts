import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./store";
import { activeSurfaceId } from "./surfaceContext";

/**
 * 요청버스 **표면별 슬롯** 계약 (멀티프로젝트 P5 F1 — 동시발행 격리).
 *
 * 각 라우팅 채널은 `{ primary, secondary }` 표면별 슬롯이다. 발행부는 origin
 * surfaceId 슬롯에만 기록하고(기본 primary — 앱-전역·상단 툴바), 소비부(MainArea)는
 * `slot[mySurfaceId]`만 읽고 자기 슬롯만 clear 한다. 두 표면이 소비 전에 같은 채널을
 * 동시 발행해도 서로를 덮어쓰지 않는다(무음 유실 0) — 이 파일이 그 격리를 못박는다.
 */
const NO_OBJ = { primary: null, secondary: null };

describe("요청버스 표면별 슬롯 — 기본 primary 라우팅 (앱-전역/상단 툴바)", () => {
  beforeEach(() => {
    useAppStore.setState({
      editorOpenRequest: { ...NO_OBJ },
      diffRequest: { ...NO_OBJ },
      claudeOpenRequest: { ...NO_OBJ },
      codexOpenRequest: { ...NO_OBJ },
      runRequest: { ...NO_OBJ },
      terminalOpenRequest: { ...NO_OBJ },
      sessionResumeRequest: { ...NO_OBJ },
      claudePickerRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
      memoRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
    });
  });

  it("기본 활성 표면 seam은 'primary' (setActiveSurface 미호출 시)", () => {
    expect(activeSurfaceId()).toBe("primary");
  });

  it("surfaceId 생략 발행부는 primary 슬롯에만 기록하고 secondary는 비운다", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/p" });
    s.requestCodexOpen({ project: "/p" });
    s.requestRun({ project: "/p", cmd: "x", title: "t" });
    s.requestTerminalOpen({ cwd: "/p", title: "t" });
    s.requestDiff({ title: "d", cwd: "/p", path: "a" });
    s.requestEditorOpen("/repo/a.ts");
    s.requestSessionResume({ uuid: "u", project: "/p", title: "t" });
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest.primary?.project).toBe("/p");
    expect(g.claudeOpenRequest.secondary).toBeNull();
    expect(g.codexOpenRequest.primary?.project).toBe("/p");
    expect(g.runRequest.primary?.cmd).toBe("x");
    expect(g.terminalOpenRequest.primary?.nonce).toBe(1); // nonce 계약 유지
    expect(g.terminalOpenRequest.secondary).toBeNull();
    expect(g.diffRequest.primary?.cwd).toBe("/p"); // App flip 로직이 읽는 필드 보존
    expect(g.editorOpenRequest.primary?.path).toBe("/repo/a.ts");
    expect(g.sessionResumeRequest.primary?.uuid).toBe("u");
  });

  it("editorOpenRequest(null)은 그 표면 슬롯만 null (반대 표면 무영향)", () => {
    const s = useAppStore.getState();
    s.requestEditorOpen("/repo/a.ts", "secondary");
    s.requestEditorOpen(null); // primary clear — secondary 무영향
    expect(useAppStore.getState().editorOpenRequest.primary).toBeNull();
    expect(useAppStore.getState().editorOpenRequest.secondary?.path).toBe("/repo/a.ts");
  });

  it("카운터 슬롯(picker·memo)은 표면별 nonce가 각자 증가", () => {
    const s = useAppStore.getState();
    s.requestMemo();
    s.requestClaudePicker();
    const g = useAppStore.getState();
    expect(g.memoRequest.primary.nonce).toBe(1);
    expect(g.memoRequest.secondary.nonce).toBe(0);
    expect(g.claudePickerRequest.primary.nonce).toBe(1);
    expect(g.claudePickerRequest.secondary.nonce).toBe(0);
  });

  it("termMenu·detach·focusMain은 주 표면 고정 단일 슬롯(SSH/전송 envelope 전역)", () => {
    const s = useAppStore.getState();
    s.requestTermMenu();
    s.requestDetachPanel();
    s.requestFocusMain();
    const g = useAppStore.getState();
    expect(g.termMenuRequest.targetSurfaceId).toBe("primary");
    expect(g.detachPanelRequest.targetSurfaceId).toBe("primary");
    expect(g.focusMainRequest.targetSurfaceId).toBe("primary");
  });
});

describe("요청버스 표면별 슬롯 — origin='secondary' 라우팅", () => {
  beforeEach(() => {
    useAppStore.setState({
      editorOpenRequest: { ...NO_OBJ },
      diffRequest: { ...NO_OBJ },
      claudeOpenRequest: { ...NO_OBJ },
      codexOpenRequest: { ...NO_OBJ },
      runRequest: { ...NO_OBJ },
      terminalOpenRequest: { ...NO_OBJ },
      sessionResumeRequest: { ...NO_OBJ },
      claudePickerRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
      memoRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
    });
  });

  it("origin='secondary' 발행부는 secondary 슬롯에만 기록(primary 무영향)", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/p" }, "secondary");
    s.requestCodexOpen({ project: "/p" }, "secondary");
    s.requestRun({ project: "/p", cmd: "x", title: "t" }, "secondary");
    s.requestTerminalOpen({ cwd: "/p", title: "t" }, "secondary");
    s.requestDiff({ title: "d", cwd: "/p", path: "a" }, "secondary");
    s.requestEditorOpen("/p/a.ts", "secondary");
    s.requestSessionResume({ uuid: "u", project: "/p", title: "t" }, "secondary");
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest.secondary?.project).toBe("/p");
    expect(g.claudeOpenRequest.primary).toBeNull();
    expect(g.codexOpenRequest.secondary?.project).toBe("/p");
    expect(g.runRequest.secondary?.cmd).toBe("x");
    expect(g.terminalOpenRequest.secondary?.nonce).toBe(1);
    expect(g.diffRequest.secondary?.cwd).toBe("/p");
    expect(g.editorOpenRequest.secondary?.path).toBe("/p/a.ts");
    expect(g.sessionResumeRequest.secondary?.uuid).toBe("u");
    // primary 슬롯은 전부 비어 있다.
    expect(g.codexOpenRequest.primary).toBeNull();
    expect(g.runRequest.primary).toBeNull();
    expect(g.editorOpenRequest.primary).toBeNull();
  });

  it("카운터 origin='secondary'는 secondary nonce만 증가", () => {
    const s = useAppStore.getState();
    s.requestClaudePicker("secondary");
    s.requestMemo("secondary");
    const g = useAppStore.getState();
    expect(g.claudePickerRequest.secondary.nonce).toBe(1);
    expect(g.claudePickerRequest.primary.nonce).toBe(0);
    expect(g.memoRequest.secondary.nonce).toBe(1);
    expect(g.memoRequest.primary.nonce).toBe(0);
  });
});

/**
 * F1 핵심 반례 — **두 표면 동시발행이 서로를 덮어쓰지 않는다**. (예전 단일 슬롯은
 * 마지막 set이 이전 표면 요청을 삼켜 무음 유실이었다 — codex P1.)
 */
describe("요청버스 표면별 슬롯 — 동시발행 격리 (F1 반례)", () => {
  beforeEach(() => {
    useAppStore.setState({
      claudeOpenRequest: { ...NO_OBJ },
      terminalOpenRequest: { ...NO_OBJ },
      memoRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
      claudePickerRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
    });
  });

  it("두 표면이 소비 전에 같은 채널을 발행 → 각자 자기 요청을 보존(덮어쓰기 없음)", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/primary" }, "primary");
    s.requestClaudeOpen({ project: "/secondary" }, "secondary");
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest.primary?.project).toBe("/primary");
    expect(g.claudeOpenRequest.secondary?.project).toBe("/secondary");
  });

  it("secondary 소비(clear)가 primary 슬롯에 무영향", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/primary" }, "primary");
    s.requestClaudeOpen({ project: "/secondary" }, "secondary");
    // secondary MainArea가 자기 슬롯만 소비/clear.
    s.requestClaudeOpen(null, "secondary");
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest.secondary).toBeNull();
    expect(g.claudeOpenRequest.primary?.project).toBe("/primary"); // primary 온전
  });

  it("카운터 동시발행 — 표면별 nonce가 서로 독립(마지막 target만 관측되던 버그 해소)", () => {
    const s = useAppStore.getState();
    s.requestMemo("primary");
    s.requestMemo("secondary");
    const g = useAppStore.getState();
    // 두 표면 각자 자기 nonce가 1 — 예전엔 단일 {target,nonce}라 마지막(secondary)만 남았다.
    expect(g.memoRequest.primary.nonce).toBe(1);
    expect(g.memoRequest.secondary.nonce).toBe(1);
  });
});

/**
 * F1 teardown — 부 표면이 닫히면(removeSurface / closeProject) 그 표면 object 슬롯이
 * 비워진다: 닫는 프레임에 대기하던 요청이 다음 부 표면으로 누출되지 않게(Opus P3-2).
 */
describe("요청버스 표면별 슬롯 — teardown clear (F1 / P3-2)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ projects: [], activeProject: null });
    useAppStore.getState().setDualProject(null);
    useAppStore.setState({
      claudeOpenRequest: { ...NO_OBJ },
      editorOpenRequest: { ...NO_OBJ },
    });
  });

  it("setDualProject(null)이 부 표면 object 슬롯을 비운다(primary 무영향)", () => {
    const s = useAppStore.getState();
    // 부 표면을 연다(멤버십 존재) → 부 슬롯에 대기 요청.
    s.setDualProject("/proj-b");
    s.requestClaudeOpen({ project: "/primary" }, "primary");
    s.requestClaudeOpen({ project: "/proj-b" }, "secondary");
    expect(useAppStore.getState().claudeOpenRequest.secondary?.project).toBe("/proj-b");
    // 부 표면 닫힘 → 부 슬롯 clear, 주 슬롯 보존.
    s.setDualProject(null);
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest.secondary).toBeNull();
    expect(g.claudeOpenRequest.primary?.project).toBe("/primary");
  });
});
