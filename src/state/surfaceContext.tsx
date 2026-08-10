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
 * 멀티프로젝트 P2 단계에서는 활성 표면 개념이 아직 없고 소비자가 primary 하나뿐
 * 이라 **상수 "primary"** 를 돌려준다 → 어느 발행이든 primary로 라우팅되어
 * 완전 무동작이다. 이 함수가 요청버스 표면 라우팅의 **유일한 seam**이다:
 * P4'(활성 표면·포커스 모델)가 이 한 함수를 "지금 포커스된 표면 id를 읽어
 * 돌려주도록" 교체하면, 각 요청 발행이 자동으로 활성 표면을 겨냥하고 그 표면의
 * MainArea만 소비하게 된다(소비부는 이미 `req.targetSurfaceId === useSurfaceId()`
 * 로 게이트되어 있으므로 소비부 재작업 없이 라우팅이 살아난다).
 */
export function activeSurfaceId(): SurfaceId {
  return "primary";
}
