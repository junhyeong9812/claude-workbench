/**
 * 사이드바 뷰 상태 — 상/하 2분할(sidebar-split)의 순수 규칙 + persist 파서.
 *
 * 이 모듈의 존재 이유는 **불변식 하나**다: 같은 탭이 두 반쪽에 동시에 마운트되지
 * 않는다(조사 §1.4의 2인스턴스 위험 17건 중 16건 — 중복 DOM id·포커스 튐·모듈
 * 메모 파손·폴링 배수·아카이브 설정 클로버 등 — 이 규칙 하나로 구조적으로 소멸).
 * 그래서 탭을 바꾸는 모든 경로(반쪽 헤더 seg·액티비티 바·분할 토글·persist 복원)
 * 를 여기 순수 함수로 모으고, 위반 상태는 만들지 않고 **정규화한다**(스왑/회피).
 *
 * React는 여기 들어오지 않는다 — 소비자(App)가 useState + persist 이펙트를 갖고,
 * 이 파일은 손계산 가능한 규칙만 갖는다.
 */

export const SIDEBAR_TABS = ["files", "git", "worktree", "archive", "graph"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];

/** 분할 ON일 때의 두 반쪽. (반쪽 개별 접기는 범위 밖 — 접기는 전체 단위.) */
export type SidebarHalf = "top" | "bottom";

export interface SidebarView {
  /** 상하 2분할 여부. */
  split: boolean;
  /** 분할 OFF일 때 보이는 탭. */
  tab: SidebarTab;
  /** 분할 ON — 위쪽 반쪽(액티비티 바가 제어하는 쪽). */
  topTab: SidebarTab;
  /** 분할 ON — 아래쪽 반쪽. */
  bottomTab: SidebarTab;
}

export const SIDEBAR_DEFAULT: SidebarView = {
  split: false,
  tab: "files",
  topTab: "files",
  bottomTab: "git",
};

const STORAGE_KEY = "sidebarView";

const isTab = (x: unknown): x is SidebarTab =>
  typeof x === "string" && (SIDEBAR_TABS as readonly string[]).includes(x);

/** 주어진 탭과 겹치지 않는 대체 탭 — 목록 순서상 첫 번째. */
function otherTab(taken: SidebarTab): SidebarTab {
  return SIDEBAR_TABS.find((t) => t !== taken) as SidebarTab;
}

/**
 * 불변식 강제: 두 반쪽이 같은 탭이면 아래쪽을 비켜세운다(위쪽 = 액티비티 바가
 * 가리키는 쪽이라 고정). split이 꺼져 있어도 정규화한다 — 꺼진 동안 저장된
 * 위반 상태가 나중에 켜질 때 되살아나면 안 되므로(persist 복원 포함 전 진입점).
 */
export function normalizeSidebarView(v: SidebarView): SidebarView {
  if (v.topTab !== v.bottomTab) return v;
  return { ...v, bottomTab: otherTab(v.topTab) };
}

/**
 * 반쪽 헤더 seg 선택 규칙 — 상대 반쪽이 이미 그 탭이면 **두 반쪽을 맞바꾼다**
 * (설계 §A-1). 그 외에는 그 반쪽만 교체. 같은 탭 재선택은 무동작(참조 유지).
 */
export function applyTabPick(raw: SidebarView, half: SidebarHalf, tab: SidebarTab): SidebarView {
  // 전(total) 함수 계약(리뷰): 입력이 위반 상태여도 먼저 정규화 — 조기 반환이
  // 위반을 그대로 흘려보내지 않는다(exhaustive raw 테스트가 이를 고정).
  const state = normalizeSidebarView(raw);
  const mine = half === "top" ? state.topTab : state.bottomTab;
  if (mine === tab) return state;
  const theirs = half === "top" ? state.bottomTab : state.topTab;
  if (theirs === tab) {
    // 스왑 — 상대가 내 탭을 가져간다(양쪽 모두 유지되면서 겹침 0).
    return { ...state, topTab: state.bottomTab, bottomTab: state.topTab };
  }
  const next =
    half === "top" ? { ...state, topTab: tab } : { ...state, bottomTab: tab };
  return normalizeSidebarView(next);
}

/**
 * 액티비티 바 선택 — 분할 OFF면 단일 탭, ON이면 **위쪽 반쪽**을 제어한다
 * (설계 §A-3). 분할 ON 동안 `tab`은 건드리지 않는다: 분할을 끌 때 위쪽 탭을
 * 물려받으므로(toggleSplit) 중간 상태를 남길 필요가 없다.
 */
export function applyActivityPick(raw: SidebarView, tab: SidebarTab): SidebarView {
  const state = normalizeSidebarView(raw); // total 계약 — applyTabPick과 동일
  if (state.split) return applyTabPick(state, "top", tab);
  if (state.tab === tab) return state;
  return { ...state, tab };
}

/**
 * ⊟ 분할 토글. 보고 있던 화면이 튀지 않게 탭을 이어붙인다: 켤 때는 단일 탭이
 * 위쪽으로, 끌 때는 위쪽 탭이 단일 탭으로. 켜는 쪽 이어붙임이 아래쪽과 겹치면
 * 정규화가 아래쪽을 비켜세운다.
 */
export function toggleSplit(state: SidebarView): SidebarView {
  if (state.split) return { ...state, split: false, tab: state.topTab };
  return normalizeSidebarView({ ...state, split: true, topTab: state.tab });
}

/** 지금 실제로 마운트되는 탭들(위→아래). 불변식 검사·포커스 판정에 쓴다. */
export function mountedTabs(state: SidebarView): SidebarTab[] {
  return state.split ? [state.topTab, state.bottomTab] : [state.tab];
}

/** studyView 선례 동형의 검증 파서 — 잘못된 값은 필드별 기본값 + 불변식 정규화. */
export function loadSidebarView(): SidebarView {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return SIDEBAR_DEFAULT;
    const r = v as Record<string, unknown>;
    const tab = (x: unknown, dflt: SidebarTab): SidebarTab => (isTab(x) ? x : dflt);
    return normalizeSidebarView({
      split: r.split === true,
      tab: tab(r.tab, SIDEBAR_DEFAULT.tab),
      topTab: tab(r.topTab, SIDEBAR_DEFAULT.topTab),
      bottomTab: tab(r.bottomTab, SIDEBAR_DEFAULT.bottomTab),
    });
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/** localStorage에 저장(재시작 생존). 비율은 autoSaveId="sidebar-vert"가 담당. */
export function saveSidebarView(v: SidebarView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* 저장 실패(용량·프라이빗 모드)는 무시 — 뷰 상태는 세션 내에서 계속 동작 */
  }
}

/**
 * Ctrl+B 판정 — **탭과 무관하게 항상 접기/펴기 토글**(설계 §A-6, 조사 결함 ①:
 * 지금은 트리가 없는 탭에서 아무 일도 일어나지 않는다).
 * - 접혀 있으면 펼치고, 트리가 마운트돼 있으면 그리로 포커스(없으면 이동 생략).
 * - 펼쳐져 있으면 접는다. 포커스가 사이드바 안이었다면 접힌 패널에 포커스가
 *   갇히지 않게 마지막 작업 지점으로 되돌린다.
 */
export type CtrlBAction =
  | { kind: "expand" }
  | { kind: "focusTree" }
  | { kind: "collapse"; restoreFocus: boolean };

/** 하이브리드 규칙(리뷰 — 구 "트리 진입"과 신 "탭 무관 상시 동작" 둘 다 보존):
 * 접힘 → 펼침(+트리 있으면 포커스) / 펼침·포커스가 사이드바 밖·트리 마운트
 * → 트리 포커스 / 그 외(트리 없음 또는 이미 사이드바 안) → 접기. */
export function ctrlBAction(
  collapsed: boolean,
  focusInSidebar: boolean,
  treeMounted: boolean,
): CtrlBAction {
  if (collapsed) return { kind: "expand" };
  if (!focusInSidebar && treeMounted) return { kind: "focusTree" };
  return { kind: "collapse", restoreFocus: focusInSidebar };
}
