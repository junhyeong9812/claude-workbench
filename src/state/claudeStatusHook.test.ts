import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS, mapHookEvent, useClaudeStatus } from "./claudeStatus";

/** hook-status task 04 — hook 이벤트 전이 + hook 우선/스캔 폴백 (spec §2). */

const st = () => useClaudeStatus.getState();

let n = 0;
let uuid = "";
beforeEach(() => {
  vi.useFakeTimers();
  uuid = `hook-test-${++n}`;
  // H6 리듀서 가드: 이 창이 아는 세션만 hook을 적용한다 — 테스트 세션을 등록.
  st().registerSession(uuid, 90000 + n);
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

  it("Stop이 첫 hook(quiet 상태)이어도 완료 전이가 보장된다 (H5b)", () => {
    st().registerSession(uuid, 90001); // 매핑만 있고 엔트리 없음 → 가드 통과
    st().applyHookEvent(uuid, "stop");
    vi.advanceTimersByTime(HOLD_MS + 10);
    const e = st().entries[uuid];
    expect(e.status).toBe("idle");
    expect(e.unseen).toBe(true);
  });

  it("remove된(매핑 없는) 세션의 늦은 hook은 유령 엔트리를 만들지 않는다 (H6)", () => {
    st().applyHookEvent("ghost-uuid", "notification");
    expect(st().entries["ghost-uuid"]).toBeUndefined();
  });

  it("타임라인 quiet 틱은 hookBlocked를 보존한다", () => {
    st().applyHookEvent(uuid, "notification");
    st().updateFromTimeline(uuid, { activity: "quiet", questionBlocked: false, seenNow: false });
    expect(st().entries[uuid].status).toBe("blocked");
  });

  it("live 타임라인 working 틱은 hookBlocked를 해제한다 (H5c — 권한 승인 후 재개)", () => {
    st().applyHookEvent(uuid, "notification");
    st().updateFromTimeline(uuid, {
      activity: "working",
      questionBlocked: false,
      seenNow: false,
      origin: "live",
    });
    expect(st().entries[uuid].status).toBe("working");
    // snapshot 틱은 해제하지 않는다(restore 재생 — 재알림 억제 계열).
    st().applyHookEvent(uuid, "notification");
    st().updateFromTimeline(uuid, {
      activity: "working",
      questionBlocked: false,
      seenNow: false,
      origin: "snapshot",
    });
    expect(st().entries[uuid].status).toBe("blocked");
  });
});
