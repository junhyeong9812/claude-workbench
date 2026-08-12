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
 * 보조 버튼 묶음. host가 좁으면 "⋯" 하나로 접고, 원래 자식들을 포털 메뉴에
 * 세로로 담는다(자식 엘리먼트 그대로 — 핸들러·상태 전부 보존).
 *
 * 메뉴 닫힘 계약:
 *  - 바깥 클릭 → 닫힘. 단 **다른 포털 팝오버 안**(`data-popover-layer`)은 바깥이
 *    아니다 — 메뉴 안에서 연 하위 팝오버(에이전트 옵션)를 누르는 순간 부모 메뉴가
 *    닫혀 그 팝오버까지 사라지는 것을 막는다.
 *  - 메뉴 안 클릭 → 실행됐다고 보고 닫힘. `data-keep-menu` 조상이 있으면 유지
 *    (자체 팝오버를 여는 트리거).
 *  - Escape → 닫으면서 "⋯"로 포커스 복귀. 넓어지면 자동으로 닫는다.
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
                  if ((e.target as Element).closest?.("[data-keep-menu]")) return;
                  setOpen(false);
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
