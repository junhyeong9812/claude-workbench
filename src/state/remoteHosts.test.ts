import { describe, expect, it } from "vitest";
import {
  countsLabel,
  fetchedToLive,
  isRemoteId,
  mergeSeed,
  noticeBadge,
  phaseLabel,
  pickTimeline,
  resumeLabel,
  seenKey,
  seenSeqOf,
  shouldFetchBody,
  staleSeenKeys,
  toLiveTimeline,
  unseenNotices,
  REMOTE_ID_BASE,
  type RemoteHostSnapshot,
  type RemoteLiveTimeline,
  type RemoteNotice,
  type RemoteSessionMeta,
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

function host(id: string, notices: RemoteNotice[], incarnation = 1): RemoteHostSnapshot {
  return {
    host_id: id,
    label: id,
    incarnation,
    phase: "live",
    daemon: null,
    resume: null,
    cursor: null,
    last_error: null,
    attempts: 1,
    last_frame_at_ms: 1000,
    running: 0,
    sessions: [],
    notices,
  };
}

function meta(over: Partial<RemoteSessionMeta> = {}): RemoteSessionMeta {
  return {
    id: REMOTE_ID_BASE,
    key: "k1",
    uuid: "h/u",
    session_id: "u",
    agent: "claude",
    cwd: "/w",
    label: null,
    state: "exited",
    started_at_ms: 1,
    exit_code: 0,
    signal: null,
    adopted: null,
    body_omitted: false,
    timeline_len: 0,
    turns: 0,
    items: 0,
    model: null,
    ctx_tokens: 0,
    last_title: null,
    last_hook: null,
    closed: true,
    ...over,
  };
}

function live(items: number, turns: number): RemoteLiveTimeline {
  return {
    items: Array.from({ length: items }, (_, i) => item(`t${i}`, i)),
    turns: Array.from({ length: turns }, (_, i) => [i + 1, `q${i}`] as [number, string]),
    model: null,
    ctxTokens: 0,
  };
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

describe("알림 채널이 재접속 후에도 살아 있다", () => {
  it("다시 붙은 연결의 알림은 옛 '봤다' 뒤에 숨지 않는다 — 큰 값이든 동률이든", () => {
    // 화면은 seq 50까지 봤다고 기억한다. 다시 붙은 호스트는 새 Host 객체라
    // notice_seq가 0부터 다시 센다 — 옛 표시를 그대로 적용하면 새 연결의 1~50이
    // 전부 '이미 본 것'으로 걸러져 갭도 데몬 재시작도 안 보인다.
    const reconnected = host("h1", [notice(1, "warn"), notice(2, "error")], 2);
    const seen = { [seenKey(host("h1", [], 1))]: 50 };
    expect(seenSeqOf(reconnected, seen)).toBe(0);
    expect(noticeBadge(reconnected.notices, seenSeqOf(reconnected, seen))).toEqual({
      count: 2,
      level: "error",
    });

    // **동률**: 옛 연결에서 seq 1까지 봤고, 새 연결의 첫 알림도 seq 1이다.
    // "카운터가 되감겼나"로는 이 경우를 못 잡는다(1 > 1 이 아니다) — 그래서
    // 새 오류가 영구히 숨었다.
    const tied = host("h1", [notice(1, "error")], 3);
    const seenTied = { [seenKey(host("h1", [], 1))]: 1 };
    expect(seenSeqOf(tied, seenTied)).toBe(0);
    expect(noticeBadge(tied.notices, seenSeqOf(tied, seenTied))).toEqual({
      count: 1,
      level: "error",
    });

    // **추월**: 폴링 사이에 다시 붙어 새 카운터가 옛 표시를 지나가 버렸다.
    // 되감김을 한 번도 관측하지 못했지만 1~5는 여전히 새 연결의 것이다.
    const overtaken = host("h1", [1, 2, 3, 4, 5].map((s) => notice(s, "warn")), 4);
    const seenOvertaken = { [seenKey(host("h1", [], 1))]: 3 };
    expect(noticeBadge(overtaken.notices, seenSeqOf(overtaken, seenOvertaken))).toEqual({
      count: 5,
      level: "warn",
    });

    // 같은 연결 안에서는 표시가 그대로 산다 — 매번 다시 보이면 배지가 무의미하다.
    const same = host("h1", [notice(1, "warn"), notice(2, "info")], 1);
    const seenSame = { [seenKey(same)]: 1 };
    expect(seenSeqOf(same, seenSame)).toBe(1);
    expect(noticeBadge(same.notices, seenSeqOf(same, seenSame))).toEqual({
      count: 1,
      level: "info",
    });
  });

  it("안 쓰이게 된 표시만 치운다", () => {
    const live = host("h1", [notice(1, "info")], 7);
    const seen = { [seenKey(live)]: 1, "h1#6": 40, "h2#1": 3 };
    // 지금 붙어 있는 연결의 표시는 남고, 떨어졌거나 옛 연결의 것만 지운다.
    expect(staleSeenKeys([live], seen).sort()).toEqual(["h1#6", "h2#1"]);
    expect(staleSeenKeys([live], { [seenKey(live)]: 1 })).toEqual([]);
    expect(staleSeenKeys([], {})).toEqual([]);
  });
});

describe("탭을 떠났다 돌아와도 타임라인이 남아 있다", () => {
  it("늦게 온 seed가 라이브 이벤트를 덮지 않는다", () => {
    const a = REMOTE_ID_BASE;
    const b = REMOTE_ID_BASE + 1;
    // 리스너를 먼저 달았고, seed 왕복 동안 a에 대한 이벤트가 도착했다.
    const current = new Map([[a, live(3, 1)]]);
    const livened = new Set([a]);
    // seed는 커맨드 왕복이라 항상 더 낡았다.
    const merged = mergeSeed(
      current,
      [
        { id: a, live: live(1, 0) },
        { id: b, live: live(2, 1) },
      ],
      livened,
    );
    expect(merged.get(a)?.items).toHaveLength(3); // 이벤트가 이긴다
    expect(merged.get(b)?.items).toHaveLength(2); // 빈 자리는 채운다
  });

  it("이벤트가 하나도 없었으면 seed가 그대로 화면이 된다", () => {
    const id = REMOTE_ID_BASE + 9;
    const merged = mergeSeed(new Map(), [{ id, live: live(4, 2) }], new Set());
    expect(merged.get(id)?.items).toHaveLength(4);
  });
});

describe("종료된 세션의 본문", () => {
  it("'항목 0'이 아니라 '본문 생략됨 · N개'라고 말한다", () => {
    // 없음과 0의 혼동 — `items_omitted`가 정확히 이걸 막으려고 있는 값이다.
    expect(countsLabel(meta({ body_omitted: true, timeline_len: 12 }))).toContain("본문 생략됨");
    expect(countsLabel(meta({ body_omitted: true, timeline_len: 12 }))).toContain("12개");
    // 진짜로 아무것도 안 한 세션은 0이 맞다.
    expect(countsLabel(meta({ body_omitted: true, timeline_len: 0 }))).toBe("턴 0 · 항목 0");
    expect(countsLabel(meta({ items: 3, turns: 2 }))).toBe("턴 2 · 항목 3");
    // 본문을 가져오고 나면 실제 개수를 보인다.
    expect(countsLabel(meta({ body_omitted: true, timeline_len: 12 }), live(12, 3))).toBe(
      "턴 3 · 항목 12",
    );
  });

  it("본문이 없고 데몬이 갖고 있을 때만 회수한다", () => {
    expect(shouldFetchBody(meta({ body_omitted: true, timeline_len: 5 }), undefined)).toBe(true);
    expect(shouldFetchBody(meta({ timeline_len: 5 }), undefined)).toBe(true);
    // 이미 본문이 있으면 다시 가져오지 않는다.
    expect(shouldFetchBody(meta({ body_omitted: true, timeline_len: 5 }), live(5, 1))).toBe(false);
    // 데몬에도 없는 것은 가져올 곳이 없다.
    expect(shouldFetchBody(meta({ timeline_len: 0 }), undefined)).toBe(false);
  });

  it("갭 뒤 빈 스냅샷이 방금 가져온 본문을 지우지 않는다", () => {
    const body = live(7, 2);
    // 끝난 세션은 갭마다 빈 payload가 다시 온다.
    expect(pickTimeline(live(0, 0), body)).toBe(body);
    expect(pickTimeline(undefined, body)).toBe(body);
    // 반대로 스트림이 실제로 주고 있으면 그것이 정본이다.
    const streaming = live(2, 1);
    expect(pickTimeline(streaming, body)).toBe(streaming);
    expect(pickTimeline(undefined, undefined)).toBeUndefined();
  });

  it("회수 응답을 라이브와 같은 모양으로 읽는다", () => {
    const l = fetchedToLive({
      session_id: "u",
      total: 2,
      items: [item("b", 2), item("a", 1)],
      turns: [[1, "질문"]],
      model: "claude-opus-5",
      last_usage: { input: 2, output: 5, cache_read: 10, cache_creation: 3 },
    });
    expect(l.items.map((i) => i.tool_call_id)).toEqual(["a", "b"]);
    expect(l.turns).toEqual([[1, "질문"]]);
    expect(l.ctxTokens).toBe(15);
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
