import { describe, expect, it } from "vitest";
import {
  archBusyUpdate,
  buildSessionSummaries,
  openSessionIds,
  pickerRows,
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
