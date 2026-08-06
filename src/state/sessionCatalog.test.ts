import { describe, expect, it } from "vitest";
import {
  EMPTY_EXTERNAL,
  adoptable,
  archBusyUpdate,
  buildSessionSummaries,
  externalRows,
  liveBadge,
  openSessionIds,
  pickerLoadOutcome,
  pickerRows,
  type ExternalSessionRow,
  type SessionSummary,
} from "./sessionCatalog";

const row = (uuid: string, date: string): SessionSummary => ({
  id: uuid,
  date,
  name: uuid,
  title: "",
  count: 0,
  project: "/p",
  archState: "none",
  archivedAt: null,
  versions: 0,
});

describe("buildSessionSummaries", () => {
  const raw = [
    { uuid: "u1", name: "A", title: "t1", date: "2026-07-01", count: 3 },
    { uuid: "u2", name: "B", title: "t2", date: "2026-07-02", count: 5 },
    { uuid: "u3", name: "C", title: "t3", date: "2026-07-03", count: 1 },
  ];
  const statuses = [
    { uuid: "u1", up_to_date: true, archived_at: 1700000000, versions: 2 },
    { uuid: "u2", up_to_date: false, archived_at: 1600000000, versions: 0 },
    // u3에는 상태 행이 없다.
  ];

  it("아카이브 상태를 current/stale/none 3분류로 매핑", () => {
    const out = buildSessionSummaries(raw, statuses, "/proj");
    expect(out.map((s) => s.archState)).toEqual(["current", "stale", "none"]);
  });

  it("archivedAt·versions는 상태 행에서, 없으면 null/0", () => {
    const out = buildSessionSummaries(raw, statuses, "/proj");
    expect(out[0].archivedAt).toBe(1700000000);
    expect(out[0].versions).toBe(2);
    expect(out[2].archivedAt).toBeNull();
    expect(out[2].versions).toBe(0);
  });

  it("project는 모든 행에 pin된다 (cross-project resume 의미 보존)", () => {
    const out = buildSessionSummaries(raw, statuses, "/proj");
    expect(out.every((s) => s.project === "/proj")).toBe(true);
  });

  it("상태 목록이 비어도 전부 none — 조용한 행 누락 없음", () => {
    const out = buildSessionSummaries(raw, [], "/proj");
    expect(out).toHaveLength(3);
    expect(out.every((s) => s.archState === "none")).toBe(true);
  });
});

describe("openSessionIds", () => {
  it("문자열 sessionId·sessionUuid·loadSessionId를 모두 모은다", () => {
    const ids = openSessionIds([
      { sessionId: "s-str" },
      { sessionUuid: "s-uuid" },
      { loadSessionId: "s-load" },
      undefined,
    ]);
    expect([...ids].sort()).toEqual(["s-load", "s-str", "s-uuid"]);
  });

  it("숫자 sessionId(claudeterm PTY id)는 세션 id가 아니다", () => {
    const ids = openSessionIds([{ sessionId: 42, sessionUuid: "u" }]);
    expect(ids.has("42")).toBe(false);
    expect([...ids]).toEqual(["u"]);
  });
});

describe("pickerRows", () => {
  const all = [row("u1", "2026-07-01"), row("u3", "2026-07-03"), row("u2", "2026-07-02")];

  it("최신순 정렬", () => {
    expect(pickerRows(all, new Set()).map((s) => s.id)).toEqual(["u3", "u2", "u1"]);
  });

  it("이미 열린 세션은 제외 (B3-2)", () => {
    expect(pickerRows(all, new Set(["u3"])).map((s) => s.id)).toEqual(["u2", "u1"]);
    expect(pickerRows(all, new Set(["u1", "u2", "u3"]))).toEqual([]);
  });

  it("입력 배열을 변형하지 않는다 (정렬 in-place 금지)", () => {
    const before = all.map((s) => s.id);
    pickerRows(all, new Set());
    expect(all.map((s) => s.id)).toEqual(before);
  });
});

describe("archBusyUpdate — in_flight 세대 가드", () => {
  it("최신 세대의 성공 응답은 그대로 반영", () => {
    expect(archBusyUpdate(7, 7, { ok: true, value: true })).toBe(true);
    expect(archBusyUpdate(7, 7, { ok: true, value: false })).toBe(false);
  });

  it("낡은 세대는 성공이든 실패든 무시 (배지 되돌림 차단)", () => {
    expect(archBusyUpdate(9, 7, { ok: true, value: true })).toBeNull();
    expect(archBusyUpdate(9, 7, { ok: false })).toBeNull();
  });

  it("최신 세대의 실패는 fail-soft로 미표시 — busy 고착 금지", () => {
    expect(archBusyUpdate(7, 7, { ok: false })).toBe(false);
  });
});

describe("외부 세션 — adoptable / liveBadge", () => {
  const ext = (
    live: ExternalSessionRow["live"],
    reason: ExternalSessionRow["reason"] = null,
  ): ExternalSessionRow => ({
    uuid: "u1",
    title: "터미널 세션",
    cwd: "/home/jun/proj",
    modified: 1_784_000_000,
    live,
    reason,
  });

  it("free만 붙일 수 있다", () => {
    expect(adoptable(ext("free"))).toBe(true);
    expect(adoptable(ext("live", "this_session"))).toBe(false);
  });

  it("unknown은 막는다 — 판정 실패는 보수적으로 차단(전사 이중 append 방지)", () => {
    expect(adoptable(ext("unknown", "written_since_start"))).toBe(false);
    expect(adoptable(ext("unknown", "undecidable"))).toBe(false);
    expect(liveBadge(ext("unknown", "written_since_start"))?.label).toBe("확인 불가");
  });

  it("붙을 수 있는 행에는 배지가 없다", () => {
    expect(liveBadge(ext("free"))).toBeNull();
    expect(liveBadge(ext("live", "this_session"))?.label).toBe("사용 중");
  });

  it("확인 불가 두 종류의 안내가 갈린다 — 판정 불가에 '나머지는 열린다'고 하지 않는다", () => {
    const threshold = liveBadge(ext("unknown", "written_since_start"))!.hint;
    const undecidable = liveBadge(ext("unknown", "undecidable"))!.hint;
    expect(threshold).not.toBe(undecidable);
    // 시각 임계: 더 오래된 세션은 열린다고 말해도 참이다.
    expect(threshold).toContain("이전에 마지막으로 쓰인 세션은 그대로 열 수 있습니다");
    // 판정 불가: 그 말은 거짓이므로 없어야 하고, 전면 차단임을 말해야 한다.
    expect(undecidable).not.toContain("그대로 열 수 있습니다");
    expect(undecidable).toContain("어떤 외부 세션도 열 수 없습니다");
    // 사유를 모르는(구버전) 응답도 안전한 쪽 문구로 떨어진다.
    expect(liveBadge(ext("unknown", null))!.hint).toBe(undecidable);
  });
});

describe("externalRows — 최신순 + 열린 세션 제외", () => {
  const rows: ExternalSessionRow[] = [
    { uuid: "a", title: "A", cwd: "/p", modified: 100, live: "free", reason: null },
    { uuid: "b", title: "B", cwd: "/p", modified: 300, live: "live", reason: "this_session" },
    { uuid: "c", title: "C", cwd: "/p", modified: 200, live: "free", reason: null },
  ];

  it("mtime 내림차순", () => {
    expect(externalRows(rows, new Set()).map((r) => r.uuid)).toEqual(["b", "c", "a"]);
  });

  it("이미 열린 세션은 빠진다", () => {
    expect(externalRows(rows, new Set(["b"])).map((r) => r.uuid)).toEqual(["c", "a"]);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const before = rows.map((r) => r.uuid);
    externalRows(rows, new Set());
    expect(rows.map((r) => r.uuid)).toEqual(before);
  });

  it("숨긴 행도 같은 규칙을 탄다 — 숨김은 표시 여부일 뿐 다른 목록이 아니다", () => {
    const hidden: ExternalSessionRow[] = [
      { uuid: "h1", title: "삭제한 세션", cwd: "/p", modified: 100, live: "free", reason: null },
      { uuid: "h2", title: "삭제한 세션2", cwd: "/p", modified: 400, live: "free", reason: null },
    ];
    expect(externalRows(hidden, new Set()).map((r) => r.uuid)).toEqual(["h2", "h1"]);
    // 숨김이라도 이미 열려 있으면 (토글로 펼쳐도) 다시 제안하지 않는다.
    expect(externalRows(hidden, new Set(["h2"])).map((r) => r.uuid)).toEqual(["h1"]);
  });
});

describe("EMPTY_EXTERNAL — 조회 실패 시의 빈 응답", () => {
  it("세 필드가 모두 비어 있다 (섹션 자체가 사라지는 상태)", () => {
    expect(EMPTY_EXTERNAL).toEqual({ sessions: [], hidden: [], hidden_count: 0 });
  });
});

describe("pickerLoadOutcome — 피커 조회 세대 + 프로젝트 바인딩", () => {
  it("최신 세대이고 프로젝트가 그대로면 반영", () => {
    expect(pickerLoadOutcome(3, 3, "/a", "/a")).toBe("apply");
    expect(pickerLoadOutcome(1, 1, null, null)).toBe("apply");
  });

  it("더 새 조회가 시작됐으면 낡은 응답 — 버린다", () => {
    expect(pickerLoadOutcome(5, 3, "/a", "/a")).toBe("stale");
  });

  it("조회 사이 프로젝트가 바뀌었으면 남의 목록 — 버리고 재조회", () => {
    // 세대는 최신이지만 응답은 /a 것이고 화면은 /b다. 세대만으로는 못 막는다.
    expect(pickerLoadOutcome(3, 3, "/a", "/b")).toBe("switched");
    expect(pickerLoadOutcome(3, 3, "/a", null)).toBe("switched");
  });

  it("세대 판정이 프로젝트 판정보다 우선 — 낡은 응답은 프로젝트와 무관하게 버린다", () => {
    expect(pickerLoadOutcome(5, 3, "/a", "/b")).toBe("stale");
  });
});
