/**
 * 메모 툴바의 순수 규칙 — 저장 경로 정규화와 정리 모델 기억.
 *
 * 경로 쪽이 load-bearing이다: 여기서 통과시킨 문자열이 그대로 프로젝트 루트에
 * 붙는다. 백엔드 `memo_export`가 canonical 봉쇄로 한 번 더 막지만, **두 겹이
 * 다 열려야 사고가 나는 구조**를 유지하려면 이쪽 목록도 테스트로 고정해야 한다.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TIDY_MODEL,
  defaultMemoPath,
  isoDate,
  loadTidyModel,
  normalizeMemoRel,
  saveTidyModel,
  tidyShrank,
} from "./memoTools";
import { MODEL_CHOICES } from "./agentOptions";

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

describe("memoTools — 절단 경고", () => {
  it("절반 아래로 줄면 경고한다 (절단의 모양)", () => {
    const before = "a".repeat(100);
    expect(tidyShrank(before, "a".repeat(40))).toBe(true);
    expect(tidyShrank(before, "a".repeat(80))).toBe(false);
    // 경계값은 경고하지 않는다 — 정직한 중복 제거가 딱 절반일 수 있다.
    expect(tidyShrank(before, "a".repeat(50))).toBe(false);
  });

  it("빈 원문은 경고 대상이 아니다 (0으로 나누지 않는다)", () => {
    expect(tidyShrank("", "")).toBe(false);
    expect(tidyShrank("   ", "무엇이든")).toBe(false);
  });
});

describe("memoTools — 정리 모델 기억", () => {
  afterEach(() => localStorage.clear());

  it("기본은 sonnet이고 공통 목록의 값이다", () => {
    expect(DEFAULT_TIDY_MODEL).toBe("sonnet");
    expect(MODEL_CHOICES).toContain(DEFAULT_TIDY_MODEL);
    expect(loadTidyModel()).toBe("sonnet");
  });

  it("고른 값을 기억하되, 어휘 밖 값은 기본으로 떨어뜨린다", () => {
    saveTidyModel("fable");
    expect(loadTidyModel()).toBe("fable");
    localStorage.setItem("memoTidyModel", "gpt-없는모델");
    expect(loadTidyModel()).toBe(DEFAULT_TIDY_MODEL);
  });

  it('"CLI 기본"(미지정)도 선택이므로 기억한다', () => {
    saveTidyModel("");
    expect(loadTidyModel(), "매번 sonnet으로 되돌리면 기억이 아니라 강요다").toBe("");
  });
});
