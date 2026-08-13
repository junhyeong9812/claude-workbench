import { describe, expect, it } from "vitest";
import {
  isRemoteId,
  noticeBadge,
  phaseLabel,
  resumeLabel,
  toLiveTimeline,
  unseenNotices,
  REMOTE_ID_BASE,
  type RemoteNotice,
} from "./remoteHosts";
import type { ClaudeTimelineEvent } from "../hooks/useClaudeTimeline";
import type { TimelineItem } from "../types";

function item(id: string, seq: number): TimelineItem {
  return {
    session_id: "s",
    tool_call_id: id,
    turn: 1,
    seq,
    kind: "execute",
    title: id,
    locations: [],
    project_label: null,
    diffs: [],
    content_text: null,
    content_truncated: false,
    raw_input: null,
    agent_status: "completed",
    write_status: "none",
    revision: 1,
  } as unknown as TimelineItem;
}

function notice(seq: number, level: RemoteNotice["level"]): RemoteNotice {
  return { seq, level, message: `n${seq}`, session: null, at_ms: 0 };
}

describe("원격 세션 id 네임스페이스", () => {
  it("로컬 id와 겹칠 수 없다 — 이 판정 하나가 패널의 이벤트 필터 전부다", () => {
    // `core/src/remote/host.rs` 의 REMOTE_ID_BASE 와 같은 값이어야 한다.
    expect(REMOTE_ID_BASE).toBe(1099511627776);
    // 로컬 SessionManager 는 1부터 센다.
    expect(isRemoteId(1)).toBe(false);
    expect(isRemoteId(999_999)).toBe(false);
    expect(isRemoteId(REMOTE_ID_BASE - 1)).toBe(false);
    expect(isRemoteId(REMOTE_ID_BASE)).toBe(true);
    expect(isRemoteId(REMOTE_ID_BASE + 5)).toBe(true);
    // …그리고 JS 가 정수로 다룰 수 있는 범위 안에 있다(안 그러면 두 원격
    // 세션이 같은 id 로 보인다).
    expect(Number.isSafeInteger(REMOTE_ID_BASE)).toBe(true);
    expect(isRemoteId(Number.NaN)).toBe(false);
  });
});

describe("연결 상태 말하기", () => {
  it("끊김과 연결됨이 같은 말이 되지 않는다", () => {
    expect(phaseLabel("live")).toBe("연결됨");
    expect(phaseLabel("reconnecting")).toContain("끊김");
    expect(phaseLabel("failed")).toBe("연결 실패");
    expect(phaseLabel("connecting")).toBe("연결 중");
    expect(phaseLabel("idle")).toBe("연결 안 됨");
    // 다섯 상태가 전부 다른 문구다 — 하나라도 겹치면 화면이 상태를 못 알린다.
    const said = ["live", "reconnecting", "failed", "connecting", "idle"].map((p) =>
      phaseLabel(p as never),
    );
    expect(new Set(said).size).toBe(said.length);
  });

  it("이어받음과 처음부터를 구별해 말한다", () => {
    expect(resumeLabel(null)).toBeNull();
    expect(resumeLabel({ kind: "continued", from_seq: 9 })).toContain("이어받음");
    expect(resumeLabel({ kind: "continued", from_seq: 9 })).toContain("9");
    expect(resumeLabel({ kind: "fresh" })).toBe("처음부터 받음");
    expect(resumeLabel({ kind: "gap", message: "evicted" })).toContain("다시");
  });
});

describe("알림 배지", () => {
  it("안 본 것만 세고, 가장 시끄러운 등급을 보인다", () => {
    const ns = [notice(1, "info"), notice(2, "warn"), notice(3, "error")];
    expect(unseenNotices(ns, 0)).toHaveLength(3);
    expect(noticeBadge(ns, 0)).toEqual({ count: 3, level: "error" });
    expect(noticeBadge(ns, 2)).toEqual({ count: 1, level: "error" });
    expect(noticeBadge(ns, 3)).toBeNull();
    expect(noticeBadge([notice(4, "info"), notice(5, "warn")], 3)).toEqual({
      count: 2,
      level: "warn",
    });
    expect(noticeBadge([notice(9, "info")], 3)).toEqual({ count: 1, level: "info" });
  });
});

describe("원격 payload 읽기", () => {
  it("아이템을 seq 순으로 세우고 컨텍스트 점유를 로컬과 같은 식으로 센다", () => {
    const e: ClaudeTimelineEvent = {
      id: REMOTE_ID_BASE + 1,
      items: [item("b", 2), item("a", 1)],
      turns: [[1, "질문"]],
      answers: [],
      dates: [],
      tokens: [],
      model: "claude-opus-5",
      last_usage: { input: 2, output: 5, cache_read: 10, cache_creation: 3 },
      subagents: [],
    };
    const live = toLiveTimeline(e);
    expect(live.items.map((i) => i.tool_call_id)).toEqual(["a", "b"]);
    expect(live.turns).toEqual([[1, "질문"]]);
    expect(live.model).toBe("claude-opus-5");
    // 로컬 게이지와 같은 식: input + cache_read + cache_creation (output 제외).
    expect(live.ctxTokens).toBe(15);
  });

  it("데몬이 보내지 않는 것은 지어내지 않는다", () => {
    const e: ClaudeTimelineEvent = {
      id: REMOTE_ID_BASE,
      items: [],
      turns: [],
      answers: [],
      dates: [],
      tokens: [],
      subagents: [],
    };
    const live = toLiveTimeline(e);
    expect(live.items).toEqual([]);
    expect(live.turns).toEqual([]);
    expect(live.model).toBeNull();
    expect(live.ctxTokens).toBe(0);
  });
});
