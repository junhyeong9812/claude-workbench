/**
 * 메모 툴바의 순수 규칙 — 저장 경로 정규화.
 *
 * load-bearing이다: 여기서 통과시킨 문자열이 그대로 프로젝트 루트에
 * 붙는다. 백엔드 `memo_export`가 canonical 봉쇄로 한 번 더 막지만, **두 겹이
 * 다 열려야 사고가 나는 구조**를 유지하려면 이쪽 목록도 테스트로 고정해야 한다.
 */
import { describe, expect, it } from "vitest";

import { defaultMemoPath, isoDate, normalizeMemoRel } from "./memoTools";

describe("memoTools — 저장 경로", () => {
  it("기본 제안은 오늘 날짜의 docs/memo-YYYY-MM-DD.md (로컬 달력)", () => {
    // 로컬 달력 기준 — UTC로 찍으면 밤에 하루 전 파일명이 제안된다.
    const d = new Date(2026, 7, 10, 23, 30);
    expect(isoDate(d)).toBe("2026-08-10");
    expect(defaultMemoPath(d)).toBe("docs/memo-2026-08-10.md");
    expect(defaultMemoPath()).toMatch(/^docs\/memo-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("상대 경로는 다듬어서 통과시킨다", () => {
    expect(normalizeMemoRel(" docs/memo.md ")).toEqual({ ok: true, rel: "docs/memo.md" });
    expect(normalizeMemoRel("./notes//a.md")).toEqual({ ok: true, rel: "notes/a.md" });
    expect(normalizeMemoRel("메모.md")).toEqual({ ok: true, rel: "메모.md" });
  });

  it("프로젝트 밖으로 나가는 형태는 사유와 함께 거절한다", () => {
    for (const bad of ["", "   ", "/etc/passwd", "~/secret.md", "../x.md", "docs/../../x.md"]) {
      const r = normalizeMemoRel(bad);
      expect(r.ok, `${bad || "(빈 값)"} 가 통과했다`).toBe(false);
      // 거절은 조용히 하지 않는다 — 이유가 없으면 사용자는 멈춘 채로 남는다.
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it("폴더 경로·순수 점은 파일이 아니라고 말해 준다", () => {
    expect(normalizeMemoRel("docs/")).toMatchObject({ ok: false });
    expect(normalizeMemoRel(".")).toMatchObject({ ok: false });
  });
});
