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
 * ## 다운그레이드 안전 — 단일 키 persist (FB, 리뷰)
 * P3'의 트리는 secondary 0~1개뿐이라 정보량이 레거시 `dualProject` 문자열과
 * **동형**(direction 항상 row·ratio는 react-resizable-panels 소유·저장 정보 =
 * secondaryProject 하나)이다. 그래서 트리는 **메모리 정본**으로만 두고 디스크
 * persist는 레거시 `dualProject` 단일 키로만 한다(store.ts). 두 키의 비원자 이중
 * 기록이 만들던 영구 분기(닫은 분할 부활·다중창·다운/업그레이드 유실)가 원천
 * 소멸하고, 다운그레이드는 자명하다(구버전 앱이 읽는 유일 키를 그대로 쓴다).
 * 방향·N-way를 실제로 담는 트리 persist는 그걸 필요로 하는 P6로 이연한다.
 *
 * 그럼에도 parseSurfaceTree는 트리 블롭 입력까지 완전 견고화한다(미래 P6 대비):
 * 미래(더 높은 version) 트리는 secondary를 최선 추출, 손상·예산 초과·순환은 전부
 * 기본 레이아웃(primary 단독)으로 — persist의 "로드 실패=default" 계약과 동형.
 */
import type { SurfaceId } from "./surfaceContext";

/** 현재 트리 스키마 버전. 필드 추가 시 올린다(구 파서는 미지 필드 무시). */
export const SURFACE_TREE_VERSION = 1;

/** 분할 방향. row=좌우(수평), column=상하(수직). P6부터 column 실사용. */
export type SplitDirection = "row" | "column";

/**
 * 부 표면 배치(멀티프로젝트 P6) — 자유 방향 분할.
 * `direction` = row(좌우)·column(상하). `before` = 부 표면이 주 표면보다 **앞**
 * (좌/상)인가. 기본 = 우측 분할(row·after) — 우클릭 "우측 분할로 열기"·기존
 * setDualProject·기존 테스트가 그대로 성립한다(회귀 0).
 */
export interface SurfacePlacement {
  direction: SplitDirection;
  before: boolean;
}

/** 기본 배치 = 우측(row·after). 방향 인자 없이 부르면 이것 — 기존 동작 보존. */
export const DEFAULT_PLACEMENT: SurfacePlacement = { direction: "row", before: false };

/**
 * 드롭 존(sessionDropZone `DropZone`) → 배치 매핑(P6). 좌/우=row, 상/하=column,
 * before는 좌·상. center·미지 = null(분할 아님 — 호출부가 무시). sessionDropZone을
 * import 하지 않으려 문자열을 받는다(순수·테스트 용이 — state→components 결합 회피).
 */
export function placementForZone(zone: string): SurfacePlacement | null {
  switch (zone) {
    case "left":
      return { direction: "row", before: true };
    case "right":
      return { direction: "row", before: false };
    case "above":
      return { direction: "column", before: true };
    case "below":
      return { direction: "column", before: false };
    default:
      return null; // center / 미지 = 분할 아님
  }
}

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

/** secondary 프로젝트가 담긴 분할 트리(방향·위치 = placement, 기본 우측 row·after). */
function treeWithSecondary(
  projectKey: string,
  placement: SurfacePlacement = DEFAULT_PLACEMENT,
): SurfaceTree {
  const primary = primaryLeaf();
  const secondary: SurfaceLeaf = { kind: "leaf", surfaceId: "secondary", projectKey };
  return {
    version: SURFACE_TREE_VERSION,
    root: {
      kind: "split",
      direction: placement.direction,
      // before = 부 표면이 주 표면 앞(좌/상). findLeaf/secondaryProject는 순서
      // 무관하게 secondary를 찾으므로 멤버십 조회는 그대로 성립한다.
      children: placement.before ? [secondary, primary] : [primary, secondary],
    },
  };
}

/**
 * 트리의 부 표면 배치(방향·위치)를 읽는다(P6 렌더용) — secondary 없으면 null.
 * P6 트리는 root가 flat 2-child split이라 직접 자식에서 primary/secondary 인덱스를
 * 비교한다. secondary가 더 깊이 중첩된(미래) 경우엔 방향을 못 읽어 기본(row·after)로
 * 안전 낙하한다(멤버십은 secondaryProject가 여전히 정확).
 */
export function surfaceLayout(tree: SurfaceTree): SurfacePlacement | null {
  const root = tree.root;
  if (root.kind !== "split") return null;
  const secIdx = root.children.findIndex(
    (c) => c.kind === "leaf" && c.surfaceId === "secondary",
  );
  if (secIdx === -1) {
    // 직접 자식에 없음 — 멤버십은 있을 수 있으나(중첩) 방향 판독 불가 → 기본.
    return secondaryProject(tree) !== null ? { ...DEFAULT_PLACEMENT } : null;
  }
  const priIdx = root.children.findIndex(
    (c) => c.kind === "leaf" && c.surfaceId === "primary",
  );
  return { direction: root.direction, before: priIdx !== -1 && secIdx < priIdx };
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
export function addSurface(
  tree: SurfaceTree,
  projectKey: string | null,
  placement: SurfacePlacement = DEFAULT_PLACEMENT,
): SurfaceTree {
  if (!projectKey) return removeSurface(tree);
  return treeWithSecondary(projectKey, placement);
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

// 재귀/순회 예산(FA — 리뷰): 깊은(수천 depth) JSON·순환에서 앱 시작 크래시를
// 막는다. 초과 = RangeError throw → parseSurfaceTree의 예외 경계가 손상 취급.
// 실 트리는 depth 2·노드 3(P3'), N-way 미래도 이 예산 안. 넉넉하되 유한.
const MAX_DEPTH = 64;
const MAX_NODES = 4096;

/**
 * 구조 + 의미 엄격 검증(FC — 리뷰). 구조만이 아니라 **정합 불변식**까지 본다:
 * primary 리프 정확히 1개(projectKey===null) · secondary 리프 0~1개 · 모든 split
 * 은 비어있지 않음. 위반 = false. 깊이/노드 예산 초과 = RangeError(호출부 경계가
 * 잡음). 이 강화로 손상 트리에서 임의 metadata의 secondary가 부활하지 못한다.
 */
function isValidTree(root: unknown): boolean {
  let primary = 0;
  let primaryKeyOk = true;
  let secondary = 0;
  let nodes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) throw new RangeError("surface tree too deep");
    if (++nodes > MAX_NODES) throw new RangeError("surface tree too large");
    if (!v || typeof v !== "object") return false;
    const n = v as Record<string, unknown>;
    if (n.kind === "leaf") {
      if (n.surfaceId === "primary") {
        primary++;
        if (n.projectKey !== null) primaryKeyOk = false;
        return true;
      }
      if (n.surfaceId === "secondary") {
        secondary++;
        return n.projectKey === null || typeof n.projectKey === "string";
      }
      return false; // 미지 surfaceId
    }
    if (n.kind === "split") {
      if (n.direction !== "row" && n.direction !== "column") return false;
      if (!Array.isArray(n.children) || n.children.length === 0) return false;
      return n.children.every((c) => walk(c, depth + 1));
    }
    return false; // 미지 노드 종류
  };
  if (!walk(root, 0)) return false;
  return primary === 1 && primaryKeyOk && secondary <= 1;
}

/** 미래(더 높은 version) 트리에서 secondary 경로만 최선 노력 추출 — 예산·순환
 * 가드 포함(초과=null → 기본으로 낙하). 현재/무버전 손상에는 호출하지 않는다. */
function extractSecondaryLoose(raw: unknown): string | null {
  const seen = new Set<unknown>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return null;
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (o.kind === "leaf" && o.surfaceId === "secondary" && typeof o.projectKey === "string") {
      return o.projectKey;
    }
    for (const val of Object.values(o)) {
      const hit = Array.isArray(val)
        ? val.reduce<string | null>((acc, item) => acc ?? walk(item, depth + 1), null)
        : walk(val, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(raw, 0);
}

/**
 * 저장된 값 → 표면 트리(마이그레이션·복구 단일 진입점).
 *
 * **예외 경계**(FA): 어떤 throw(깊이/노드 예산·순환·이상치)든 여기서 잡아 손상
 * 취급 → 레거시/기본으로 낙하한다. 앱 시작이 이 함수로 절대 크래시하지 않는다.
 *
 * **rawTree 우선·배타(FC2)**: rawTree가 present면 그것 하나로만 해석한다 — 유효
 * 하면 채택, 아니면(손상·예산 초과·미래 추출 실패) **즉시 기본**이고 legacy로
 * 떨어지지 않는다("손상=기본" 계약, 임의 부활 차단). legacy 마이그레이션은
 * rawTree가 **null/부재일 때만** 적용한다.
 *
 * 우선순위:
 *  1. `rawTree` present:
 *     a. 구조+의미 유효 → 정규화해 그대로(version 무관).
 *     b. version이 **현재보다 높을 때만** secondary 최선 추출(미래 대비).
 *     c. 그 외(현재/무버전 손상·throw) → 기본(primary 단독) — legacy 무시.
 *  2. `rawTree` 부재(null) → 레거시 `dualProject` 문자열로 구성(구→신 마이그레이션).
 *  3. 레거시도 없으면 → 기본.
 *
 * @param rawTree 트리 JSON을 파싱한 값(또는 null). P3'은 디스크에서 트리 블롭을
 *   읽지 않으므로(FB — 단일 legacy 키 persist) 실사용은 null이지만, 스키마의
 *   parse/validate 계약과 미래(P6) 트리 persist를 위해 완전 견고화한다.
 * @param legacyDual localStorage `"dualProject"` 문자열(구·현 표현) 또는 null.
 */
export function parseSurfaceTree(rawTree: unknown, legacyDual: string | null): SurfaceTree {
  if (rawTree !== null && rawTree !== undefined) {
    // present → rawTree 하나로만 해석. 손상이면 기본(legacy 부활 금지).
    try {
      if (typeof rawTree === "object") {
        const t = rawTree as Record<string, unknown>;
        const version = typeof t.version === "number" ? t.version : null;
        if (version !== null && isValidTree(t.root)) {
          return { version, root: t.root as SurfaceNode };
        }
        // 미래(더 높은 version) 스키마만 secondary 최선 추출.
        if (version !== null && version > SURFACE_TREE_VERSION) {
          const loose = extractSecondaryLoose(rawTree);
          if (loose) return treeWithSecondary(loose);
        }
      }
    } catch {
      // 예산 초과·순환 등 어떤 throw든 손상 취급.
    }
    return emptyTree(); // present-but-corrupt → 기본(legacy 마이그레이션 금지)
  }
  // rawTree 부재(null) → 레거시 문자열로 구→신 마이그레이션.
  if (typeof legacyDual === "string" && legacyDual) return treeWithSecondary(legacyDual);
  return emptyTree();
}

/**
 * 디스크 로드 정본화 + 다운그레이드 화해(멀티프로젝트 P6).
 *
 * P6부터 트리 블롭(`rawTree`)이 방향까지 담는 디스크 정본이고, 레거시 문자열
 * (`legacy`)은 구버전 앱이 읽는 **파생 미러**다. parseSurfaceTree로 파싱한 뒤,
 * 두 표현이 어긋나면(구버전 세션이 legacy만 변경 — surfaceTree는 못 만짐)
 * **legacy를 멤버십 정본, 트리를 방향 정본**으로 단방향 화해한다:
 *  - legacy 부재인데 트리에 secondary → 구버전이 닫음 → 부활 금지(기본).
 *  - legacy가 다른 프로젝트 → 그 프로젝트로, 트리 방향 보존.
 *  - rawTree 부재 → parse가 이미 legacy로 구성(정의상 일치) → 그대로.
 *  - 일치(신버전 동기 기록의 정상 경로) → 트리 그대로(방향 보존).
 */
export function resolveSurfaceTree(rawTree: unknown, legacy: string | null): SurfaceTree {
  const tree = parseSurfaceTree(rawTree, legacy);
  if (rawTree === null || rawTree === undefined) return tree; // legacy 경로 = 정의상 일치
  const treeSec = secondaryProject(tree);
  if ((legacy || null) === (treeSec || null)) return tree; // 정상 경로
  if (!legacy) return emptyTree(); // 구버전이 닫음 → 부활 금지
  return addSurface(emptyTree(), legacy, surfaceLayout(tree) ?? undefined); // 방향 보존
}
