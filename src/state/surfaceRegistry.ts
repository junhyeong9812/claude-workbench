import type { DockviewApi } from "dockview-react";

/**
 * 창 내 dock surface 레지스트리 (project-dual-surface 리뷰 D3·D4).
 *
 * 주(primary)/부(secondary) surface가 각자의 dockview api를 등록해, 세션
 * 중복 attach 방지(openOrActivateSession)와 closeRequest 소유 판정이
 * "수신 측 추측"이 아니라 **모든 surface를 아우르는 조회**로 동작한다.
 * 모듈 스코프 = 창별 싱글턴(각 웹뷰 독립).
 */
const apis = new Map<string, DockviewApi>();

export function registerSurface(key: string, api: DockviewApi): void {
  apis.set(key, api);
}

/** 등록 해제 — `api`를 주면 그 api가 현재 등록본일 때만 지운다(리마운트로
 * 새 api가 이미 등록된 뒤 옛 인스턴스의 늦은 cleanup이 덮지 않게). */
export function unregisterSurface(key: string, api?: DockviewApi): void {
  if (!api || apis.get(key) === api) apis.delete(key);
}

/** uuid 세션을 소유한 패널을 전 surface에서 찾는다 (없으면 null).
 * dispose 직후의 stale api가 남아 있을 수 있어 조회는 방어적으로. */
export function findSessionPanel(uuid: string) {
  for (const api of apis.values()) {
    try {
      const p = api.panels.find((pl) => {
        const prm = pl.params as { sessionUuid?: string; loadSessionId?: string } | undefined;
        return prm?.sessionUuid === uuid || prm?.loadSessionId === uuid;
      });
      if (p) return p;
    } catch {
      /* disposed api — skip */
    }
  }
  return null;
}

/** 패널 id 소유 surface 조회 (closeRequest 고아 백스톱용). */
export function findPanelById(id: string) {
  for (const api of apis.values()) {
    try {
      const p = api.getPanel(id);
      if (p) return p;
    } catch {
      /* disposed api — skip */
    }
  }
  return null;
}
