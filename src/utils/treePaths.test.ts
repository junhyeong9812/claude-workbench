import { describe, it, expect } from "vitest";
import { BRACE_MAX, expandBraces, normalizeRel, planNewFiles } from "./treePaths";

/** 실패 결과의 사유만 꺼낸다 (성공이면 테스트를 깨뜨린다). */
const err = (r: { ok: true } | { ok: false; error: string }): string => {
  if (r.ok) throw new Error("expected failure");
  return r.error;
};
const names = (r: ReturnType<typeof expandBraces>): string[] => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.names;
};

describe("normalizeRel", () => {
  it("공백·중복 구분자를 정리한다", () => {
    expect(normalizeRel(" a / b.ts ")).toBe("a/b.ts");
    expect(normalizeRel("a//b")).toBe("a/b");
  });
  it("빈·`.`·`..` 입력은 무효", () => {
    expect(normalizeRel("")).toBe("");
    expect(normalizeRel("/")).toBe("");
    expect(normalizeRel(".")).toBe("");
    expect(normalizeRel("a/../b")).toBe("");
    expect(normalizeRel("..")).toBe("");
  });
  it("`...`(정상 파일명)은 통과 — 부모 참조가 아니다", () => {
    expect(normalizeRel("...")).toBe("...");
  });
});

describe("expandBraces — 기본 확장", () => {
  it("그룹이 없으면 입력 자신 하나 (기존 단일 생성 경로)", () => {
    expect(names(expandBraces("Foo.java"))).toEqual(["Foo.java"]);
    expect(names(expandBraces("  sub/Foo.java  "))).toEqual(["sub/Foo.java"]);
  });
  it("접두 그룹: {a,b}.ts", () => {
    expect(names(expandBraces("{a,b}.ts"))).toEqual(["a.ts", "b.ts"]);
  });
  it("접미 그룹: x.{ts,tsx}", () => {
    expect(names(expandBraces("x.{ts,tsx}"))).toEqual(["x.ts", "x.tsx"]);
  });
  it("경로 안 그룹: p/{a,b}.go", () => {
    expect(names(expandBraces("p/{a,b}.go"))).toEqual(["p/a.go", "p/b.go"]);
  });
  it("형제 그룹은 교차곱 — 왼쪽이 바깥 루프", () => {
    expect(names(expandBraces("{a,b}.{ts,tsx}"))).toEqual(["a.ts", "a.tsx", "b.ts", "b.tsx"]);
  });
  it("항목 주변 공백은 다듬는다", () => {
    expect(names(expandBraces("{ a , b }.ts"))).toEqual(["a.ts", "b.ts"]);
  });
  it("항목 1개 그룹도 허용 (확장 결과 1개)", () => {
    expect(names(expandBraces("{a}.ts"))).toEqual(["a.ts"]);
  });
});

describe("expandBraces — 거부 엣지", () => {
  it("중첩 {} 는 거부", () => {
    expect(err(expandBraces("{a,{b,c}}.ts"))).toContain("중첩");
  });
  it("짝이 안 맞는 중괄호는 거부 (열림·닫힘 양쪽)", () => {
    expect(err(expandBraces("{a,b.ts"))).toContain("짝");
    expect(err(expandBraces("a,b}.ts"))).toContain("짝");
  });
  it("빈 항목은 거부", () => {
    expect(err(expandBraces("{a,}.ts"))).toContain("빈 항목");
    expect(err(expandBraces("{,b}.ts"))).toContain("빈 항목");
    expect(err(expandBraces("{}.ts"))).toContain("빈 항목");
    expect(err(expandBraces("{ }.ts"))).toContain("빈 항목");
  });
  it("그룹 안 경로 구분자는 거부 (폴더 탈출 표면 축소)", () => {
    expect(err(expandBraces("{a,b/c}.ts"))).toContain("경로 구분자");
  });
  it("중복 결과는 거부 (부분 생성 방지)", () => {
    expect(err(expandBraces("{a,a}.ts"))).toContain("중복");
  });
  it("빈 입력은 거부", () => {
    expect(err(expandBraces("   "))).toContain("이름");
  });
  it("이스케이프는 지원하지 않는다 — `\\{`도 그룹 시작으로 읽혀 짝 오류", () => {
    expect(err(expandBraces("a\\{b.ts"))).toContain("짝");
  });
});

describe("expandBraces — 개수 상한", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`).join(",");
  it(`상한(${BRACE_MAX}) 이하는 통과`, () => {
    expect(names(expandBraces(`{${list(BRACE_MAX)}}.ts`))).toHaveLength(BRACE_MAX);
  });
  it("상한 초과는 거부하고 요청 개수를 알린다", () => {
    const e = err(expandBraces(`{${list(BRACE_MAX + 1)}}.ts`));
    expect(e).toContain(`${BRACE_MAX}`);
    expect(e).toContain(`${BRACE_MAX + 1}`);
  });
  it("교차곱 폭발도 조합을 만들기 전에 막는다", () => {
    // 5×5×5 = 125 — 상한 초과.
    const e = err(expandBraces("{a,b,c,d,e}{a,b,c,d,e}{a,b,c,d,e}.ts"));
    expect(e).toContain("125");
  });
});

describe("planNewFiles", () => {
  it("확장 결과마다 dir 기준 절대 경로를 만든다", () => {
    const r = planNewFiles("{a,b}.ts", "/p/src");
    expect(r).toEqual({ ok: true, paths: ["/p/src/a.ts", "/p/src/b.ts"] });
  });
  it("중첩 경로 입력도 그대로 이어 붙인다", () => {
    const r = planNewFiles("p/{a,b}.go", "/root");
    expect(r).toEqual({ ok: true, paths: ["/root/p/a.go", "/root/p/b.go"] });
  });
  it("확장 결과 중 하나라도 무효 세그먼트면 전체 실패 (부분 생성 없음)", () => {
    // "a/x.ts"는 정상이지만 "../x.ts"가 부모 탈출 → 둘 다 만들지 않는다.
    expect(err(planNewFiles("{a,..}/x.ts", "/p"))).toContain("올바른 파일명");
    expect(err(planNewFiles("./", "/p"))).toContain("올바른 파일명");
  });
  it("확장 실패 사유는 그대로 전달된다", () => {
    expect(err(planNewFiles("{a,{b}}.ts", "/p"))).toContain("중첩");
  });
});
