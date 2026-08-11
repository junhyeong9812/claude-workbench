import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./store";
import { activeSurfaceId } from "./surfaceContext";

/**
 * 요청버스 표면 라우팅 — **발행부 stamp 계약** 고정.
 *
 * 각 표면-라우팅 슬롯의 발행부는 `targetSurfaceId`를 stamp한다. **P4' 범위
 * 축소(라우팅 5라운드 정지 규칙)**: 발행은 **항상 상수 "primary"** 다 — 소비부
 * (MainArea)가 `targetSurfaceId === mySurfaceId`로 소비하므로 요청이 언제나 항상
 * 가시인 primary dock에 열려 무음 유실이 구조적으로 불가하다. 목적지-활성-추종
 * 라우팅은 P5(표면별 툴바·소비자)로 이연. 이 테스트는 그 상수-primary 계약을
 * 고정한다. (활성 표면 추적/표시는 surfaceActive.test 담당.)
 */
describe("요청버스 표면 라우팅 stamp (P4' — 항상 primary)", () => {
  beforeEach(() => {
    // 슬롯 초기화 (다른 테스트 오염 방지).
    useAppStore.setState({
      editorOpenRequest: null,
      diffRequest: null,
      claudeOpenRequest: null,
      codexOpenRequest: null,
      runRequest: null,
      terminalOpenRequest: null,
      sessionResumeRequest: null,
    });
  });

  it("기본 활성 표면 seam은 'primary' (setActiveSurface 미호출 시)", () => {
    expect(activeSurfaceId()).toBe("primary");
  });

  it("object 슬롯 발행부는 targetSurfaceId='primary'를 실어 준다 (sibling 필드)", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/p" });
    s.requestCodexOpen({ project: "/p" });
    s.requestRun({ project: "/p", cmd: "x", title: "t" });
    s.requestTerminalOpen({ cwd: "/p", title: "t" });
    s.requestDiff({ title: "d", cwd: "/p", path: "a" });
    s.requestSessionResume({ uuid: "u", project: "/p", title: "t" });
    const g = useAppStore.getState();
    expect(g.claudeOpenRequest?.targetSurfaceId).toBe("primary");
    expect(g.claudeOpenRequest?.project).toBe("/p"); // 기존 필드 보존
    expect(g.codexOpenRequest?.targetSurfaceId).toBe("primary");
    expect(g.runRequest?.targetSurfaceId).toBe("primary");
    expect(g.terminalOpenRequest?.targetSurfaceId).toBe("primary");
    expect(g.terminalOpenRequest?.nonce).toBe(1); // 기존 nonce 계약 유지
    expect(g.diffRequest?.targetSurfaceId).toBe("primary");
    expect(g.diffRequest?.cwd).toBe("/p"); // App flip 로직이 읽는 필드 보존
    expect(g.sessionResumeRequest?.targetSurfaceId).toBe("primary");
  });

  it("editorOpenRequest는 {path, targetSurfaceId}로 감싸고 null은 그대로 null", () => {
    const s = useAppStore.getState();
    s.requestEditorOpen("/repo/a.ts");
    expect(useAppStore.getState().editorOpenRequest).toEqual({
      path: "/repo/a.ts",
      targetSurfaceId: "primary",
    });
    s.requestEditorOpen(null);
    expect(useAppStore.getState().editorOpenRequest).toBeNull();
  });

  it("카운터 슬롯 발행부는 {targetSurfaceId, nonce}이고 nonce가 매 발행 증가", () => {
    const before = useAppStore.getState().memoRequest.nonce;
    useAppStore.getState().requestMemo();
    const after = useAppStore.getState().memoRequest;
    expect(after.targetSurfaceId).toBe("primary");
    expect(after.nonce).toBe(before + 1);

    const f0 = useAppStore.getState().focusMainRequest.nonce;
    useAppStore.getState().requestFocusMain();
    expect(useAppStore.getState().focusMainRequest.nonce).toBe(f0 + 1);
    expect(useAppStore.getState().focusMainRequest.targetSurfaceId).toBe("primary");
  });

  it("clear(null)는 targetSurfaceId를 남기지 않는다 (소비 후 빈 슬롯)", () => {
    const s = useAppStore.getState();
    s.requestClaudeOpen({ project: "/p" });
    s.requestClaudeOpen(null);
    expect(useAppStore.getState().claudeOpenRequest).toBeNull();
    s.requestRun(null);
    expect(useAppStore.getState().runRequest).toBeNull();
  });
});
