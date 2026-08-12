import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { isInPopoverLayer, useAnchoredPosition } from "../hooks/useAnchoredPosition";

/**
 * 좁아지면 접히는 컨트롤 묶음 (반응형 1차 인프라 B).
 *
 * 가로로 늘어선 세그/버튼군은 표면이 좁아지면 한 줄에 눌려 **밖으로 잘린다**
 * (`.claudeterm-head-controls`·`.toolbar`는 wrap도 overflow도 없다). 여기서는
 * 두 가지 접기를 제공한다 — 사용자 요청("좁으면 셀렉트박스로") 직결:
 *
 *  - [`CollapsibleSeg`] : `.seg` 버튼군 → `<select>`
 *  - [`CollapsibleControls`] : 보조 버튼군 → "⋯" 오버플로 메뉴(포털+클램프)
 *
 * ## 무엇을 재는가 (loop 방지)
 * 자기 자신이 아니라 **자기를 담은 행(host)** 의 폭을 잰다. 컨트롤 묶음은 보통
 * `flex: 0 0 auto` 라 자기 폭이 곧 콘텐츠 폭이어서, 그걸 재면 접혀도 임계 아래로
 * 내려가지 않거나(접기가 안 걸림) 접힘→넓어짐→펼침→좁아짐 진동이 생긴다. host는
 * 폭이 **외부에서 결정되는** 행(`.toolbar`·`.surface-toolbar`·
 * `.claudeterm-pane-head` — 전부 부모 stretch)이라 내용이 바뀌어도 폭이 안 변한다.
 *
 * ## 넓은 폭 = base 동일
 * 래퍼는 `display: contents`(`.collapse-host`)라 박스를 만들지 않는다 → 펼친
 * 상태의 자식들은 부모 flex에 그대로 참여한다(gap·정렬 불변). 측정 수단이 없는
 * 환경(ResizeObserver 부재·폭 0)에서는 **항상 펼친 쪽**으로 남는다 — 접기는
 * "좁다는 증거가 있을 때만" 발동한다.
 *
 * ## 임계값
 * 컴포넌트별로 호출자가 준다(전역 1값 금지 — 클러스터마다 넘침 지점이 다르다).
 * 값의 근거는 실측(헤드리스 Chrome + 실 App.css)이며 각 호출부 주석에 있다.
 */

/**
 * host 행 폭이 임계 미만인가. **폭 0(미배치·측정 불가)은 접지 않는다** — 증거
 * 없이 접으면 첫 프레임이 base와 달라진다.
 */
export function shouldCollapse(hostWidth: number, threshold: number): boolean {
  return hostWidth > 0 && hostWidth < threshold;
}

/**
 * 자기 위치에서 host 행을 찾아 그 폭을 관측한다.
 * `host`가 CSS 선택자면 `closest`로, 없으면 부모 요소를 host로 본다.
 */
function useNarrowHost(threshold: number, host?: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const self = ref.current;
    if (!self) return;
    const row = (host ? self.closest(host) : self.parentElement) as HTMLElement | null;
    if (!row) return;
    const update = () => setNarrow(shouldCollapse(row.getBoundingClientRect().width, threshold));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => ro.disconnect();
  }, [threshold, host]);

  return { ref, narrow };
}

/* ------------------------------------------------------------------ */
/* seg → select                                                        */
/* ------------------------------------------------------------------ */

export type SegItem = {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
};

/**
 * 가로 세그먼트 컨트롤. host가 `threshold`보다 좁으면 `<select>`로 바뀐다.
 * 펼친 렌더는 기존 `.seg`/`.seg-item` 마크업과 **같다**(tag까지 호출자가 고른다).
 */
export function CollapsibleSeg({
  threshold,
  host,
  tag = "span",
  items,
  value,
  onChange,
  ariaLabel,
  segClassName,
  selectTitle,
}: {
  /** host 행이 이 폭(px) 미만이면 select로 접는다. */
  threshold: number;
  /** host 행 CSS 선택자(없으면 부모 요소). */
  host?: string;
  /** 펼친 상태의 컨테이너 태그 — 기존 마크업과 맞춘다. */
  tag?: "span" | "div";
  items: readonly SegItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  segClassName?: string;
  /** 접힌 select의 title(개별 항목 title은 select에 담을 수 없다). */
  selectTitle?: string;
}) {
  const { ref, narrow } = useNarrowHost(threshold, host);
  const Tag = tag;
  return (
    <span className="collapse-host" ref={ref}>
      {narrow ? (
        <select
          className="collapse-select"
          aria-label={ariaLabel}
          title={selectTitle ?? ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {items.map((i) => (
            <option key={i.id} value={i.id} disabled={i.disabled}>
              {i.label}
            </option>
          ))}
        </select>
      ) : (
        <Tag className={segClassName ? `seg ${segClassName}` : "seg"} role="group" aria-label={ariaLabel}>
          {items.map((i) => (
            <button
              key={i.id}
              className={`seg-item${value === i.id ? " seg-on" : ""}`}
              aria-pressed={value === i.id}
              disabled={i.disabled}
              title={i.title}
              onClick={() => onChange(i.id)}
            >
              {i.label}
            </button>
          ))}
        </Tag>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 버튼군 → "⋯" 오버플로 메뉴                                          */
/* ------------------------------------------------------------------ */

/**
 * 메뉴 안에서 포커스를 받을 수 있는 항목들 — **실제 DOM 자손만**이라 중첩 포털
 * (하위 팝오버)은 포함되지 않는다. disabled는 건너뛴다(포커스 못 받는다).
 */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  const sel = "button, select, a[href], [tabindex]:not([tabindex='-1'])";
  return [...menu.querySelectorAll<HTMLElement>(sel)].filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
}

/**
 * 보조 버튼 묶음. host가 좁으면 "⋯" 하나로 접고, 원래 자식들을 포털 메뉴에
 * 세로로 담는다(자식 엘리먼트 그대로 — 핸들러·상태 전부 보존).
 *
 * 메뉴 닫힘 계약:
 *  - 바깥 클릭 → 닫힘. 단 **다른 포털 팝오버 안**(`data-popover-layer`)은 바깥이
 *    아니다 — 메뉴 안에서 연 하위 팝오버(에이전트 옵션)를 누르는 순간 부모 메뉴가
 *    닫혀 그 팝오버까지 사라지는 것을 막는다.
 *  - **자기 메뉴 DOM 안** 클릭 → 실행됐다고 보고 닫힘. `data-keep-menu` 조상이
 *    있으면 유지(자체 팝오버를 여는 트리거).
 *  - 그 밖의 클릭(= 이 메뉴가 React 트리로 품고 있는 **중첩 포털**에서 올라온 것)
 *    → 무시. React 포털 이벤트는 DOM이 아니라 React 트리로 버블하므로 body에 나가
 *    있는 하위 팝오버의 클릭도 이 핸들러에 도달한다. `closest()`는 실제 DOM을
 *    타므로 그 안에서는 `data-keep-menu`를 찾지 못해, 첫 클릭에 부모 메뉴가 닫히고
 *    하위 팝오버까지 언마운트됐다(리뷰 F1 — 접힌 툴바에서 모델/강도 지정 세션
 *    생성 불가). 판정 기준을 "내 메뉴 DOM 안인가"로 바꾸면 중첩 포털은 자연히
 *    제외된다.
 *  - Escape → 닫으면서 "⋯"로 포커스 복귀. 넓어지면 자동으로 닫는다.
 *
 * 키보드(role=menu 계약): 열면 첫 항목에 포커스, ↑↓/Home/End로 이동, Tab은 메뉴
 * 안을 순환한다(포털이 body 끝이라 그냥 두면 Tab이 문서 끝으로 샌다).
 */
export function CollapsibleControls({
  threshold,
  host,
  label = "더 보기",
  moreClassName,
  children,
}: {
  threshold: number;
  host?: string;
  /** "⋯" 버튼의 aria-label·title. */
  label?: string;
  /** "⋯" 버튼에 얹을 추가 클래스(툴바에서는 `toolbar-btn`). */
  moreClassName?: string;
  children: ReactNode;
}) {
  const { ref, narrow } = useNarrowHost(threshold, host);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(open, btnRef, popRef, {
    align: "end",
    fallbackWidth: 200,
    maxHeight: 420,
  });

  // 넓어지면 접힌 UI 자체가 사라지므로 열린 메뉴도 함께 닫는다.
  useEffect(() => {
    if (!narrow && open) setOpen(false);
  }, [narrow, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      if (isInPopoverLayer(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // role=menu 계약: 자식은 호출자가 준 임의 엘리먼트라 롤을 prop으로 못 받는다 →
  // 열릴 때 실제 DOM에서 항목을 찾아 menuitem을 붙이고 첫 항목으로 포커스를 옮긴다
  // (호출자가 이미 role을 지정했으면 건드리지 않는다). 닫히면 이 노드들은 언마운트
  // 되므로(포털→인라인은 재마운트) 정리할 잔재가 없다.
  useLayoutEffect(() => {
    if (!open) return;
    const items = menuItems(popRef.current);
    for (const el of items) if (!el.hasAttribute("role")) el.setAttribute("role", "menuitem");
    items[0]?.focus();
  }, [open]);

  /** 닫으면서 "⋯"로 포커스를 되돌린다 — 단 항목이 포커스를 이미 다른 곳으로
   *  옮겼으면(패널 열기 등) 뺏지 않는다. */
  const closeAndRestore = () => {
    const keepFocus = !popRef.current?.contains(document.activeElement);
    setOpen(false);
    if (!keepFocus) btnRef.current?.focus();
  };

  return (
    <span className="collapse-host" ref={ref}>
      {narrow ? (
        <>
          <button
            ref={btnRef}
            type="button"
            className={moreClassName ? `collapse-more ${moreClassName}` : "collapse-more"}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={() => setOpen((v) => !v)}
          >
            ⋯
          </button>
          {open &&
            createPortal(
              <div
                ref={popRef}
                className="collapse-menu"
                data-popover-layer=""
                role="menu"
                aria-label={label}
                style={{
                  left: pos?.left ?? 0,
                  top: pos?.top ?? 0,
                  maxHeight: pos?.maxHeight,
                  visibility: pos ? "visible" : "hidden",
                }}
                onClick={(e) => {
                  const t = e.target as Node;
                  // 중첩 포털에서 React 트리로 올라온 클릭 = 내 메뉴 DOM 밖 → 무시.
                  if (!popRef.current?.contains(t)) return;
                  // 자기 팝오버를 여는 트리거(메뉴 안)는 눌러도 메뉴를 유지한다.
                  if ((t as Element).closest?.("[data-keep-menu]")) return;
                  closeAndRestore();
                }}
                onKeyDown={(e) => {
                  // 중첩 포털에서 올라온 키는 그쪽 팝오버가 소유한다(실제 DOM 기준).
                  if (!popRef.current?.contains(e.target as Node)) return;
                  const items = menuItems(popRef.current);
                  if (items.length === 0) return;
                  const idx = items.indexOf(document.activeElement as HTMLElement);
                  const move = (next: number) => {
                    e.preventDefault();
                    items[((next % items.length) + items.length) % items.length].focus();
                  };
                  if (e.key === "ArrowDown") move(idx + 1);
                  else if (e.key === "ArrowUp") move(idx - 1);
                  else if (e.key === "Home") move(0);
                  else if (e.key === "End") move(items.length - 1);
                  // Tab이 문서 끝(포털은 body 마지막 자식)으로 새지 않게 순환시킨다.
                  else if (e.key === "Tab") move(e.shiftKey ? idx - 1 : idx + 1);
                }}
              >
                {children}
              </div>,
              document.body,
            )}
        </>
      ) : (
        children
      )}
    </span>
  );
}
