/**
 * 세션 목록(아카이브 패널·+Claude 피커) 행을 dock 위로 드래그해 배치하는
 * 드롭 존 계산 — orca AI Vault 문법: 대상 그룹 중앙 = 그 그룹에 탭 추가,
 * 가장자리 밴드 = 그 방향으로 스플릿.
 *
 * 순수 모듈 (spec §2 — 단위 테스트 대상). DOM/dockview 의존 없음.
 */

/** 전용 dataTransfer MIME — 트리 DnD·창간 전송·OS Files 경로와 상호 무간섭의
 * 근거(spec §2): 이 타입이 실린 드래그에만 드롭 존이 반응한다. */
export const SESSION_DRAG_MIME = "application/x-workbench-session";

export interface SessionDragPayload {
  /** 세션 UUID (resume 대상 — loadSessionId로 들어간다). */
  uuid: string;
  /** 세션의 원 project 경로 (cwd pin — activeProject 전환 없음).
   * 빈 문자열은 디코드 단계에서 거부한다 — 조용히 activeProject로 폴백하면
   * cross-project resume 의미가 무음으로 깨진다 (리뷰 S8). */
  project: string;
  /** 탭 제목. */
  title: string;
  /** 드래그 출처 — 드롭 성공 시 피커만 닫기 위한 구분 (리뷰 S11). */
  source: "picker" | "archive";
}

export function encodeSessionDrag(p: SessionDragPayload): string {
  return JSON.stringify(p);
}

/** 역직렬화 + 형 검증 — 외부 드래그/손상 payload는 null (조용한 절단 대신
 * 드롭 무시가 계약: 우리 MIME이 아니면 애초에 핸들러가 반응하지 않는다). */
export function decodeSessionDrag(raw: string): SessionDragPayload | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      v &&
      typeof v === "object" &&
      typeof v.uuid === "string" &&
      v.uuid.length > 0 &&
      typeof v.project === "string" &&
      v.project.length > 0 &&
      typeof v.title === "string" &&
      (v.source === "picker" || v.source === "archive")
    ) {
      return { uuid: v.uuid, project: v.project, title: v.title, source: v.source };
    }
  } catch {
    /* not ours */
  }
  return null;
}

/** dockview Direction과 이름을 맞춘 존 — center만 'within'으로 매핑된다. */
export type DropZone = "center" | "left" | "right" | "above" | "below";

export interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 좌표(x,y)가 rect의 어느 존인가. band = 가장자리 밴드 비율(기본 0.2).
 * 두 밴드가 겹치는 모서리는 더 가까운 변이 이긴다. rect 밖·0 크기 = null.
 */
export function resolveDropZone(rect: ZoneRect, x: number, y: number, band = 0.2): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return null;
  const edges: Array<[DropZone, number]> = [
    ["left", rx],
    ["right", 1 - rx],
    ["above", ry],
    ["below", 1 - ry],
  ];
  let zone: DropZone = "left";
  let dist = Infinity;
  for (const [z, d] of edges) {
    if (d < dist) {
      dist = d;
      zone = z;
    }
  }
  return dist < band ? zone : "center";
}

/** 두 사각형이 (eps px 이내로) 같은가 — dragover마다의 setState 절약 가드용.
 * 네 값 전부 비교한다: left/top만 보면 창 리사이즈로 크기만 변한 하이라이트가
 * 옛 크기로 고정된다 (리뷰 S4). */
export function sameZoneRect(a: ZoneRect, b: ZoneRect, eps = 1): boolean {
  return (
    Math.abs(a.left - b.left) < eps &&
    Math.abs(a.top - b.top) < eps &&
    Math.abs(a.width - b.width) < eps &&
    Math.abs(a.height - b.height) < eps
  );
}

/** 존 하이라이트 사각형 (같은 좌표계) — 스플릿 존은 결과 반쪽을, 중앙은 전체를
 * 미리보기로 칠한다 (orca와 동일한 프리뷰 문법). */
export function zoneHighlight(rect: ZoneRect, zone: DropZone): ZoneRect {
  const { left, top, width, height } = rect;
  switch (zone) {
    case "left":
      return { left, top, width: width / 2, height };
    case "right":
      return { left: left + width / 2, top, width: width / 2, height };
    case "above":
      return { left, top, width, height: height / 2 };
    case "below":
      return { left, top: top + height / 2, width, height: height / 2 };
    case "center":
      return { left, top, width, height };
  }
}

/** 드롭 타깃 후보 = dock 그룹 1개. `ref`는 그 그룹의 대표 패널 id
 * (activePanel ?? panels[0]); 빈 그룹은 null — 프리뷰-결과 계약을 지킬 수 없어
 * 대상에서 제외된다 (리뷰 S3). `rect`는 host와 같은 (뷰포트) 좌표계. */
export interface DropGroupRect {
  ref: string | null;
  rect: ZoneRect;
}

export interface SessionDropTarget {
  /** null = 빈 dock 기본 배치. */
  referencePanel: string | null;
  zone: DropZone;
  /** host 로컬 좌표의 하이라이트 사각형. */
  hl: ZoneRect;
}

/**
 * 좌표 → 드롭 타깃. dragover(프리뷰)와 drop(실행)이 **같은 함수·같은 입력**을
 * 쓴다 — 렌더 state를 drop의 진실로 쓰면 마지막 dragover 커밋 전의 drop이 직전
 * 존으로 열린다(리뷰 S1: dragover=continuous, drop=discrete 우선순위 역전).
 *
 * 겹치는 그룹(저장 레이아웃이 floating group을 복원할 수 있다 — 리뷰 S12 감사)
 * 은 히트한 것 중 **최소 면적**을 고른다: floating은 타일 위에 더 작게 떠 있으
 * 므로 최상단(가장 안쪽)을 근사한다.
 *
 * null = 유효한 드롭 위치 아님(비어 있지 않은 dock의 그룹 밖 여백 포함 — 리뷰
 * S7: "빈 dock"만 기본 배치 대상). `hasPanels` = dock에 패널이 하나라도 있나.
 */
export function computeSessionDropTarget(
  groups: DropGroupRect[],
  host: ZoneRect,
  x: number,
  y: number,
  hasPanels: boolean,
): SessionDropTarget | null {
  let best: { ref: string; rect: ZoneRect; zone: DropZone; area: number } | null = null;
  for (const g of groups) {
    if (!g.ref) continue;
    const r = g.rect;
    const zone = resolveDropZone(r, x, y);
    if (zone === null) continue;
    const area = r.width * r.height;
    if (!best || area < best.area) best = { ref: g.ref, rect: r, zone, area };
  }
  if (best) {
    const hl = zoneHighlight(best.rect, best.zone);
    return {
      referencePanel: best.ref,
      zone: best.zone,
      hl: {
        left: hl.left - host.left,
        top: hl.top - host.top,
        width: hl.width,
        height: hl.height,
      },
    };
  }
  if (!hasPanels) {
    return {
      referencePanel: null,
      zone: "center",
      hl: { left: 0, top: 0, width: host.width, height: host.height },
    };
  }
  return null;
}
