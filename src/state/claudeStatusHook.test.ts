import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, mapHookEvent, useClaudeStatus } from "./claudeStatus";

/** hook-status task 04 — hook 이벤트 전이 + hook 우선/스캔 폴백 (spec §2). */

const st = () => useClaudeStatus.getState();

let n = 0;
let uuid = "";
beforeEach(() => {
  vi.useFakeTimers();
  uuid = `hook-test-${++n}`;
});
afterEach(() => {
  st().remove(uuid);
  vi.useRealTimers();
});

describe("mapHookEvent", () => {
  it("화이트리스트 3종 매핑, 그 외 null", () => {
    expect(mapHookEvent("Stop")).toBe("stop");
    expect(mapHookEvent("Notification")).toBe("notification");
    expect(mapHookEvent("UserPromptSubmit")).toBe("prompt-submit");
    expect(mapHookEvent("PreToolUse")).toBeNull();
    expect(mapHookEvent("")).toBeNull();
  });
});

describe("applyHookEvent", () => {
  it("Notification → 즉시 blocked (hookBacked 래치)", () => {
    st().applyHookEvent(uuid, "notification");
    const e = st().entries[uuid];
    expect(e.status).toBe("blocked");
    expect(e.hookBacked).toBe(true);
  });

  it("UserPromptSubmit → blocked 해제 + working", () => {
    st().applyHookEvent(uuid, "notification");
    st().applyHookEvent(uuid, "prompt-submit");
    const e = st().entries[uuid];
    expect(e.status).toBe("working");
    expect(e.hookBlocked).toBe(false);
  });

  it("Stop은 working→quiet를 기존 HOLD 규칙으로 확정 (미확인 → unseen)", () => {
    st().applyHookEvent(uuid, "prompt-submit"); // working 진입
    st().applyHookEvent(uuid, "stop");
    // hold 전엔 여전히 working 표시 (micro-pause 오탐 방지 규칙 유지).
    expect(st().entries[uuid].status).toBe("working");
    vi.advanceTimersByTime(HOLD_MS + 10);
    const e = st().entries[uuid];
    expect(e.status).toBe("idle");
    expect(e.unseen).toBe(true); // 본 적 없음 → done-unseen 배지
  });

  it("hook 우선: hookBacked 세션은 화면 스캔 blocked를 무시", () => {
    st().applyHookEvent(uuid, "prompt-submit"); // hookBacked 래치
    st().setScreenBlocked(uuid, true);
    expect(st().entries[uuid].status).toBe("working"); // 스캔 무시
    st().applyHookEvent(uuid, "notification");
    expect(st().entries[uuid].status).toBe("blocked"); // hook 신호는 반영
  });

  it("스캔 폴백: hook 미수신 세션은 기존 스캔 판정 유지", () => {
    st().setScreenBlocked(uuid, true);
    expect(st().entries[uuid].status).toBe("blocked");
    st().setScreenBlocked(uuid, false);
    expect(st().entries[uuid].status).toBe("idle");
  });
});
