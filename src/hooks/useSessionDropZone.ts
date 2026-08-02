/**
 * 세션 드래그 배치 (spec task 03) — MainArea에서 순수 이동 (P5 F-a).
 *
 * 아카이브/피커 행 드래그가 dock 위를 지날 때: 마우스가 올라간 그룹의 존
 * (중앙/가장자리 20%)을 계산해 하이라이트하고, 드롭 시 그 위치로 연다.
 * 전용 MIME에만 반응 — 트리 DnD·탭 창간 전송·OS Files와 무간섭 (spec §2).
 * dockview 자체 droptarget은 외부 드래그를 onUnhandledDragOverEvent 수락
 * 시에만 받는데 우리는 구독하지 않으므로 dockview 오버레이는 뜨지 않는다
 * (dockviewComponent.js rootCanDisplayOverlay — 리뷰 S10 실코드 확인).
 *
 * 좌표 → 타깃 계산은 순수 모듈(sessionDropZone.computeSessionDropTarget)에
 * 있다 — 여기서는 dockview/DOM에서 rect를 읽어 넘기기만 한다.
 */
import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview-react";
import {
  SESSION_DRAG_MIME,
  computeSessionDropTarget,
  decodeSessionDrag,
  sameZoneRect,
  type DropGroupRect,
  type SessionDragPayload,
  type SessionDropTarget,
} from "../components/sessionDropZone";

export interface SessionDropZoneDeps {
  /** 드롭 존은 주 surface 전용 (부는 수동적 dock). */
  isPrimary: boolean;
  /** 통합 레이어가 앞인가 — dev 레이어가 앞이면 프리뷰·드롭 모두 비활성. */
  integratedFront: boolean;
  /** 리마운트 stale 방지 — 이벤트마다 다시 읽는다. */
  getApi: () => DockviewApi | null;
  openOrActivateSession: (
    p: Omit<SessionDragPayload, "source">,
    position?: {
      referencePanel: string;
      direction: "right" | "left" | "above" | "below" | "within";
    },
  ) => void;
  /** 피커 드래그만 피커를 닫는다 (S11). */
  closePicker: () => void;
}

export interface SessionDropZone {
  /** .main-area 루트에 붙일 ref — 하이라이트 좌표계의 기준. */
  mainAreaRef: React.RefObject<HTMLDivElement>;
  /** 현재 프리뷰 (null = 표시 없음). */
  sessionDrop: SessionDropTarget | null;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export function useSessionDropZone(deps: SessionDropZoneDeps): SessionDropZone {
  const { isPrimary, integratedFront, getApi, openOrActivateSession, closePicker } = deps;

  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [sessionDrop, setSessionDrop] = useState<SessionDropTarget | null>(null);
  // dragleave 지연 클리어 타이머 — WebKitGTK는 자식 경계 전이에서도
  // relatedTarget이 null일 수 있어(리뷰 S5) 즉시 지우면 60Hz 깜빡인다.
  // 다음 dragover가 취소하고, 진짜 이탈이면 타이머가 지운다.
  const dropLeaveTimerRef = useRef<number | null>(null);
  const cancelLeaveTimer = () => {
    if (dropLeaveTimerRef.current !== null) {
      window.clearTimeout(dropLeaveTimerRef.current);
      dropLeaveTimerRef.current = null;
    }
  };

  const isSessionDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(SESSION_DRAG_MIME);

  /** dockview 그룹·host의 현재 rect를 읽어 순수 계산기에 넘긴다. */
  const targetAt = (x: number, y: number): SessionDropTarget | null => {
    const api = getApi();
    const host = mainAreaRef.current?.getBoundingClientRect();
    if (!api || !host) return null;
    const groups: DropGroupRect[] = api.groups.map((g) => ({
      ref: (g.activePanel ?? g.panels[0])?.id ?? null,
      rect: g.element.getBoundingClientRect(),
    }));
    return computeSessionDropTarget(groups, host, x, y, api.panels.length > 0);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!isPrimary) return; // 드롭 존은 주 surface 전용 (부는 수동적 dock)
    if (!isSessionDrag(e)) return;
    if (!integratedFront) return;
    cancelLeaveTimer();
    // 피커 위는 드롭 대상이 아니다 — 좌표 히트테스트가 피커 '뒤' 그룹으로
    // 새면, 되돌려 놓기(취소) 제스처가 실제 열기가 된다 (리뷰 S7b).
    if ((e.target as HTMLElement).closest?.(".claude-picker")) {
      setSessionDrop(null);
      return;
    }
    const next = targetAt(e.clientX, e.clientY);
    if (!next) {
      setSessionDrop(null); // preventDefault 없이 반환 → 이 좌표는 드롭 불허
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // dragover는 초당 수십 회 — 동일 타깃이면 setState 생략 (rect 4값 전부 비교, S4).
    setSessionDrop((prev) =>
      prev &&
      prev.referencePanel === next.referencePanel &&
      prev.zone === next.zone &&
      sameZoneRect(prev.hl, next.hl)
        ? prev
        : next,
    );
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (!isPrimary) return; // 드롭 존 핸들러 3종 동일 게이트 (D10)
    if (!isSessionDrag(e)) return;
    const rt = e.relatedTarget;
    if (rt instanceof Node && mainAreaRef.current?.contains(rt)) return; // 내부 이동
    cancelLeaveTimer();
    dropLeaveTimerRef.current = window.setTimeout(() => {
      dropLeaveTimerRef.current = null;
      setSessionDrop(null);
    }, 120);
  };

  const onDrop = (e: React.DragEvent) => {
    if (!isPrimary) return;
    if (!isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    cancelLeaveTimer();
    setSessionDrop(null);
    if (!integratedFront) return;
    if ((e.target as HTMLElement).closest?.(".claude-picker")) return; // 피커 위 드롭 = 취소
    const payload = decodeSessionDrag(e.dataTransfer.getData(SESSION_DRAG_MIME));
    if (!payload) return;
    // 드롭 좌표로 재계산 — 하이라이트와 결과가 항상 같은 입력에서 나온다 (S1).
    const target = targetAt(e.clientX, e.clientY);
    if (!target) return; // 유효 위치 아님 — 아무것도 열지 않음
    if (payload.source === "picker") closePicker(); // 피커 드래그만 피커를 닫는다 (S11)
    openOrActivateSession(
      payload,
      target.referencePanel
        ? {
            referencePanel: target.referencePanel,
            direction: target.zone === "center" ? "within" : target.zone,
          }
        : undefined,
    );
  };

  // 취소 백스톱 (리뷰 S2): Esc·창 밖 드롭·다른 핸들러의 drop 소비(stopPropagation)
  // 는 dragleave/drop을 우리에게 보장하지 않는다 — window 캡처 단계에서 정리.
  // (onDrop은 state가 아니라 드롭 좌표 재계산을 쓰므로, 캡처 단계에서 먼저
  // 지워져도 무해하다.)
  useEffect(() => {
    if (!isPrimary) return;
    const clear = () => {
      cancelLeaveTimer();
      setSessionDrop(null);
    };
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 드래그 중 레이어가 dev로 바뀌면 프리뷰 제거.
  useEffect(() => {
    if (!integratedFront) setSessionDrop(null);
  }, [integratedFront]);

  return { mainAreaRef, sessionDrop, onDragOver, onDragLeave, onDrop };
}
