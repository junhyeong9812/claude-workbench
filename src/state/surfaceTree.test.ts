import { describe, expect, it } from "vitest";
import {
  SURFACE_TREE_VERSION,
  addSurface,
  emptyTree,
  parseSurfaceTree,
  removeSurface,
  secondaryProject,
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
  it("미래 version + 알려진 root 형태 → root 보존 채택", () => {
    const future: SurfaceTree = {
      version: 99,
      root: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "leaf", surfaceId: "primary", projectKey: null },
          { kind: "leaf", surfaceId: "secondary", projectKey: "/future" },
        ],
      },
    };
    expect(secondaryProject(parseSurfaceTree(future, null))).toBe("/future");
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
