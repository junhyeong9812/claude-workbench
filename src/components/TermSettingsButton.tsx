import { useState } from "react";
import { createPortal } from "react-dom";
import { TerminalSettings } from "./TerminalSettings";

/**
 * 터미널 색상 설정([`TerminalSettings`])의 **진입점** — 터미널을 띄우는 패널이
 * 저마다 하나씩 붙인다(T3: 툴바 "외관"에서 터미널 탭 안으로 이동).
 *
 * 모달 자체·저장 키·프리셋·적용 경로는 손대지 않는다. 여는 자리만 옮긴 것이라
 * 상태도 여기서 끝난다(전역 스토어를 늘리지 않는다 — 한 번에 하나만 열린다).
 *
 * 모달을 **포털로 `document.body`에 건다**: 이 버튼이 사는 곳은 dockview 패널
 * 안이고, 조상 어딘가에 transform이 걸리면 `position: fixed` 백드롭이 그 패널
 * 안에 갇힌다. 팝아웃 창에서는 그 창의 `document.body`로 간다(창마다 문서가
 * 따로이므로 각 창이 자기 모달을 띄운다).
 */
export function TermSettingsButton({
  className,
  label = "⚙",
  title = "터미널 색상 설정 — 프리셋 · 색 직접 지정 · 세션 알림",
}: {
  className: string;
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={className}
        title={title}
        aria-label="터미널 색상 설정"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open && createPortal(<TerminalSettings onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
