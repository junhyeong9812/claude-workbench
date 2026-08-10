import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { TerminalSettings } from "./TerminalSettings";

/**
 * 터미널 색상·세션 알림 설정([`TerminalSettings`])의 **진입점과 모달 레이어**
 * (T3: 툴바 "외관"에서 터미널 탭 안으로 이동).
 *
 * 모달 자체·저장 키·프리셋·적용 경로는 손대지 않는다 — 여는 자리만 옮긴 것이라,
 * 계약(단일 모달·포커스·Escape·role)은 전부 이 **래퍼 층**에서 해결한다.
 *
 * 구조가 둘로 갈린 이유(리뷰 V1·V2):
 *  - 열림 상태를 버튼 인스턴스가 들고 있으면 ⚙이 둘일 때 모달이 **겹쳐 뜨고**,
 *    팝오버 안의 트리거처럼 **버튼이 사라지면 모달까지 함께 사라진다**. 그래서
 *    소유권은 모듈 레벨 하나(= 창 하나 = JS 실행 컨텍스트 하나 — 팝아웃 창은
 *    번들을 따로 로드하므로 자기 모달을 따로 갖는다)로 두고, 그리는 일은 창
 *    루트에 한 번 놓인 [`TermSettingsLayer`]가 맡는다.
 *  - 포털은 DOM만 옮기고 **React 트리 이벤트는 부모로 그대로 버블한다**. 모달이
 *    패널 안에서 렌더되면 hex 입력의 Ctrl+←/→가 `ClaudeTermPanel`의
 *    `onContainerKey`(pane 이동)에 잡혀 커서 이동이 취소되고 포커스가 튀었다.
 *    레이어를 창 루트로 올려 그 조상 관계 자체를 없앴고, 그 위에 아래 키 전파
 *    차단을 백스톱으로 둔다.
 */

/* ---- 창별 단일 소유권 (모듈 레벨) ---- */
let openState = false;
/** 닫을 때 포커스를 돌려줄 트리거. 열 때 기록하고 레이어가 되돌린다. */
let triggerEl: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const isOpen = () => openState;

/** 설정 모달 열기 — 이미 열려 있으면 트리거만 갱신한다(겹쳐 뜨지 않는다). */
export function openTermSettings(from: HTMLElement | null) {
  triggerEl = from;
  openState = true;
  emit();
}

export function closeTermSettings() {
  if (!openState) return;
  openState = false;
  emit();
}

/** 테스트에서 창 간 상태가 새지 않도록. */
export function __resetTermSettingsForTest() {
  openState = false;
  triggerEl = null;
  emit();
}

/**
 * 창마다 **한 번만** 놓는 모달 레이어(App 루트·팝아웃 워크벤치 루트).
 * 열려 있을 때만 포털로 `document.body`에 건다 — 이 레이어가 사는 곳이
 * dockview 위쪽이라도, 조상에 transform이 걸리면 `position: fixed` 백드롭이
 * 그 서브트리에 갇힐 수 있다.
 */
export function TermSettingsLayer() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 열리면 다이얼로그로 포커스를 옮기고, 닫히면 트리거로 되돌린다(#78 팝오버와
  // 같은 계약). 되돌리기는 **effect cleanup**에서 한다 — 닫힘 커밋으로 모달이
  // DOM에서 빠진 뒤라야 포커스가 배경에 남지 않는다. 트리거가 그새 사라졌으면
  // (팝오버 안의 버튼이 모달을 여는 클릭으로 닫혔을 수 있다) 건드리지 않는다.
  useEffect(() => {
    if (!open) return;
    const back = triggerEl;
    wrapRef.current?.focus();
    return () => {
      if (back && back.isConnected) back.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={wrapRef}
      role="dialog"
      aria-modal="true"
      aria-label="터미널·알림 설정"
      tabIndex={-1}
      // 키 이벤트는 여기서 끊는다: 모달 안의 타이핑(hex 입력)이 앱 전역·패널
      // 단축키로 새어 나가면 안 된다(V1 — Ctrl+←/→가 pane 이동으로 가로채였다).
      // preventDefault는 하지 않으므로 입력 자체는 그대로 동작한다.
      onKeyDown={(e) => {
        if (e.key === "Escape") closeTermSettings();
        e.stopPropagation();
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <TerminalSettings onClose={closeTermSettings} />
    </div>,
    document.body,
  );
}

/**
 * 설정 진입점 버튼. 상태를 들지 않으므로 이 버튼이 언마운트돼도(팝오버가 닫혀도)
 * 모달은 레이어에서 계속 살아 있다.
 */
export function TermSettingsButton({
  className,
  label = "⚙",
  title = "터미널 색상 · 세션 알림 설정",
}: {
  className: string;
  label?: string;
  title?: string;
}) {
  return (
    <button
      className={className}
      title={title}
      aria-label="터미널·알림 설정"
      aria-haspopup="dialog"
      onClick={(e) => openTermSettings(e.currentTarget)}
    >
      {label}
    </button>
  );
}
