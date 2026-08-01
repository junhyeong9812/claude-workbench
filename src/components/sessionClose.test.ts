import { describe, expect, it } from "vitest";
import { resolveCloseRequest } from "./sessionClose";
import type { ClaudeCloseRequest } from "../state/claudeUi";

/** P4 특성테스트 — 닫기/삭제 실행 계약(호출 여부·순서)을 고정한다.
 * 순서 계약: 삭제는 claude_close(전 뷰어 강제 종료) → claude_delete →
 * 패널 닫기 — 역전되면 poll 스레드가 삭제된 스냅샷을 재생성한다. */

const req = (over: Partial<ClaudeCloseRequest> = {}): ClaudeCloseRequest => ({
  panelId: "p1",
  sessionId: "uuid-1",
  kind: "claudeterm",
  ptyId: 7,
  project: "/proj",
  ...over,
});

const recordCalls = () => {
  const calls: string[] = [];
  const call = (cmd: string) => {
    calls.push(cmd);
    return Promise.resolve();
  };
  return { calls, call };
};

describe("resolveCloseRequest", () => {
  it("삭제: close → delete → 패널 순서 (세션 자기 프로젝트 대상)", async () => {
    const { calls, call } = recordCalls();
    let closed: string | null = null;
    await resolveCloseRequest(req(), "/other-active", true, (id) => (closed = id), call);
    expect(calls).toEqual(["claude_close", "claude_delete"]);
    expect(closed).toBe("p1");
  });

  it("닫기(deleteHistory=false): invoke 없이 패널만 닫는다", async () => {
    const { calls, call } = recordCalls();
    let closed: string | null = null;
    await resolveCloseRequest(req(), null, false, (id) => (closed = id), call);
    expect(calls).toEqual([]);
    expect(closed).toBe("p1");
  });

  it("ptyId 없음(죽은 세션) → 삭제여도 invoke 생략, 패널만", async () => {
    const { calls, call } = recordCalls();
    await resolveCloseRequest(req({ ptyId: undefined }), "/p", true, () => {}, call);
    expect(calls).toEqual([]);
  });

  it("project 없으면 activeProject 폴백, 둘 다 없으면 delete 생략(close는 수행)", async () => {
    const seen: Array<[string, unknown]> = [];
    const call = (cmd: string, args?: Record<string, unknown>) => {
      seen.push([cmd, args?.project]);
      return Promise.resolve();
    };
    await resolveCloseRequest(req({ project: null }), "/active", true, () => {}, call);
    expect(seen).toEqual([
      ["claude_close", undefined],
      ["claude_delete", "/active"],
    ]);
    seen.length = 0;
    await resolveCloseRequest(req({ project: null }), null, true, () => {}, call);
    expect(seen).toEqual([["claude_close", undefined]]);
  });

  it("invoke 실패는 삼키고 패널은 닫는다(기존 catch 계약)", async () => {
    let closed = false;
    await resolveCloseRequest(
      req(),
      "/p",
      true,
      () => (closed = true),
      () => Promise.reject(new Error("dead")),
    );
    expect(closed).toBe(true);
  });
});
