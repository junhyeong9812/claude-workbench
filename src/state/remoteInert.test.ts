/**
 * 원격 이벤트가 **로컬 상태를 건드리지 않는다**는 것을 실제 핸들러로 고정한다.
 *
 * R2a 는 기존 이벤트(`claude-timeline`·`claude-session-closed`·
 * `claude-hook-status`)를 그대로 쓴다. 그 결정이 안전한 이유는 앱 전역 리스너가
 * **레지스트리로 걸러내기** 때문인데(등록된 적 없는 id·uuid 는 조기 반환),
 * 그건 다른 파일의 성질이라 여기서 실제로 태워 확인한다. 이 테스트가 깨지면
 * "원격은 순수 가산"이라는 주장이 깨진 것이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, h: Handler) => {
    handlers.set(name, h);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

import { initClaudeStatusGlobal } from "./claudeStatusGlobal";
import { useClaudeStatus } from "./claudeStatus";
import { REMOTE_ID_BASE } from "./remoteHosts";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("원격 이벤트는 로컬 세션 상태에 닿지 않는다", () => {
  let dispose: () => void;

  beforeEach(async () => {
    handlers.clear();
    dispose = initClaudeStatusGlobal();
    await flush();
  });
  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
  });

  it("원격 id 의 claude-timeline 은 엔트리를 만들지 않는다", () => {
    const before = JSON.stringify(useClaudeStatus.getState().entries);
    handlers.get("claude-timeline")?.({
      payload: {
        id: REMOTE_ID_BASE + 7,
        items: [],
        turns: [[1, "원격 질문"]],
        answers: [],
      },
    });
    expect(JSON.stringify(useClaudeStatus.getState().entries)).toBe(before);
    expect(useClaudeStatus.getState().entries).toEqual({});
  });

  it("원격 id 의 claude-session-closed 는 아무 세션도 지우지 않는다", () => {
    useClaudeStatus.getState().registerSession("local-uuid", 3, "/p", "L");
    useClaudeStatus.getState().applyHookEvent("local-uuid", "stop");
    expect(useClaudeStatus.getState().entries["local-uuid"]).toBeTruthy();

    handlers.get("claude-session-closed")?.({ payload: REMOTE_ID_BASE + 7 });
    expect(
      useClaudeStatus.getState().entries["local-uuid"],
      "원격 세션의 종료가 로컬 세션을 지우면 안 된다",
    ).toBeTruthy();

    // 대조군: 진짜 로컬 id 는 지운다(필터가 무조건 반환하는 게 아님을 증명).
    handlers.get("claude-session-closed")?.({ payload: 3 });
    expect(useClaudeStatus.getState().entries["local-uuid"]).toBeUndefined();
  });

  it("호스트 접두가 붙은 uuid 의 hook 은 로컬 세션의 배지를 흔들지 않는다", () => {
    useClaudeStatus.getState().registerSession("5b6f21e0", 4, "/p", "L");
    const before = JSON.stringify(useClaudeStatus.getState().entries["5b6f21e0"]);

    // 접두가 없었다면 같은 uuid 를 쓰는 로컬 세션에 그대로 적용됐을 이벤트.
    handlers.get("claude-hook-status")?.({
      payload: { uuid: "hostA/5b6f21e0", event: "Stop" },
    });
    expect(JSON.stringify(useClaudeStatus.getState().entries["5b6f21e0"])).toBe(before);

    // 대조군: 접두 없는 같은 uuid 는 실제로 적용된다 — 그래서 접두가 필요하다.
    handlers.get("claude-hook-status")?.({
      payload: { uuid: "5b6f21e0", event: "Stop" },
    });
    expect(JSON.stringify(useClaudeStatus.getState().entries["5b6f21e0"])).not.toBe(before);
  });
});
