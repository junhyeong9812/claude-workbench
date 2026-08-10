/**
 * 표면 트리 스키마 + 마이그레이션 (멀티프로젝트 P3').
 *
 * 지금까지 우측 분할은 단일 문자열 `dualProject`(localStorage)로만 표현됐다.
 * 이 모듈은 그것을 **표면 트리**(방향·비율·자식 노드 — N-way·상하 분할까지 대비한
 * 스키마)로 승격한다. **P3' 실사용은 primary + 우측 secondary 0~1개까지만**이고
 * UI에 N-way·자유 방향은 노출하지 않는다(P4'~P6 몫). 트리는 여기서
 * **멤버십의 정본**이 된다: "우측에 어떤 프로젝트가 있는가"는 트리가 답하고,
 * 화면 표시(같은 프로젝트 겹침·hydration 전 숨김)는 렌더 파생이 판정한다
 * (dualSurface.resolveVisibleDual — 파괴적 collapse 없이).
 *
 * ## primary는 트리에 프로젝트를 저장하지 않는다
 * P3'은 아직 "활성 표면 의미론"(P4')이 없어 primary는 activeProject-구동이다.
 * 그래서 primary 리프의 projectKey는 항상 null(런타임 activeProject가 채운다)이고,
 * **secondary 리프의 projectKey만 저장 멤버십**이다. 이 덕에 현 동작이 정확히
 * 보존된다(primary가 activeProject를 그대로 따름).
 *
 * ## 다운그레이드 안전
 * 트리는 localStorage 신규 키 `"surfaceTree"`에 저장한다(store.ts). 구버전 앱은
 * 그 키의 존재를 모르고 레거시 `"dualProject"` 키만 읽으므로, store가 두 키를
 * 함께 기록하는 한 구버전 앱은 우측 분할을 그대로 복원한다(붕괴 0). 반대로 이
 * 버전은 미래(더 높은 version) 트리를 만나도 secondary 리프를 최선 노력으로
 * 추출해 복원한다(아래 parseSurfaceTree). 손상·해석 불가 = 기본 레이아웃(primary
 * 단독) — persist의 "로드 실패=default" 계약과 동형.
 */
import type { SurfaceId } from "./surfaceContext";

/** 현재 트리 스키마 버전. 필드 추가 시 올린다(구 파서는 미지 필드 무시). */
export const SURFACE_TREE_VERSION = 1;

/** 분할 방향. row=좌우(수평), column=상하(수직). P3'은 row만 실사용. */
export type SplitDirection = "row" | "column";

/** 리프 = 하나의 프로젝트 표면. */
export interface SurfaceLeaf {
  kind: "leaf";
  surfaceId: SurfaceId;
  /** 이 표면이 소유한 프로젝트 경로. primary는 항상 null(activeProject-구동),
   * secondary만 저장 멤버십을 담는다. */
  projectKey: string | null;
}

/** 분할 = 방향·비율로 나뉜 자식 노드들(N개 대비). */
export interface SurfaceSplit {
  kind: "split";
  direction: SplitDirection;
  /** 자식별 비율(합=1 가정, 미검증). P3'은 라이브 비율을 react-resizable-panels가
   * 소유하므로 여기 값은 향후(P4'/P5)용 자리표시자다. */
  ratio?: number[];
  children: SurfaceNode[];
}

export type SurfaceNode = SurfaceLeaf | SurfaceSplit;

export interface SurfaceTree {
  version: number;
  root: SurfaceNode;
}

/** primary 단독 리프. */
function primaryLeaf(): SurfaceLeaf {
  return { kind: "leaf", surfaceId: "primary", projectKey: null };
}

/** 우측 분할 없는 기본 트리(primary 단독) — 로드 실패·손상의 복구 기본값. */
export function emptyTree(): SurfaceTree {
  return { version: SURFACE_TREE_VERSION, root: primaryLeaf() };
}

/** secondary 프로젝트가 담긴 row-분할 트리. */
function treeWithSecondary(projectKey: string): SurfaceTree {
  return {
    version: SURFACE_TREE_VERSION,
    root: {
      kind: "split",
      direction: "row",
      children: [
        primaryLeaf(),
        { kind: "leaf", surfaceId: "secondary", projectKey },
      ],
    },
  };
}

/**
 * secondary 표면의 프로젝트 경로(멤버십 정본) 또는 null.
 * 트리 어디에 있든 surfaceId==="secondary"인 첫 리프의 projectKey를 돌려준다.
 */
export function secondaryProject(tree: SurfaceTree): string | null {
  const leaf = findLeaf(tree.root, "secondary");
  return leaf?.projectKey ?? null;
}

/**
 * 우측 표면을 추가/교체한다(P3': secondary 1개까지). 이미 secondary가 있으면
 * projectKey만 교체한다. **동일-프로젝트 가드는 여기서 강제하지 않는다** — primary가
 * activeProject-구동이라 저장 시점의 activeProject를 알 필요 없고, 화면 겹침은 렌더
 * 파생(resolveVisibleDual)이 비파괴적으로 막는다. `projectKey`가 빈 값이면 제거로
 * 취급(레거시 setDualProject(null)과 동형).
 */
export function addSurface(tree: SurfaceTree, projectKey: string | null): SurfaceTree {
  if (!projectKey) return removeSurface(tree);
  return treeWithSecondary(projectKey);
}

/** 우측 표면을 닫아 primary 단독으로 되돌린다. */
export function removeSurface(tree: SurfaceTree, surfaceId: SurfaceId = "secondary"): SurfaceTree {
  // P3'은 secondary 하나뿐 — 그걸 제거하면 항상 primary 단독으로 붕괴한다.
  if (surfaceId === "secondary") return emptyTree();
  return tree;
}

/** 노드 트리에서 surfaceId에 맞는 첫 리프를 찾는다(재귀). */
function findLeaf(node: SurfaceNode, surfaceId: SurfaceId): SurfaceLeaf | null {
  if (node.kind === "leaf") return node.surfaceId === surfaceId ? node : null;
  for (const child of node.children) {
    const hit = findLeaf(child, surfaceId);
    if (hit) return hit;
  }
  return null;
}

/** 런타임 값이 유효한 노드 형태인지 엄격 검증(재귀). */
function isNode(v: unknown): v is SurfaceNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.kind === "leaf") {
    return (
      (n.surfaceId === "primary" || n.surfaceId === "secondary") &&
      (n.projectKey === null || typeof n.projectKey === "string")
    );
  }
  if (n.kind === "split") {
    return (
      (n.direction === "row" || n.direction === "column") &&
      Array.isArray(n.children) &&
      n.children.every(isNode)
    );
  }
  return false;
}

/** 미래(더 높은 version) 또는 느슨한 트리에서 secondary 경로만 최선 노력 추출. */
function extractSecondaryLoose(raw: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (o.kind === "leaf" && o.surfaceId === "secondary" && typeof o.projectKey === "string") {
      return o.projectKey;
    }
    for (const val of Object.values(o)) {
      const hit = Array.isArray(val)
        ? val.reduce<string | null>((acc, item) => acc ?? walk(item), null)
        : walk(val);
      if (hit) return hit;
    }
    return null;
  };
  return walk(raw);
}

/**
 * 저장된 값 → 표면 트리(마이그레이션·복구 단일 진입점).
 *
 * 우선순위:
 *  1. `rawTree`가 이 버전의 잘 형성된 트리 → 정규화해 그대로.
 *  2. `rawTree`가 미래 버전/느슨한 형태 → secondary 경로 최선 추출로 복원.
 *  3. 신 트리 없음 → 레거시 `dualProject` 문자열로부터 구성(구→신 마이그레이션).
 *  4. 그 무엇도 아니면 → 기본(primary 단독).
 *
 * @param rawTree localStorage `"surfaceTree"`를 JSON.parse 한 값(또는 null).
 * @param legacyDual localStorage `"dualProject"` 문자열(구 표현) 또는 null.
 */
export function parseSurfaceTree(rawTree: unknown, legacyDual: string | null): SurfaceTree {
  if (rawTree && typeof rawTree === "object") {
    const t = rawTree as Record<string, unknown>;
    if (typeof t.version === "number" && isNode(t.root)) {
      // 알려진 형태(version 무관하게 root가 유효하면) 그대로 채택 — 정규화.
      return { version: t.version, root: t.root as SurfaceNode };
    }
    // 형태 불일치(손상 또는 미래 스키마): secondary만이라도 최선 추출.
    const loose = extractSecondaryLoose(rawTree);
    if (loose) return treeWithSecondary(loose);
    // 추출 실패 → 아래 레거시/기본으로 낙하.
  }
  if (typeof legacyDual === "string" && legacyDual) return treeWithSecondary(legacyDual);
  return emptyTree();
}
