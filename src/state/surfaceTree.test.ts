import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACEMENT,
  SURFACE_TREE_VERSION,
  addSurface,
  emptyTree,
  parseSurfaceTree,
  placementForZone,
  removeSurface,
  resolveSurfaceTree,
  secondaryProject,
  surfaceLayout,
  type SurfaceTree,
} from "./surfaceTree";

describe("surfaceTree — 기본 형태", () => {
  it("emptyTree = primary 단독 리프", () => {
    const t = emptyTree();
    expect(t.version).toBe(SURFACE_TREE_VERSION);
    expect(t.root).toEqual({ kind: "leaf", surfaceId: "primary", projectKey: null });
    expect(secondaryProject(t)).toBeNull();
  });

  it("addSurface → secondary 멤버십 저장(primary는 projectKey null 유지)", () => {
    const t = addSurface(emptyTree(), "/b");
    expect(secondaryProject(t)).toBe("/b");
    expect(t.root.kind).toBe("split");
    if (t.root.kind === "split") {
      expect(t.root.direction).toBe("row");
      expect(t.root.children[0]).toEqual({ kind: "leaf", surfaceId: "primary", projectKey: null });
      expect(t.root.children[1]).toEqual({ kind: "leaf", surfaceId: "secondary", projectKey: "/b" });
    }
  });

  it("addSurface 재호출 = secondary 교체(중복 안 쌓임)", () => {
    const t = addSurface(addSurface(emptyTree(), "/b"), "/c");
    expect(secondaryProject(t)).toBe("/c");
    if (t.root.kind === "split") expect(t.root.children).toHaveLength(2);
  });

  it("removeSurface / addSurface(null) → primary 단독으로 붕괴", () => {
    const t = addSurface(emptyTree(), "/b");
    expect(secondaryProject(removeSurface(t))).toBeNull();
    expect(removeSurface(t)).toEqual(emptyTree());
    expect(addSurface(t, null)).toEqual(emptyTree());
    expect(addSurface(t, "")).toEqual(emptyTree());
  });
});

describe("P6: 드롭 존 → 배치 매핑 (좌/우/상/하)", () => {
  it("좌=row·before, 우=row·after, 상=column·before, 하=column·after", () => {
    expect(placementForZone("left")).toEqual({ direction: "row", before: true });
    expect(placementForZone("right")).toEqual({ direction: "row", before: false });
    expect(placementForZone("above")).toEqual({ direction: "column", before: true });
    expect(placementForZone("below")).toEqual({ direction: "column", before: false });
  });
  it("center·미지 존 = null(분할 아님)", () => {
    expect(placementForZone("center")).toBeNull();
    expect(placementForZone("bogus")).toBeNull();
    expect(placementForZone("")).toBeNull();
  });
  it("우측(right) 매핑 = 기본 배치와 동일(우클릭 우측분할 보존)", () => {
    expect(placementForZone("right")).toEqual(DEFAULT_PLACEMENT);
  });
});

describe("P6: addSurface 배치 방향/위치 + surfaceLayout 판독", () => {
  it("기본(placement 생략) = 우측 row·after (회귀 0)", () => {
    const t = addSurface(emptyTree(), "/b");
    expect(surfaceLayout(t)).toEqual({ direction: "row", before: false });
    if (t.root.kind === "split") {
      expect(t.root.direction).toBe("row");
      expect(t.root.children[0]).toMatchObject({ surfaceId: "primary" });
      expect(t.root.children[1]).toMatchObject({ surfaceId: "secondary", projectKey: "/b" });
    }
  });
  it("하(column·after) = 세로 분할, secondary 뒤", () => {
    const t = addSurface(emptyTree(), "/b", { direction: "column", before: false });
    expect(surfaceLayout(t)).toEqual({ direction: "column", before: false });
    expect(secondaryProject(t)).toBe("/b");
    if (t.root.kind === "split") expect(t.root.children[1]).toMatchObject({ surfaceId: "secondary" });
  });
  it("좌(row·before) = secondary가 primary 앞", () => {
    const t = addSurface(emptyTree(), "/b", { direction: "row", before: true });
    expect(surfaceLayout(t)).toEqual({ direction: "row", before: true });
    // 순서 무관하게 멤버십 조회는 정확.
    expect(secondaryProject(t)).toBe("/b");
    if (t.root.kind === "split") expect(t.root.children[0]).toMatchObject({ surfaceId: "secondary" });
  });
  it("상(column·before)도 secondary가 앞·세로", () => {
    const t = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    expect(surfaceLayout(t)).toEqual({ direction: "column", before: true });
  });
  it("primary 단독 트리 = surfaceLayout null", () => {
    expect(surfaceLayout(emptyTree())).toBeNull();
  });
});

describe("P6: 방향 담은 트리 왕복 persist 무손실", () => {
  for (const p of [
    { direction: "row", before: false } as const,
    { direction: "row", before: true } as const,
    { direction: "column", before: false } as const,
    { direction: "column", before: true } as const,
  ]) {
    it(`${p.direction}/${p.before ? "before" : "after"} → JSON 왕복 후 방향·멤버십 보존`, () => {
      const orig = addSurface(emptyTree(), "/proj", p);
      const round = parseSurfaceTree(JSON.parse(JSON.stringify(orig)), null);
      expect(round).toEqual(orig);
      expect(surfaceLayout(round)).toEqual(p);
      expect(secondaryProject(round)).toBe("/proj");
    });
  }
});

describe("parseSurfaceTree — 마이그레이션(구→신) + 왕복 무손실", () => {
  it("구 dualProject 있음 → secondary 트리로 무손실 변환", () => {
    const t = parseSurfaceTree(null, "/b");
    expect(secondaryProject(t)).toBe("/b");
    expect(t.version).toBe(SURFACE_TREE_VERSION);
  });

  it("구 dualProject 없음(신 트리도 없음) → 기본(primary 단독)", () => {
    expect(parseSurfaceTree(null, null)).toEqual(emptyTree());
  });

  it("신 트리 왕복(직렬화→파싱) 무손실 — secondary 있음", () => {
    const orig = addSurface(emptyTree(), "/proj-x");
    const round = parseSurfaceTree(JSON.parse(JSON.stringify(orig)), null);
    expect(round).toEqual(orig);
    expect(secondaryProject(round)).toBe("/proj-x");
  });

  it("신 트리 왕복 무손실 — primary 단독", () => {
    const orig = emptyTree();
    expect(parseSurfaceTree(JSON.parse(JSON.stringify(orig)), null)).toEqual(orig);
  });

  it("신 트리가 있으면 레거시 dualProject보다 신 트리를 채택", () => {
    const t = addSurface(emptyTree(), "/from-tree");
    // 레거시가 다른 값을 가리켜도 신 트리 우선.
    expect(secondaryProject(parseSurfaceTree(t, "/from-legacy"))).toBe("/from-tree");
  });
});

describe("parseSurfaceTree — 손상/이상치 = 기본 복원(로드 실패 계약)", () => {
  const CORRUPT: unknown[] = [
    "not-an-object",
    42,
    { version: 1 }, // root 없음
    { version: 1, root: { kind: "leaf" } }, // surfaceId 없음
    { version: 1, root: { kind: "split", direction: "diag", children: [] } }, // 잘못된 방향
    { version: 1, root: { kind: "split", direction: "row", children: [{ kind: "bogus" }] } },
    { root: { kind: "leaf", surfaceId: "primary", projectKey: null } }, // version 없음
  ];
  it("손상 트리 + 레거시 없음 → 기본(primary 단독)", () => {
    for (const bad of CORRUPT) {
      expect(parseSurfaceTree(bad, null)).toEqual(emptyTree());
    }
  });
  it("present-but-corrupt 트리 + 레거시 있음 → **기본**(legacy 부활 아님 — FC2)", () => {
    // rawTree가 present면 그것 하나로만 해석. 현재 버전 손상은 legacy로 떨어지지
    // 않고 즉시 기본이다("손상=기본" 계약).
    expect(parseSurfaceTree({ version: 1 }, "/legacy")).toEqual(emptyTree());
  });
});

describe("다운그레이드/포워드 안전 — 미래 버전 트리도 secondary 최선 복원", () => {
  it("미래 version + 알려진 root 형태 → secondary 최선 추출(구조 그대로 채택 아님 — F3)", () => {
    const future: SurfaceTree = {
      version: 99,
      root: {
        kind: "split",
        direction: "column",
        children: [
          { kind: "leaf", surfaceId: "primary", projectKey: null },
          { kind: "leaf", surfaceId: "secondary", projectKey: "/future" },
        ],
      },
    };
    const r = parseSurfaceTree(future, null);
    expect(secondaryProject(r)).toBe("/future");
    // 미래 version은 구조를 신뢰하지 않는다: 멤버십만 건지고 현재 version·기본 배치로.
    expect(r.version).toBe(SURFACE_TREE_VERSION);
    expect(surfaceLayout(r)).toEqual(DEFAULT_PLACEMENT);
  });

  it("미래 스키마(느슨/미지 필드)라도 secondary 리프가 있으면 경로 추출", () => {
    const weird = {
      version: 5,
      layout: "quad",
      root: {
        kind: "grid", // 미지 노드 종류
        panes: [
          { kind: "leaf", surfaceId: "primary", projectKey: null },
          { kind: "leaf", surfaceId: "secondary", projectKey: "/deep" },
        ],
      },
    };
    expect(secondaryProject(parseSurfaceTree(weird, null))).toBe("/deep");
  });
});

describe("F3(codex P2-1): 미지 version → default/loose (그대로 채택 금지)", () => {
  const validRoot = {
    kind: "split",
    direction: "column",
    children: [
      { kind: "leaf", surfaceId: "primary", projectKey: null },
      { kind: "leaf", surfaceId: "secondary", projectKey: "/x" },
    ],
  };
  it("현재 version + 유효 구조 → 방향까지 그대로 채택", () => {
    const cur = { version: SURFACE_TREE_VERSION, root: validRoot };
    const r = parseSurfaceTree(cur, null);
    expect(secondaryProject(r)).toBe("/x");
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: false });
  });
  it("미지 version(2) + 유효 구조 → loose extract(방향 유실·기본 배치, 채택 아님)", () => {
    const v2 = { version: 2, root: validRoot };
    const r = parseSurfaceTree(v2, null);
    expect(secondaryProject(r)).toBe("/x"); // 멤버십만 최선 추출
    expect(r.version).toBe(SURFACE_TREE_VERSION); // v2 구조 그대로 채택 아님
    expect(surfaceLayout(r)).toEqual(DEFAULT_PLACEMENT); // 방향 유실 → 기본
  });
  it("과거 version(0) + 유효 구조 → default(부활·채택 없음)", () => {
    const v0 = { version: 0, root: validRoot };
    expect(parseSurfaceTree(v0, null)).toEqual(emptyTree());
  });
});

describe("FC(리뷰): 손상 트리가 임의 secondary를 부활시키지 못한다", () => {
  it("codex 픽스처 {version:1, root:{kind:bogus}, metadata:{…/resurrected}} → 기본", () => {
    const fixture = {
      version: 1, // 현재 버전 — loose 추출 금지(미래 버전에서만).
      root: { kind: "bogus" },
      metadata: { kind: "leaf", surfaceId: "secondary", projectKey: "/resurrected" },
    };
    expect(parseSurfaceTree(fixture, null)).toEqual(emptyTree());
  });

  it("primary가 없거나 중복이거나 projectKey!=null이면 손상 → 기본", () => {
    const noPrimary = { version: 1, root: { kind: "leaf", surfaceId: "secondary", projectKey: "/x" } };
    const primaryKeyed = { version: 1, root: { kind: "leaf", surfaceId: "primary", projectKey: "/x" } };
    const twoPrimary = {
      version: 1,
      root: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "leaf", surfaceId: "primary", projectKey: null },
          { kind: "leaf", surfaceId: "primary", projectKey: null },
        ],
      },
    };
    for (const bad of [noPrimary, primaryKeyed, twoPrimary]) {
      expect(parseSurfaceTree(bad, null)).toEqual(emptyTree());
    }
  });

  it("FC2: 현재 버전 손상 rawTree + legacy 존재 → 기본(둘 다 부활 안 함)", () => {
    // rawTree의 metadata에 secondary가 숨어 있고 legacy도 있지만, present-but-
    // corrupt(현재 버전)이므로 loose 추출도 legacy 마이그레이션도 하지 않는다.
    const fixture = {
      version: 1,
      root: { kind: "bogus" },
      metadata: { kind: "leaf", surfaceId: "secondary", projectKey: "/resurrected" },
    };
    expect(parseSurfaceTree(fixture, "/legacy")).toEqual(emptyTree());
  });
});

describe("P6: resolveSurfaceTree — 디스크 로드 + 다운그레이드 화해", () => {
  it("정상(두 키 동기 기록·일치) → 트리 채택, 방향 보존", () => {
    const tree = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    const round = resolveSurfaceTree(JSON.parse(JSON.stringify(tree)), "/b");
    expect(round).toEqual(tree);
    expect(surfaceLayout(round)).toEqual({ direction: "column", before: true });
  });

  it("다운그레이드 닫음: 트리엔 secondary 있는데 legacy 부재 → 기본(부활 금지)", () => {
    // 구버전 앱이 dualProject 키만 지웠고 stale surfaceTree 블롭이 남은 케이스.
    const stale = addSurface(emptyTree(), "/b", { direction: "row", before: false });
    expect(resolveSurfaceTree(JSON.parse(JSON.stringify(stale)), null)).toEqual(emptyTree());
  });

  it("다운그레이드 교체: legacy가 다른 프로젝트 → legacy 멤버십·트리 방향 보존", () => {
    // 구버전이 dualProject를 "/other"로 바꿈. 트리 방향(column)은 유지하되
    // 멤버십은 legacy가 이긴다.
    const stale = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    const r = resolveSurfaceTree(JSON.parse(JSON.stringify(stale)), "/other");
    expect(secondaryProject(r)).toBe("/other");
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: true });
  });

  it("rawTree 부재 → legacy 마이그레이션(정의상 일치, 화해 no-op)", () => {
    expect(secondaryProject(resolveSurfaceTree(null, "/b"))).toBe("/b");
    expect(resolveSurfaceTree(null, null)).toEqual(emptyTree());
  });

  it("present-but-corrupt 블롭 + legacy 부재 → 기본(크래시 없음)", () => {
    expect(resolveSurfaceTree({ version: 1, root: { kind: "bogus" } }, null)).toEqual(emptyTree());
  });
});

describe("F1(codex P1-1): legacyMirror provenance — stale legacy가 valid 트리를 못 이긴다", () => {
  // persist가 쓰는 블롭 형태 = 트리 + legacyMirror(= 그때의 legacy = secondary).
  const withMirror = (t: SurfaceTree) => ({ ...t, legacyMirror: secondaryProject(t) });

  it("(a) same-version(마커 == 현재 legacy) → 트리 정본(방향 보존, 마커 stripped)", () => {
    const tree = addSurface(emptyTree(), "/b", { direction: "column", before: false });
    const r = resolveSurfaceTree(withMirror(tree), "/b");
    expect(r).toEqual(tree); // legacyMirror는 parse가 떼어냄
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: false });
  });

  it("(b) 다운그레이드 교체(마커 stale /b, 구버전이 legacy=/other) → legacy 멤버십·트리 방향", () => {
    const tree = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    const r = resolveSurfaceTree(withMirror(tree), "/other");
    expect(secondaryProject(r)).toBe("/other");
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: true });
  });

  it("(b') 다운그레이드 닫음(마커 stale /b, 구버전이 legacy 제거) → 기본(부활 금지)", () => {
    const tree = addSurface(emptyTree(), "/b", { direction: "row", before: false });
    expect(resolveSurfaceTree(withMirror(tree), null)).toEqual(emptyTree());
  });

  it("(c) 마커 == 현재 legacy면 트리 방향 우선 — 방향-only 재기록 후 legacy 미세지연도 트리 신뢰", () => {
    // 마커(/b) == 현재 legacy(/b)인데 트리 멤버십도 /b → 정상 일치 경로로 트리 채택.
    const tree = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    const r = resolveSurfaceTree(withMirror(tree), "/b");
    expect(secondaryProject(r)).toBe("/b");
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: true });
  });

  it("(하위호환) 마커 부재(구 P6-이전 블롭) → 기존 화해로 폴백(legacy 멤버십)", () => {
    const stale = addSurface(emptyTree(), "/b", { direction: "column", before: true });
    // 마커 없는 블롭 + legacy=/other → 다운그레이드로 간주(현행 화해 유지).
    const r = resolveSurfaceTree(JSON.parse(JSON.stringify(stale)), "/other");
    expect(secondaryProject(r)).toBe("/other");
    expect(surfaceLayout(r)).toEqual({ direction: "column", before: true });
    // 마커 없는 블롭 + legacy 부재 → 기본(부활 금지).
    expect(resolveSurfaceTree(JSON.parse(JSON.stringify(stale)), null)).toEqual(emptyTree());
  });
});

describe("FA(리뷰): 깊은 트리·순환에서 크래시하지 않고 기본 복원", () => {
  it("12k 깊이 중첩 split → throw 없이 기본(예외 경계)", () => {
    // 예산 초과 재귀가 RangeError를 던져도 parseSurfaceTree가 잡아 기본 반환.
    let node: unknown = { kind: "leaf", surfaceId: "primary", projectKey: null };
    for (let i = 0; i < 12_000; i++) {
      node = { kind: "split", direction: "row", children: [node] };
    }
    const deep = { version: 1, root: node };
    expect(() => parseSurfaceTree(deep, null)).not.toThrow();
    expect(parseSurfaceTree(deep, null)).toEqual(emptyTree());
    // present-but-corrupt이므로 legacy가 있어도 기본(FC2) — 크래시 없음이 핵심.
    expect(() => parseSurfaceTree(deep, "/safe")).not.toThrow();
    expect(parseSurfaceTree(deep, "/safe")).toEqual(emptyTree());
  });

  it("순환 참조 → throw 없이 기본", () => {
    const cyc: Record<string, unknown> = { kind: "split", direction: "row" };
    cyc.children = [cyc]; // 자기참조
    const looped = { version: 9, root: cyc }; // 미래 버전(loose 경로도 태움)
    expect(() => parseSurfaceTree(looped, null)).not.toThrow();
    expect(parseSurfaceTree(looped, null)).toEqual(emptyTree());
  });
});
