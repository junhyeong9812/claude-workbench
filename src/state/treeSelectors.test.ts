import { describe, expect, it } from "vitest";
import { capTreeCache, computeTreeKeepSet, expandedSetOf, pruneTreeCache, sameEntries } from "./treeSelectors";
import type { DirEntry } from "../types";

/** P2 특성테스트 — 기대값은 손계산. expandedSetOf는 기존 렌더 경로의
 * `expanded.includes(p)` 와의 동치를 같은 픽스처로 검증한다(자기참조 금지). */

const state = (expanded: string[], active: string | null = "/proj") => ({
  projects: [
    { path: "/proj", tree_state: { expanded } },
    { path: "/other", tree_state: { expanded: ["/other/x"] } },
  ],
  activeProject: active,
});

describe("expandedSetOf", () => {
  it("includes() 동치 — 활성 프로젝트의 expanded만", () => {
    const exp = ["/proj/a", "/proj/b/c"];
    const s = state(exp);
    for (const p of ["/proj/a", "/proj/b/c", "/proj/b", "/other/x", ""]) {
      expect(expandedSetOf(s).has(p)).toBe(exp.includes(p));
    }
  });

  it("활성 프로젝트 없음/불일치 → 전부 false", () => {
    expect(expandedSetOf(state(["/proj/a"], null)).has("/proj/a")).toBe(false);
    expect(expandedSetOf(state(["/proj/a"], "/nope")).has("/proj/a")).toBe(false);
  });

  it("같은 배열 identity → 같은 Set 인스턴스(메모), 새 배열 → 재구축", () => {
    const s = state(["/proj/a"]);
    const first = expandedSetOf(s);
    expect(expandedSetOf(s)).toBe(first);
    const s2 = state(["/proj/a", "/proj/b"]);
    const second = expandedSetOf(s2);
    expect(second).not.toBe(first);
    expect(second.has("/proj/b")).toBe(true);
  });
});

const entry = (over: Partial<DirEntry>): DirEntry => ({
  name: "n",
  path: "/p/n",
  is_dir: false,
  project_types: [],
  is_ignored: false,
  ...over,
});

describe("sameEntries", () => {
  it("전 필드 동일 → true (identity 무관)", () => {
    const a = [entry({ name: "a", path: "/p/a", is_dir: true, project_types: ["Rust"] })];
    const b = [entry({ name: "a", path: "/p/a", is_dir: true, project_types: ["Rust"] })];
    expect(sameEntries(a, b)).toBe(true);
  });
  it("필드 하나라도 다르면 false", () => {
    const base = entry({ name: "a", path: "/p/a" });
    expect(sameEntries([base], [entry({ name: "b", path: "/p/a" })])).toBe(false);
    expect(sameEntries([base], [entry({ name: "a", path: "/p/b" })])).toBe(false);
    expect(sameEntries([base], [entry({ name: "a", path: "/p/a", is_dir: true })])).toBe(false);
    expect(sameEntries([base], [entry({ name: "a", path: "/p/a", is_ignored: true })])).toBe(false);
    expect(
      sameEntries([base], [entry({ name: "a", path: "/p/a", project_types: ["Java"] })]),
    ).toBe(false);
  });
  it("길이 불일치·미로딩(undefined) → false", () => {
    expect(sameEntries([entry({})], [])).toBe(false);
    expect(sameEntries(undefined, [])).toBe(false);
  });
  it("is_ignored undefined ≡ false (serde default 대칭)", () => {
    const a = [{ ...entry({}), is_ignored: undefined as unknown as boolean }];
    expect(sameEntries(a, [entry({ is_ignored: false })])).toBe(true);
  });
});

describe("pruneTreeCache", () => {
  const cache = {
    "/closed": 1,
    "/closed/sub": 2,
    "/closed/nested-proj": 3,
    "/closed/nested-proj/src": 4,
    "/closedX": 5, // prefix 유사 경로 — "/closed"의 하위가 아니다
    "/other": 6,
  };
  it("닫힌 루트 아래만 제거, keepRoots 아래·무관 키 보존", () => {
    const out = pruneTreeCache(cache, "/closed", ["/closed/nested-proj", null]);
    expect(Object.keys(out).sort()).toEqual(
      ["/closed/nested-proj", "/closed/nested-proj/src", "/closedX", "/other"].sort(),
    );
  });
  it("제거 대상 없음 → 원본 identity 반환", () => {
    const out = pruneTreeCache(cache, "/none", []);
    expect(out).toBe(cache);
  });
});

describe("computeTreeKeepSet / capTreeCache (P5 F-g)", () => {
  const projects = [{ path: "/p1", tree_state: { expanded: ["/p1/a", "/p1/b"] } }];
  const study = { left: "/s", right: null };
  const studyExp = { "study-left": ["/s/x"] };

  it("keep = 프로젝트 루트+확장 + 스터디 루트+확장 (손계산)", () => {
    const keep = computeTreeKeepSet(projects, study, studyExp);
    expect([...keep].sort()).toEqual(["/p1", "/p1/a", "/p1/b", "/s", "/s/x"]);
  });

  it("상한 이하 → 원본 identity", () => {
    const cache = { "/p1": 1, "/x": 2 };
    expect(capTreeCache(cache, new Set(["/p1"]), 5)).toBe(cache);
  });

  it("초과 시 keep 밖만 축출, keep(표시 중)은 절대 미축출", () => {
    const cache = { "/p1": 1, "/junk1": 2, "/junk2": 3, "/s/x": 4 };
    const keep = new Set(["/p1", "/s/x"]);
    const out = capTreeCache(cache, keep, 2);
    expect(out["/p1"]).toBe(1);
    expect(out["/s/x"]).toBe(4);
    expect(Object.keys(out).length).toBe(2);
  });

  it("keep만으로 상한 초과여도 keep은 남긴다(초과 잔존 허용)", () => {
    const cache = { "/a": 1, "/b": 2, "/c": 3 };
    const keep = new Set(["/a", "/b", "/c"]);
    expect(Object.keys(capTreeCache(cache, keep, 1)).sort()).toEqual(["/a", "/b", "/c"]);
  });
});
