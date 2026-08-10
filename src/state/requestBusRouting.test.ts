import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./store";
import { activeSurfaceId } from "./surfaceContext";

/**
 * 요청버스 표면 라우팅 (멀티프로젝트 P2) — **무동작 계약** 고정.
 *
 * 각 표면-라우팅 슬롯의 발행부는 `activeSurfaceId()`(P2=상수 "primary")를
 * `targetSurfaceId`로 stamp한다. 소비자(MainArea)는 자기 `useSurfaceId()`와
 * 일치할 때만 소비하므로, 표면이 primary 하나뿐인 현재는 종전 `isPrimary`
 * 게이트와 결과가 동일하다. 이 테스트는 그 stamp 계약(발행 측)을 고정한다 —
 * P4'가 `activeSurfaceId()`를 실제 활성 표면으로 교체할 때 여기가 신호가 된다.
 */
describe("요청버스 표면 라우팅 stamp (P2 무동작)", () => {
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

  it("activeSurfaceId()는 P2에서 상수 'primary' (라우팅 seam)", () => {
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
