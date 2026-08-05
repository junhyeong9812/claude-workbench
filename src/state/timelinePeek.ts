/**
 * 우측 단발성 타임라인 peek — dock 조작 규칙 (순수 모듈).
 *
 * Claude 탭 툴바에서 열면 그 탭 **오른쪽**에 타임라인만 있는 임시 패널이 붙는다
 * (리뷰 모드가 쓰는 `addPanel(position:{referencePanel, direction:"right"})` 그대로).
 *
 * 두 가지 성질이 규칙으로 고정된다:
 * 1. **세션당 1개** — 패널 id가 uuid로 결정적이라, 이미 열려 있으면 새로 만들지
 *    않고 그 패널을 활성화한다(diff 패널의 결정적 id 선례와 같은 방식).
 * 2. **단발성(persist 없음)** — dockview의 `toJSON()`은 모든 패널을 담으므로 peek도
 *    저장은 된다. 되살아나지 않게 하는 지점은 **복원 직후**다: `fromJSON` 뒤에
 *    {@link closePeekPanels}가 peek 패널을 즉시 닫는다(레이아웃 저장 구독 전에
 *    호출하므로 재저장도 유발하지 않는다). 저장을 막는 대신 복원을 막는 이유는
 *    저장 시점의 직렬화 blob을 재구성하는 것보다 안전하고(그리드 트리 손대지 않음)
 *    전송·팝아웃으로 옮겨간 peek까지 같은 규칙으로 걸리기 때문.
 */
import { findPanelById } from "./surfaceRegistry";

/** peek 패널의 `params.kind` — 레이아웃 복원 필터·세션 종료 처리 제외 판정 키.
 * (params에 `sessionId`가 없으므로 패널 제거 시 세션 종료 경로는 타지 않는다.) */
export const PEEK_KIND = "timelinepeek";

/** 결정적 패널 id — 같은 세션 peek 중복 열기를 id 하나로 막는다. */
export const peekPanelId = (uuid: string): string => `timeline-peek:${uuid}`;

/** 이 패널 params가 단발성 peek인가 (복원 시 제거 대상). */
export function isPeekParams(params: unknown): boolean {
  return (params as { kind?: unknown } | null | undefined)?.kind === PEEK_KIND;
}

/** dock api 중 이 모듈이 쓰는 최소 표면 (실제 인자는 DockviewApi). */
interface PeekablePanel {
  id: string;
  params?: unknown;
  api: { setActive(): void; close(): void };
}
export interface PeekDock {
  getPanel(id: string): PeekablePanel | undefined;
  addPanel(opts: {
    id: string;
    component: string;
    title: string;
    params: Record<string, unknown>;
    position?: { referencePanel: string; direction: "right" };
  }): unknown;
  readonly panels: readonly PeekablePanel[];
}

export interface PeekOpenArgs {
  /** peek를 연 Claude 탭의 패널 id — 오른쪽 배치 기준이자 "원본 탭 닫힘" 판정 키. */
  sourcePanelId: string;
  /** 대상 세션 uuid. */
  uuid: string;
  /** 세션의 프로젝트(cwd) — 스냅샷 시드 조회에 쓴다. */
  project: string | null;
  /** 헤더·탭 제목에 쓸 세션 이름. */
  title: string;
}

/**
 * 대상 세션의 peek를 연다 — 이미 있으면(이 dock이든 다른 surface든) 활성화만.
 * 반환값은 어느 쪽이었는지(테스트·호출부 판단용).
 */
export function openTimelinePeek(dock: PeekDock, args: PeekOpenArgs): "focused" | "opened" {
  const id = peekPanelId(args.uuid);
  // 자기 dock 우선, 그다음 전 surface(우측 분할 dock으로 옮겨 둔 peek) 조회.
  const existing = dock.getPanel(id) ?? findPanelById(id);
  if (existing) {
    existing.api.setActive();
    return "focused";
  }
  dock.addPanel({
    id,
    component: PEEK_KIND,
    title: `타임라인 — ${args.title}`,
    params: {
      kind: PEEK_KIND,
      uuid: args.uuid,
      title: args.title,
      ...(args.project ? { project: args.project } : {}),
      sourcePanelId: args.sourcePanelId,
    },
    position: { referencePanel: args.sourcePanelId, direction: "right" },
  });
  return "opened";
}

/** 복원된 레이아웃에서 단발성 peek 패널을 전부 닫는다 (닫은 개수 반환). */
export function closePeekPanels(dock: Pick<PeekDock, "panels">): number {
  let n = 0;
  for (const p of [...dock.panels]) {
    if (!isPeekParams(p.params)) continue;
    p.api.close();
    n++;
  }
  return n;
}
