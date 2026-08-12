import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * 트리거 앵커 기준 **뷰포트 클램프 팝오버 배치**(반응형 1차 인프라 C).
 *
 * B1의 `ProjectStatusBadge`가 포털+`position:fixed`로 검증한 배치 계산을 그대로
 * 뽑아낸 단일 출처다. 좁은 표면·창 가장자리에서 팝오버가 화면 밖으로 나가거나
 * (`left: 0` 고정), `overflow:hidden` 조상(`.dual-secondary`·`.surface-sidebar`)에
 * 잘려 사실상 안 열리던 문제를 같은 방식으로 푼다:
 *
 *  1. 좌우: 트리거 좌변(또는 우변) 정렬 후 뷰포트 안으로 클램프
 *  2. 상하: 기본은 트리거 아래. 아래가 모자라면 **가용 공간이 큰 쪽**으로 간다
 *     (한쪽에 다 안 들어가도 — 트리거를 덮느니 좁은 쪽을 스크롤시킨다)
 *  3. 그쪽 가용 공간에 맞춘 `maxHeight`(콘텐츠가 길면 팝오버 내부 스크롤)
 *  4. 측정 전(`null`)에는 호출자가 `visibility:hidden`으로 첫 프레임 깜빡임을 막는다
 *  5. scroll(캡처)·resize·팝오버 자체 크기 변화(ResizeObserver)에 재계산
 *
 * 계산은 순수 함수 [`computeAnchoredPosition`]에 있고 훅은 계측·구독만 한다
 * (단위 테스트가 DOM 없이 경계를 검증한다).
 */

/**
 * 포털 팝오버 레이어 표시. 포털은 DOM 조상 관계를 끊으므로 "바깥 클릭" 판정이
 * `contains`만으로는 **다른 팝오버 위 클릭까지 바깥으로 본다** — 오버플로 메뉴
 * 안에서 연 하위 팝오버(에이전트 옵션·실행 메뉴)를 누르는 순간 부모 메뉴가 닫혀
 * 하위 팝오버까지 언마운트되는 문제. 포털 레이어에 이 속성을 달아두고, 다층
 * 메뉴는 이 속성이 붙은 조상 안의 클릭을 바깥으로 세지 않는다.
 */
export const POPOVER_LAYER_ATTR = "data-popover-layer";

/** 클릭 대상이 어떤 포털 팝오버 레이어 안인가. */
export function isInPopoverLayer(node: EventTarget | null): boolean {
  const el =
    node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  return !!el?.closest(`[${POPOVER_LAYER_ATTR}]`);
}

export type AnchorBox = { left: number; right: number; top: number; bottom: number };
export type AnchoredPos = { left: number; top: number; maxHeight: number };

export type AnchorOpts = {
  /** 트리거와 팝오버 사이 간격(px). */
  gap?: number;
  /** 뷰포트 가장자리 여백(px). */
  margin?: number;
  /** 팝오버 높이 상한(px) — 잔여 공간이 더 좁으면 그쪽이 이긴다. */
  maxHeight?: number;
  /** 잔여 높이가 아무리 좁아도 이 값 아래로는 내리지 않는다(내부 스크롤). */
  minHeight?: number;
  /** 가로 정렬 기준: 트리거 좌변(start·기본) 또는 우변(end). */
  align?: "start" | "end";
};

const DEFAULTS = { gap: 4, margin: 4, maxHeight: 260, minHeight: 80 } as const;

/**
 * 앵커·팝오버·뷰포트 상자로부터 fixed 좌표를 계산한다(순수).
 *
 * `viewport`가 팝오버보다 좁거나 낮은 극단(1/4 표면·아주 작은 창)에서도 좌표는
 * 항상 `margin` 이상 — `Math.max`가 마지막에 오므로 클램프 하한이 이긴다.
 */
export function computeAnchoredPosition(
  anchor: AnchorBox,
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: AnchorOpts = {},
): AnchoredPos {
  const gap = opts.gap ?? DEFAULTS.gap;
  const margin = opts.margin ?? DEFAULTS.margin;
  const capHeight = opts.maxHeight ?? DEFAULTS.maxHeight;
  const minHeight = opts.minHeight ?? DEFAULTS.minHeight;
  const vw = viewport.width;
  const vh = viewport.height;
  const w = popup.width;
  const h = Math.min(popup.height, capHeight);

  // 가로: 정렬 기준을 잡고 뷰포트 안으로 클램프(좁은 창에서 음수 좌표 방지).
  const wanted = opts.align === "end" ? anchor.right - w : anchor.left;
  const left = Math.max(margin, Math.min(wanted, vw - w - margin));

  // 세로: 기본 아래. **가용 공간이 큰 쪽**을 고르고 그 공간으로 높이를 제한한다.
  // (전에는 "위에 전체 높이가 들어갈 때만" 뒤집어서, 양쪽 다 모자라면 아래로 두고
  //  vh-h-margin 으로 클램프 → 팝오버가 트리거를 덮었다. maxHeight 상한이 260에서
  //  420으로 올라간 팝오버 4종에서 발동 확률이 커진 실결함이다.)
  const below = anchor.bottom + gap;
  const spaceBelow = vh - margin - below;
  const spaceAbove = anchor.top - gap - margin;
  const openUp = spaceBelow < h && spaceAbove > spaceBelow;
  const space = openUp ? spaceAbove : spaceBelow;
  // 실제로 그려질 높이 — 가용 공간을 넘지 않는다(넘치면 내부 스크롤). 단 minHeight
  // 아래로는 줄이지 않는다(그 경우는 아래의 클램프가 화면 안으로 밀어 넣는다).
  const drawn = Math.max(minHeight, Math.min(h, space));
  const top = openUp
    ? Math.max(margin, anchor.top - gap - drawn)
    : Math.max(margin, Math.min(below, vh - drawn - margin));

  const maxHeight = Math.max(minHeight, Math.min(capHeight, space));
  return { left, top, maxHeight };
}

/**
 * 열려 있는 동안 앵커 기준 fixed 좌표를 유지한다. `null` = 아직 미계측
 * (호출자가 `visibility:hidden`으로 첫 프레임을 숨긴다).
 *
 * `fallbackWidth/Height`는 팝오버 ref가 아직 안 붙은 첫 패스의 추정치다.
 */
export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  opts: AnchorOpts & { fallbackWidth?: number; fallbackHeight?: number } = {},
): AnchoredPos | null {
  const [pos, setPos] = useState<AnchoredPos | null>(null);
  const {
    gap,
    margin,
    maxHeight,
    minHeight,
    align,
    fallbackWidth = 200,
    fallbackHeight = DEFAULTS.maxHeight,
  } = opts;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const compute = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const pop = popRef.current;
      const r = anchor.getBoundingClientRect();
      setPos(
        computeAnchoredPosition(
          { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          { width: pop?.offsetWidth ?? fallbackWidth, height: pop?.scrollHeight ?? fallbackHeight },
          { width: window.innerWidth, height: window.innerHeight },
          { gap, margin, maxHeight, minHeight, align },
        ),
      );
    };
    compute();
    // fixed 레이어라 스크롤/리사이즈로 트리거가 움직이면 다시 계산한다.
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    // 열린 채로 내용이 늘거나 줄어 팝오버 크기가 바뀌면 이전 크기 기준 좌표가
    // 어긋나므로 팝오버 자체 크기 변화도 관측한다.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(compute);
    if (ro && popRef.current) ro.observe(popRef.current);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
      ro?.disconnect();
    };
    // ref 객체는 안정적이라 의존성에서 뺀다(값 변화는 compute가 매번 읽는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gap, margin, maxHeight, minHeight, align, fallbackWidth, fallbackHeight]);

  return pos;
}
