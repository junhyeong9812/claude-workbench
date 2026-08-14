import { describe, expect, it } from "vitest";
import {
  accountChoices,
  attachGate,
  countsLabel,
  defaultAccountId,
  endedReason,
  fetchedToLive,
  isRemoteId,
  itemCutNote,
  killGate,
  killLabel,
  mergeSeed,
  noticeBadge,
  parseAccounts,
  phaseLabel,
  pickTimeline,
  resumeLabel,
  seenKey,
  seenSeqOf,
  sessionCountNote,
  shouldAutoFetchBody,
  shouldFetchBody,
  nextRemoteResize,
  shouldSendRemoteResize,
  signalLabel,
  spawnRequest,
  shouldAutoLoadSubagent,
  staleSeenKeys,
  subagentAttemptKey,
  subagentBodyIsFresh,
  toLiveTimeline,
  turnMetaLabel,
  unseenNotices,
  REMOTE_ID_BASE,
  type RemoteHostSnapshot,
  type RemoteLiveTimeline,
  type RemoteNotice,
  type RemoteSessionMeta,
  type RemoteSubagentFrame,
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
    answers: [],
    dates: [],
    tokens: [],
    subagents: [],
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

  it("자동 회수는 **내용**이 아니라 **시도**로 정해진다 (R1)", () => {
    const empty = live(0, 0);
    const fresh = { attempted: false, fetching: false, failed: false };
    const s = meta({ body_omitted: true, timeline_len: 0 });
    // 처음 펼쳤을 때는 가져온다.
    expect(shouldAutoFetchBody(s, undefined, fresh)).toBe(true);
    // …그리고 회수가 **성공했는데 본문이 비어도** 다시 가져가지 않는다. 이게
    // 무한 SSH 루프가 살던 자리다: `shouldFetchBody` 는 여전히 true 를 돌려주고
    // (가져올 수는 있으니까) 그것만으로 자동 회수를 정하면 effect 가 영원히
    // 재발화한다 — 실측 1,400회 이상/5초, 매 회차가 새 SSH 연결.
    expect(shouldFetchBody(s, empty)).toBe(true);
    expect(shouldAutoFetchBody(s, empty, { ...fresh, attempted: true })).toBe(false);
    // 나가 있는 회수가 있거나 지난 회수가 실패로 끝났으면 자동으로 또 걸지 않는다.
    expect(shouldAutoFetchBody(s, undefined, { ...fresh, fetching: true })).toBe(false);
    expect(shouldAutoFetchBody(s, undefined, { ...fresh, failed: true })).toBe(false);
    // 데몬에도 없는 것은 여전히 가져올 곳이 없다.
    expect(shouldAutoFetchBody(meta({ timeline_len: 0 }), undefined, fresh)).toBe(false);
    // 본문이 실제로 있으면 애초에 회수 대상이 아니다.
    expect(shouldAutoFetchBody(s, live(3, 1), fresh)).toBe(false);
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
      answers: [[1, "답변"]],
      dates: [[1, "2026-08-13"]],
      tokens: [[1, { input: 1, output: 2, cache_read: 0, cache_creation: 0 }]],
      model: "claude-opus-5",
      last_usage: { input: 2, output: 5, cache_read: 10, cache_creation: 3 },
      subagent: null,
      subagents: [],
    });
    expect(l.items.map((i) => i.tool_call_id)).toEqual(["a", "b"]);
    expect(l.turns).toEqual([[1, "질문"]]);
    expect(l.ctxTokens).toBe(15);
    // R2b ⓓ: 회수한 본문이 스트림보다 가난하면 안 된다 — 답변까지 온다.
    expect(l.answers).toEqual([[1, "답변"]]);
    expect(l.dates).toEqual([[1, "2026-08-13"]]);
    expect(l.tokens).toEqual([[1, { input: 1, output: 2, cache_read: 0, cache_creation: 0 }]]);
    expect(l.subagents).toEqual([]);
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

  it("데몬이 실어 보낸 답변·날짜·턴 토큰을 버리지 않는다 (R2b ⓓ)", () => {
    // 데몬은 R2b 부터 이 셋을 계산해 **보낸다**. 여기서 버리면 화면에는 질문만
    // 남고, "로컬과 같은 내용"이라는 이 단계의 목표가 payload 에서 멈춘다.
    const e: ClaudeTimelineEvent = {
      id: REMOTE_ID_BASE + 2,
      items: [],
      turns: [[1, "질문"]],
      answers: [[1, "답변"]],
      dates: [[1, "2026-08-13"]],
      tokens: [[1, { input: 3, output: 4, cache_read: 0, cache_creation: 0 }]],
      subagents: [],
    };
    const live = toLiveTimeline(e);
    expect(live.answers).toEqual([[1, "답변"]]);
    expect(live.dates).toEqual([[1, "2026-08-13"]]);
    expect(live.tokens).toEqual([[1, { input: 3, output: 4, cache_read: 0, cache_creation: 0 }]]);
  });

  it("생산자가 항상 쓰는 필드가 빠지면 **드러낸다** — 빈 타임라인으로 감추지 않는다 (R12)", () => {
    // Rust 는 `turns`·`answers`·`dates`·`tokens`·`items` 를 항상 직렬화하고 키
    // 집합까지 테스트로 못박았다. 그래서 안 온 것은 "없다"가 아니라 계약이 깨진
    // 것이다 — `?? []` 로 흡수하면 이름 변경·생산자 정지가 예외 대신 **조용한 빈
    // 타임라인**이 되고, 화면은 "아무 일도 없었다"를 정직한 답으로 보인다.
    const full: ClaudeTimelineEvent = {
      id: REMOTE_ID_BASE + 3,
      items: [],
      turns: [],
      answers: [],
      dates: [],
      tokens: [],
      subagents: [],
    };
    for (const missing of ["items", "turns", "answers", "dates", "tokens"] as const) {
      const broken = { ...full } as Record<string, unknown>;
      delete broken[missing];
      expect(() => toLiveTimeline(broken as unknown as ClaudeTimelineEvent)).toThrow(missing);
    }
    // 회수 경로(`remote_timeline` 응답)도 같은 계약이다.
    const reply = {
      session_id: "u",
      total: 0,
      items: [],
      turns: [],
      answers: [],
      dates: [],
      tokens: [],
      model: null,
      last_usage: null,
    };
    for (const missing of ["items", "turns", "answers", "dates", "tokens"] as const) {
      const broken = { ...reply } as Record<string, unknown>;
      delete broken[missing];
      expect(() => fetchedToLive(broken as never)).toThrow(missing);
    }
    // 배열이 아닌 값(이름은 같은데 형이 바뀐 경우)도 같다.
    expect(() => toLiveTimeline({ ...full, turns: null } as never)).toThrow("turns");
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
    // 옛 데몬은 이 셋을 아예 안 보낸다 — 빈 것이 그 생산자의 정직한 답이다.
    expect(live.answers).toEqual([]);
    expect(live.dates).toEqual([]);
    expect(live.tokens).toEqual([]);
  });
});

describe("버튼이 할 수 있는 일 (R2b)", () => {
  it("끝난 세션에는 종료도 터미널도 걸지 않는다 — 그리고 왜 못 누르는지 말한다", () => {
    const running = meta({ state: "running", closed: false });
    expect(killGate(running, false)).toEqual({
      enabled: true,
      hint: expect.stringContaining("종료 신호"),
    });
    expect(attachGate(running, false, false).enabled).toBe(true);

    // 이미 끝난 세션: 신호를 보내면 데몬이 거절할 뿐이고, 붙을 pty도 없다.
    for (const dead of [meta({ state: "exited", closed: true }), meta({ state: "exited", closed: false }), meta({ state: "running", closed: true })]) {
      expect(killGate(dead, false).enabled).toBe(false);
      expect(attachGate(dead, false, false).enabled).toBe(false);
      // 비활성 이유가 비어 있으면 회색 버튼만 남는다 — 그게 조용한 손실이다.
      expect(killGate(dead, false).hint).not.toBe("");
      expect(attachGate(dead, false, false).hint).not.toBe("");
    }
  });

  it("보내는 중이면 두 번 눌리지 않고, 이미 열린 터미널은 다시 열지 않는다", () => {
    const running = meta({ state: "running", closed: false });
    expect(killGate(running, true).enabled).toBe(false);
    expect(killGate(running, true).hint).toContain("중");
    expect(attachGate(running, true, false).enabled).toBe(false);
    // 이 세션이 이미 아래에 떠 있다 — 다시 붙이면 채널만 하나 더 생긴다.
    expect(attachGate(running, false, true).enabled).toBe(false);
    expect(attachGate(running, false, true).hint).toContain("이미");
  });
});

describe("계정 목록 읽기", () => {
  const reply = {
    response: "accounts",
    accounts: [
      { id: "work", agent: "claude", display_name: "회사", home: "/home/me/.claude-work" },
      { id: "personal", agent: "claude", home: "/home/me/.claude", is_default: true },
      { id: "cx", agent: "codex", display_name: "codex 기본" },
      { agent: "claude", display_name: "id 없는 줄", home: "/home/me/.claude-x" },
    ],
  };

  it("id 없는 줄은 버린다 — 고를 수 없는데 보이면 사용자를 속인다", () => {
    const accounts = parseAccounts(reply);
    expect(accounts.map((a) => a.id)).toEqual(["work", "personal", "cx"]);
    // display_name 이 없으면 id 로 말한다(빈 옵션을 만들지 않는다).
    expect(accounts.find((a) => a.id === "personal")?.displayName).toBe("personal");
    expect(accounts.find((a) => a.id === "work")?.displayName).toBe("회사");
    expect(accounts.find((a) => a.id === "personal")?.isDefault).toBe(true);
    expect(accounts.find((a) => a.id === "work")?.isDefault).toBe(false);
  });

  it("응답이 기대와 다르면 빈 목록이다 — 던지지 않는다", () => {
    expect(parseAccounts(null)).toEqual([]);
    expect(parseAccounts({})).toEqual([]);
    expect(parseAccounts({ accounts: "nope" })).toEqual([]);
    expect(parseAccounts({ accounts: [null, 3, { id: "  " }] })).toEqual([]);
  });

  it("에이전트에 맞는 계정만 고르게 하고, 기본 계정을 먼저 세운다", () => {
    const accounts = parseAccounts(reply);
    expect(accountChoices(accounts, "claude").map((a) => a.id)).toEqual(["work", "personal"]);
    expect(accountChoices(accounts, "codex").map((a) => a.id)).toEqual(["cx"]);
    // is_default 가 있으면 그것, 없으면 첫 줄, 아무것도 없으면 "" (데몬 기본값).
    expect(defaultAccountId(accounts, "claude")).toBe("personal");
    expect(defaultAccountId(accounts, "codex")).toBe("cx");
    expect(defaultAccountId([], "claude")).toBe("");
    // 에이전트가 적히지 않은 계정은 어느 쪽에서도 고를 수 있다.
    const anyAgent = parseAccounts({ accounts: [{ id: "shared" }] });
    expect(accountChoices(anyAgent, "codex").map((a) => a.id)).toEqual(["shared"]);
  });
});

describe("새 세션 요청 만들기", () => {
  const known = ["work", "personal"];
  const form = { agent: "claude", cwd: "/home/me/project", account: "work", label: "야간 작업" };

  it("경로를 계정 자리에 밀어 넣을 수 없다 — 목록에 있는 id 만 지나간다", () => {
    // 데몬이 경로 필드를 없앤(R1b) 것이 프런트에서 되살아나면 안 된다.
    const smuggled = spawnRequest("h1", { ...form, account: "/home/me/.claude-other" }, known);
    expect(smuggled.ok).toBe(false);
    expect(smuggled.ok === false && smuggled.error).toContain("목록");
    // 목록에 없는 평범한 문자열도 마찬가지다(오타 포함).
    expect(spawnRequest("h1", { ...form, account: "wrok" }, known).ok).toBe(false);
    // 빈 값은 "데몬 기본 계정"이라는 뜻이라 통과하고, null 로 나간다.
    const dflt = spawnRequest("h1", { ...form, account: "" }, known);
    expect(dflt.ok && dflt.args.account).toBeNull();
  });

  it("상대 경로로는 못 띄운다 — 어디서 도는지 모르는 에이전트를 만들지 않는다", () => {
    const rel = spawnRequest("h1", { ...form, cwd: "project" }, known);
    expect(rel.ok).toBe(false);
    expect(rel.ok === false && rel.error).toContain("절대 경로");
    const empty = spawnRequest("h1", { ...form, cwd: "   " }, known);
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.error).toContain("디렉터리");
  });

  it("아는 에이전트만, 그리고 공백은 다듬어 넘긴다", () => {
    expect(spawnRequest("h1", { ...form, agent: "gemini" }, known).ok).toBe(false);
    const r = spawnRequest(
      "h1",
      { agent: "codex", cwd: "  /srv/app  ", account: "", label: "  " },
      known,
    );
    expect(r.ok && r.args).toEqual({
      hostId: "h1",
      agent: "codex",
      cwd: "/srv/app",
      account: null,
      // 빈 라벨은 빈 문자열이 아니라 없음이다(데몬이 빈 라벨을 달지 않게).
      label: null,
    });
    const full = spawnRequest("h1", form, known);
    expect(full.ok && full.args).toEqual({
      hostId: "h1",
      agent: "claude",
      cwd: "/home/me/project",
      account: "work",
      label: "야간 작업",
    });
    expect(spawnRequest("", form, known).ok).toBe(false);
  });
});

describe("원격 pty 크기 보내기", () => {
  it("퇴화 크기와 같은 크기를 원격까지 보내지 않는다", () => {
    // 호스트가 0px 로 접히면 FitAddon 이 2×1 을 준다 — 그대로 보내면 원격
    // 전체화면 TUI 가 실제로 2×1 이 되어 화면이 부서진다.
    expect(shouldSendRemoteResize(null, { cols: 2, rows: 1 })).toBe(false);
    expect(shouldSendRemoteResize(null, { cols: 9, rows: 24 })).toBe(false);
    expect(shouldSendRemoteResize(null, { cols: 80, rows: 2 })).toBe(false);
    expect(shouldSendRemoteResize(null, { cols: 80, rows: 24 })).toBe(true);
    // 같은 값은 SSH 왕복만 늘린다 — 드래그가 멎은 뒤 한 번이면 된다.
    expect(shouldSendRemoteResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    expect(shouldSendRemoteResize({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(true);
    // 레이아웃이 준 소수·NaN 은 pty 크기가 아니다.
    expect(shouldSendRemoteResize(null, { cols: 80.5, rows: 24 })).toBe(false);
    expect(shouldSendRemoteResize(null, { cols: Number.NaN, rows: 24 })).toBe(false);
  });

  it("**실패한** 리사이즈가 그 크기를 봉인하지 않는다 — 기준은 확인된 크기다", () => {
    // 보낸 값을 곧바로 "마지막"으로 적으면, 실패해도 같은 크기가 영원히 중복
    // 취급된다: 사용자가 창을 되돌려 맞춰도 안 나가고 원격 pty 는 틀린 채 남는다.
    const failed = { acked: null, inFlight: null };
    expect(nextRemoteResize(failed, { cols: 100, rows: 30 })).toBe(true);
    // 답을 기다리는 동안 같은 크기가 또 멎어도 왕복을 두 번 하지는 않는다.
    const waiting = { acked: null, inFlight: { cols: 100, rows: 30 } };
    expect(nextRemoteResize(waiting, { cols: 100, rows: 30 })).toBe(false);
    expect(nextRemoteResize(waiting, { cols: 101, rows: 30 })).toBe(true);
    // 확인된 크기와 같으면 보내지 않는다.
    const settled = { acked: { cols: 100, rows: 30 }, inFlight: null };
    expect(nextRemoteResize(settled, { cols: 100, rows: 30 })).toBe(false);
    expect(nextRemoteResize(settled, { cols: 100, rows: 31 })).toBe(true);
    // 데몬이 **조정한** 크기가 기준이 된다: 100x30 을 청했는데 90x30 이 왔다면
    // 다음에 100x30 이 다시 멎었을 때 그것은 새 요청이다.
    const clamped = { acked: { cols: 90, rows: 30 }, inFlight: null };
    expect(nextRemoteResize(clamped, { cols: 100, rows: 30 })).toBe(true);
    // 퇴화 크기 백스톱은 그대로 통과한다.
    expect(nextRemoteResize(settled, { cols: 2, rows: 1 })).toBe(false);
  });
});

describe("종료 결과 말하기", () => {
  it("요청한 신호가 아니라 **전달된** 신호를 말한다", () => {
    // 데몬은 프로세스 그룹이 이미 사라졌으면 SIGHUP 으로 갈아탄다.
    expect(killLabel(15, 1)).toContain("SIGHUP(1)");
    expect(killLabel(15, 1)).toContain("SIGTERM(15)");
    expect(killLabel(15, 1)).toContain("요청");
    // 요청대로 갔으면 굳이 두 번 말하지 않는다.
    expect(killLabel(15, 15)).toBe("종료 신호를 보냈습니다 — SIGTERM(15)");
    expect(killLabel(null, 9)).toContain("SIGKILL(9)");
    // 모르는 번호도 숫자로는 말한다(침묵하지 않는다).
    expect(signalLabel(37)).toBe("신호 37");
  });
});

describe("원격 터미널이 멈춘 이유", () => {
  it("정상 종료·비정상 종료·시작 실패가 서로 다른 말이 된다", () => {
    const normal = endedReason({ code: 0, signal: null, detail: "" });
    const failed = endedReason({ code: 2, signal: null, detail: "" });
    const killed = endedReason({ code: null, signal: "SIGKILL", detail: "" });
    // 시작조차 못 한 경우 — code·signal 이 없고 stderr 만 있다.
    const refused = endedReason({
      code: null,
      signal: null,
      detail: "cwcd: command not found",
    });
    expect(normal).toContain("정상");
    expect(failed).toContain("exit 2");
    expect(killed).toContain("SIGKILL");
    expect(refused).toContain("cwcd: command not found");
    expect(new Set([normal, failed, killed, refused]).size).toBe(4);
  });

  it("사유가 없어도 빈 줄을 내지 않는다 — 조용한 검은 상자가 이 이벤트의 이유다", () => {
    const blank = endedReason({ code: null, signal: null, detail: "   " });
    expect(blank).not.toBe("");
    expect(blank).toContain("알 수 없");
    // 여러 줄 stderr 는 한 줄로 눕히고, 길면 자른다(줄 하나에 실린다).
    const multi = endedReason({ code: 1, signal: null, detail: "첫 줄\n  둘째 줄\n" });
    expect(multi).toContain("첫 줄 둘째 줄");
    expect(multi).not.toContain("\n");
    const long = endedReason({ code: 1, signal: null, detail: "x".repeat(1000) });
    expect(long.length).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// R7 (a) — 원격 타임라인이 로컬과 "같은 내용"을 보인다: 날짜·턴별 토큰·본문·잘림
// ---------------------------------------------------------------------------

describe("R7 — 턴의 날짜와 토큰이 화면에 닿는다", () => {
  it("날짜와 토큰이 한 줄로 합쳐지고, 둘 다 없으면 줄을 만들지 않는다", () => {
    const dates = new Map([[1, "2026-08-13"]]);
    const tokens = new Map([
      [1, { input: 100, output: 20, cache_read: 5, cache_creation: 7 }],
    ]);
    const both = turnMetaLabel(1, dates, tokens);
    expect(both).toContain("2026-08-13");
    // ↑ = 새로 처리한 컨텍스트(input + cache_creation), ↓ = 생성 출력 —
    // 로컬 `sumTokenTotals` 와 같은 정의여야 두 화면이 다른 숫자를 말하지 않는다.
    expect(both).toContain("107");
    expect(both).toContain("20");
    // 날짜만·토큰만·아무것도 없음 — 셋이 서로 다른 답이다.
    expect(turnMetaLabel(1, dates, new Map())).toBe("2026-08-13");
    expect(turnMetaLabel(1, new Map(), tokens)).not.toContain("2026");
    expect(turnMetaLabel(9, dates, tokens)).toBeNull();
  });

  it("0 토큰은 숫자를 만들어 내지 않는다", () => {
    const zero = new Map([[1, { input: 0, output: 0, cache_read: 0, cache_creation: 0 }]]);
    expect(turnMetaLabel(1, new Map(), zero)).toBeNull();
  });
});

describe("R7 — 항목 목록의 잘림은 화면이 말한다", () => {
  it("최근 N 개만 그렸으면 전체 개수와 함께 그 사실이 문장으로 나온다", () => {
    const note = itemCutNote(57, 12);
    expect(note).not.toBeNull();
    expect(note).toContain("57");
    expect(note).toContain("12");
    // 다 보이면 할 말이 없다 — 없는 잘림을 지어내지 않는다.
    expect(itemCutNote(12, 12)).toBeNull();
    expect(itemCutNote(3, 12)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R7 (b) — 서브에이전트: 메타는 밀고, 본문은 펼칠 때 당긴다
// ---------------------------------------------------------------------------

function frame(over: Partial<RemoteSubagentFrame> = {}): RemoteSubagentFrame {
  return {
    id: "a7",
    parent: "call-2",
    turn: 1,
    total: 5,
    completed: 3,
    last_status: "in_progress",
    sig: "42-7",
    items: null,
    ...over,
  };
}

describe("R7 — 서브에이전트 메타는 필수다", () => {
  it("생산자가 항상 쓰는 필드라 없으면 빈 목록이 아니라 예외다", () => {
    const e = {
      id: REMOTE_ID_BASE,
      items: [],
      turns: [],
      answers: [],
      dates: [],
      tokens: [],
      model: null,
      last_usage: null,
    } as unknown as ClaudeTimelineEvent;
    // `?? []` 로 받으면 "에이전트를 안 돌렸다"와 "계약이 깨졌다"가 같은 화면이
    // 된다 — R7 이 지적한 결함이 정확히 그 동일시였다.
    expect(() => toLiveTimeline(e)).toThrow();
  });
});

describe("R7 — 회수한 본문의 신선도는 파일 서명이 정한다", () => {
  it("서명이 같을 때만 유효하고, 서명이 없으면 유효하다고 하지 않는다", () => {
    const items = [item("s1", 1)];
    expect(subagentBodyIsFresh({ sig: "42-7", items }, frame())).toBe(true);
    // 에이전트가 재활성되어 전사가 달라지면 들고 있던 본문은 낡은 것이다.
    expect(subagentBodyIsFresh({ sig: "42-7", items }, frame({ sig: "99-1" }))).toBe(false);
    expect(subagentBodyIsFresh(undefined, frame())).toBe(false);
    // 서명이 없으면 무효화할 방법이 없다 — 조용히 옛 본문을 보이지 않는다.
    expect(subagentBodyIsFresh({ sig: null, items }, frame({ sig: null }))).toBe(false);
  });
});

describe("R7 — 서브에이전트 자동 회수도 축이 **시도**다", () => {
  it("한 번 시도했으면 다시 자동으로 나가지 않는다 (R1 무한 SSH 루프 재발 방지)", () => {
    const idle = { attempted: false, fetching: false, failed: false };
    expect(shouldAutoLoadSubagent(idle, false)).toBe(true);
    // 시도했으면 — 성공이든 빈 응답이든 — 자동은 끝이다.
    expect(shouldAutoLoadSubagent({ ...idle, attempted: true }, false)).toBe(false);
    expect(shouldAutoLoadSubagent({ ...idle, fetching: true }, false)).toBe(false);
    expect(shouldAutoLoadSubagent({ ...idle, failed: true }, false)).toBe(false);
    // 이미 신선한 본문이 있으면 나갈 이유가 없다.
    expect(shouldAutoLoadSubagent(idle, true)).toBe(false);
  });

  it("시도 표시는 **서명별**이라 재활성된 에이전트는 한 번 더 받고 거기서 멈춘다", () => {
    const a = subagentAttemptKey(REMOTE_ID_BASE, frame());
    const same = subagentAttemptKey(REMOTE_ID_BASE, frame());
    const grown = subagentAttemptKey(REMOTE_ID_BASE, frame({ sig: "99-1" }));
    const other = subagentAttemptKey(REMOTE_ID_BASE + 1, frame());
    expect(a).toBe(same);
    expect(a).not.toBe(grown);
    expect(a).not.toBe(other);
    // 서명이 없어도 키는 안정적이다 — 없으면 매번 새 키가 되어 루프가 된다.
    expect(subagentAttemptKey(1, frame({ sig: null }))).toBe(
      subagentAttemptKey(1, frame({ sig: null })),
    );
  });
});

// ---------------------------------------------------------------------------
// R10 — 만들었으나 소비자가 없던 표면: 화면에 닿거나, 없어지거나
// ---------------------------------------------------------------------------

describe("R10 — 호스트에 직접 물어본 세션 수", () => {
  /**
   * 스트림이 뒤처졌는지 호스트가 한가한지를 **화면에서** 가를 수단.
   *
   * 이 판정이 없으면 빈 목록은 두 가지를 동시에 뜻한다: 호스트에 아무것도 안
   * 돌거나, 이 워크벤치가 놓쳤거나. 둘은 사용자가 해야 할 일이 정반대다.
   */
  it("같으면 같다고, 다르면 무엇이 다른지 숫자로 말한다", () => {
    const same = sessionCountNote(3, 3);
    expect(same).toContain("3");
    expect(same).not.toContain("뒤처");

    const behind = sessionCountNote(5, 2);
    expect(behind).toContain("5");
    expect(behind).toContain("2");
    expect(behind, "다르다는 사실이 말이 되어 나오지 않는다").toMatch(/뒤처|놓친/);
    // 반대 방향(화면이 더 많이 아는 것)도 침묵하지 않는다 — 데몬이 정리한 세션을
    // 이 화면만 아직 들고 있는 경우다.
    expect(sessionCountNote(0, 2)).toMatch(/뒤처|놓친/);
  });
});
