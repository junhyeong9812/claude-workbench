/**
 * SurfaceContext — 표면(surface)별 프로젝트 컨텍스트 (멀티프로젝트 P0).
 *
 * 이 단계는 **완전 무동작 인프라**다. 각 표면(주=primary / 부=secondary)이
 * 자기 프로젝트를 서브트리에 주입할 통로만 깐다 — 소비처(activeProject 직독)는
 * 아직 한 줄도 바꾸지 않는다(P1·P2 몫). 값은 현재 dual이 계산하는 것을 그대로
 * 반사한다: primary.project = activeProject, secondary.project = 우측 분할이
 * 표시하는 프로젝트(resolveVisibleDual 결과).
 *
 * 향후(P1) 사이드바·요청버스 소비처가 `useAppStore(s => s.activeProject)` 대신
 * `useSurfaceProject()`를 읽어 "자기 표면의 프로젝트"로 동작하게 된다.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type SurfaceId = "primary" | "secondary";

export interface SurfaceContextValue {
  surfaceId: SurfaceId;
  /** 이 표면이 소유한 프로젝트 경로 (없으면 null — hydration 전·닫힘). */
  project: string | null;
}

/** 프로바이더 밖에서 훅을 쓰면(개발 오용) 즉시 드러나도록 기본값은 null. */
const SurfaceContext = createContext<SurfaceContextValue | null>(null);

export function SurfaceProvider({
  surfaceId,
  project,
  children,
}: {
  surfaceId: SurfaceId;
  project: string | null;
  children: ReactNode;
}) {
  const value = useMemo<SurfaceContextValue>(
    () => ({ surfaceId, project }),
    [surfaceId, project],
  );
  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>;
}

/** 표면 컨텍스트 전체. 프로바이더 밖 호출은 명확한 에러(개발 오용 방지). */
export function useSurface(): SurfaceContextValue {
  const ctx = useContext(SurfaceContext);
  if (ctx === null) {
    throw new Error(
      "useSurface()는 <SurfaceProvider> 안에서만 호출할 수 있습니다 " +
        "(표면 컨텍스트 밖에서 호출됨).",
    );
  }
  return ctx;
}

/** 이 표면이 소유한 프로젝트 경로. */
export function useSurfaceProject(): string | null {
  return useSurface().project;
}

/** 이 표면의 식별자("primary" | "secondary"). */
export function useSurfaceId(): SurfaceId {
  return useSurface().surfaceId;
}

/**
 * 현재 "활성 표면"의 id — 요청버스 발행(§P2)이 라우팅 키로 실어 보내는 값.
 *
 * **멀티프로젝트 P4'(활성 표면·포커스 모델)**: 이 함수가 요청버스 표면 라우팅의
 * **유일한 seam**이다. 마지막으로 클릭/상호작용한 표면 id를 돌려주므로, 각 요청
 * 발행이 자동으로 활성 표면을 겨냥하고 그 표면의 MainArea만 소비한다(소비부는
 * 이미 `req.targetSurfaceId === useSurfaceId()`로 게이트되어 있어 소비부 재작업
 * 없이 라우팅이 살아난다).
 *
 * 값은 **모듈 지역 홀더**로 들고, store의 `setActiveSurface`가 상태 갱신과 함께
 * `setActiveSurfaceSeam`으로 이 홀더를 동기화한다. 이 배선(홀더 ↔ store) 덕에
 * surfaceContext가 store를 import하지 않아 순환 의존이 없다. 발행부(store
 * 세터)는 발행 **시점**에 이 함수를 imperative하게 읽어 stamp하므로 React
 * 구독이 아니라 최신 활성 표면을 정확히 싣는다. 기본값은 "primary"(우측 표면
 * 없음·초기 로드).
 */
let activeSurfaceHolder: SurfaceId = "primary";

export function activeSurfaceId(): SurfaceId {
  return activeSurfaceHolder;
}

/** 활성 표면 seam 홀더를 갱신한다(**store의 setActiveSurface 전용**). React 상태와
 * 별개로 imperative 발행 경로가 읽는 최신값 — 둘은 setActiveSurface가 함께 쓴다. */
export function setActiveSurfaceSeam(id: SurfaceId): void {
  activeSurfaceHolder = id;
}

/**
 * 표면 라우팅 **소비 판정** — fault-tolerant 소비자(리뷰 재슬라이스, 4라운드
 * 정지 규칙). 요청은 자기 타깃 표면이 소비하되, **primary가 "비가시 타깃" 요청의
 * catch-all 소비자**다. primary는 항상 마운트/가시이므로 어떤 전이 인터리빙(발행
 * 후 소비 전 타깃 숨김)에도 요청이 **구조적으로 유실 불가**해진다.
 *
 * @param target 요청의 targetSurfaceId(발행 시점 활성 표면).
 * @param mine 이 소비자(MainArea)의 표면 id.
 * @param targetVisible 그 target 표면이 지금 실제로 렌더/가시인가(primary=항상 true·
 *   secondary=store `secondaryIsVisible`). 호출부가 계산해 넘긴다.
 *
 * **exactly-once**: target 가시 → 그 표면이 매칭 소비(primary fallback 조건 false).
 * target 비가시 → 그 표면은 마운트 안 돼 소비 불가이고 primary만 소비. 두 경우 모두
 * 정확히 1회(object 슬롯은 consume 시 null, counter 슬롯은 nonce dedup이 최종 보증).
 */
export function consumesRequest(target: SurfaceId, mine: SurfaceId, targetVisible: boolean): boolean {
  return target === mine || (mine === "primary" && !targetVisible);
}
