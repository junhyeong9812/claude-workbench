/**
 * 우측 분할(project-dual-surface) 표시 판정 — 순수 함수 (리뷰 D1·D13).
 *
 * 렌더는 이 파생값으로 그린다: 자동 닫힘을 이펙트(커밋 후)에만 맡기면
 * setActive 직후 1프레임 동안 같은 프로젝트 dock 두 개가 공존해 layout
 * 저장 경합·세션 이중 attach가 열린다. 파생값이면 겹침 프레임이 구조적으로 0.
 */
export function resolveVisibleDual(
  dualProject: string | null,
  activeProject: string | null,
  projectPaths: readonly string[],
): string | null {
  if (!dualProject) return null;
  // 동일 프로젝트 양쪽 금지 (spec §2) — 렌더 시점에 즉시 숨김.
  if (dualProject === activeProject) return null;
  // 열린 탭 목록에 없으면(닫혔거나 hydration 전) 숨김 — persist 정리는
  // 이펙트 몫이고, 표시는 항상 이 멤버십을 따른다.
  if (!projectPaths.includes(dualProject)) return null;
  return dualProject;
}
