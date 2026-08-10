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
