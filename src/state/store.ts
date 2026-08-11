import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ITheme } from "@xterm/xterm";
import type { DirEntry, Project, ProjectType, SshConnection, WorkspaceState } from "../types";
import { capTreeCache, computeTreeKeepSet, pruneTreeCache, sameEntries, underRoot } from "./treeSelectors";
import { setActiveSurfaceSeam, type SurfaceId } from "./surfaceContext";
import {
  addSurface,
  removeSurface,
  resolveSurfaceTree,
  secondaryProject,
  type SurfacePlacement,
  type SurfaceTree,
} from "./surfaceTree";
import { resolveVisibleDual } from "./dualSurface";
import { resolveLayerMode } from "./layerRouting";
import { basename } from "../utils/path";

/** Clamp a font size to the allowed range (also normalizes NaN). */
export const clampFontSize = (n: number): number => Math.max(9, Math.min(28, Math.round(n) || 13));

/**
 * 표면별 요청 슬롯 (멀티프로젝트 P5 F1 — **동시발행 격리**). 각 표면(primary·
 * secondary)이 **자기 슬롯만** read/clear 한다 — 두 표면이 소비 전에 같은 채널을
 * 발행해도 서로의 요청을 덮어쓰지 않는다(무음 유실 0). 발행부는 origin surfaceId
 * 슬롯에 기록하고, 소비부(MainArea)는 `slot[mySurfaceId]`만 읽는다. targetSurfaceId
 * 필드는 **슬롯 키가 대체**했다(라우팅 = 컴파일-고정 표면 키).
 */
export type SurfaceSlots<T> = { primary: T | null; secondary: T | null };
/** 표면별 카운터 슬롯(picker·memo — object 슬롯과 달리 null이 아니라 nonce 증분으로
 * 재발화). 각 표면이 자기 nonce를 들고 자기 dedup ref로 소비한다. */
export type SurfaceCounters = { primary: { nonce: number }; secondary: { nonce: number } };

/** 빈 표면 슬롯(초기값·teardown clear). */
const noSlots = <T>(): SurfaceSlots<T> => ({ primary: null, secondary: null });
/** origin 표면 슬롯에 값을 쓴다(상대 표면 슬롯 무영향 — 명시 분기로 union 키 타입 회피). */
function putSlot<T>(slots: SurfaceSlots<T>, surfaceId: SurfaceId, value: T | null): SurfaceSlots<T> {
  return surfaceId === "secondary"
    ? { primary: slots.primary, secondary: value }
    : { primary: value, secondary: slots.secondary };
}
/** origin 표면 카운터의 nonce를 증분한다(상대 표면 무영향). */
function bumpCounter(slots: SurfaceCounters, surfaceId: SurfaceId): SurfaceCounters {
  return surfaceId === "secondary"
    ? { primary: slots.primary, secondary: { nonce: slots.secondary.nonce + 1 } }
    : { primary: { nonce: slots.primary.nonce + 1 }, secondary: slots.secondary };
}
/** 부 표면 object 슬롯을 전부 비운다(teardown clear — P5 F1). 카운터는 새 마운트
 * ref가 nonce를 캡처하므로 제외. AppState 부분집합을 돌려 set에 스프레드한다. */
function clearSecondarySlots(s: {
  editorOpenRequest: SurfaceSlots<{ path: string }>;
  diffRequest: SurfaceSlots<DiffSpec>;
  claudeOpenRequest: SurfaceSlots<{ project: string; seed?: string; title?: string; referencePanelId?: string; model?: string; effort?: string }>;
  codexOpenRequest: SurfaceSlots<{ project: string; model?: string; effort?: string }>;
  runRequest: SurfaceSlots<{ project: string; cmd: string; title: string }>;
  terminalOpenRequest: SurfaceSlots<{ cwd: string; title: string; nonce: number }>;
  sessionResumeRequest: SurfaceSlots<{ uuid: string; project: string; title: string; nonce: number }>;
}) {
  return {
    editorOpenRequest: { ...s.editorOpenRequest, secondary: null },
    diffRequest: { ...s.diffRequest, secondary: null },
    claudeOpenRequest: { ...s.claudeOpenRequest, secondary: null },
    codexOpenRequest: { ...s.codexOpenRequest, secondary: null },
    runRequest: { ...s.runRequest, secondary: null },
    terminalOpenRequest: { ...s.terminalOpenRequest, secondary: null },
    sessionResumeRequest: { ...s.sessionResumeRequest, secondary: null },
  };
}

/** Persisted study slice (folders + tabs + active + per-side mode). */
interface StudyPersist {
  folders: { left: string | null; right: string | null };
  tabs: { left: string[]; right: string[] };
  active: { left: string | null; right: string | null };
  mode: { left: "viewer" | "editor"; right: "viewer" | "editor" };
}

const STUDY_DEFAULT: StudyPersist = {
  folders: { left: null, right: null },
  tabs: { left: [], right: [] },
  active: { left: null, right: null },
  mode: { left: "viewer", right: "viewer" },
};

/** Safe-parse + validate the persisted study view slice (P4). Validates nested
 * fields so corrupt/old JSON can't break consumers (codex SF-4). */
function loadStudyView(): StudyPersist {
  try {
    const v = JSON.parse(localStorage.getItem("studyView") || "null");
    if (!v || typeof v !== "object") return STUDY_DEFAULT;
    const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
    const strArr = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : [];
    const md = (x: unknown): "viewer" | "editor" => (x === "editor" ? "editor" : "viewer");
    const F = (v.folders ?? {}) as Record<string, unknown>;
    const T = (v.tabs ?? {}) as Record<string, unknown>;
    const A = (v.active ?? {}) as Record<string, unknown>;
    const M = (v.mode ?? {}) as Record<string, unknown>;
    return {
      folders: { left: str(F.left), right: str(F.right) },
      tabs: { left: strArr(T.left), right: strArr(T.right) },
      active: { left: str(A.left), right: str(A.right) },
      mode: { left: md(M.left), right: md(M.right) },
    };
  } catch {
    return STUDY_DEFAULT;
  }
}

/** Persist the study view slice to localStorage (survives restart). */
function saveStudyView(s: {
  studyFolders: StudyPersist["folders"];
  studyTabs: StudyPersist["tabs"];
  studyActive: StudyPersist["active"];
  studyMode: StudyPersist["mode"];
}) {
  const slice: StudyPersist = {
    folders: s.studyFolders,
    tabs: s.studyTabs,
    active: s.studyActive,
    mode: s.studyMode,
  };
  localStorage.setItem("studyView", JSON.stringify(slice));
}

const STUDY0 = loadStudyView();

/** Safe-parse a persisted `Record<string, string>` map (project → value),
 * dropping non-string entries so corrupt/old JSON can't break consumers. */
function loadStringMap(key: string): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** Per-project workspace flavor. "dev" opens tree files as editor tabs with the
 * project's dev Claude session pinned beside them (the ✓확인 loop's layout);
 * "integrated" keeps the plain workspace behavior. */
function loadProjectModes(): Record<string, "integrated" | "dev"> {
  const raw = loadStringMap("projectModes");
  const out: Record<string, "integrated" | "dev"> = {};
  for (const [k, v] of Object.entries(raw)) if (v === "dev") out[k] = "dev";
  return out; // "integrated" is the default — only "dev" entries persist
}

const TERM_COLOR_KEYS = new Set([
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
]);
const isHex = (v: unknown): v is string =>
  typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

/** Safe-parse + validate the persisted terminal color overrides — drop unknown
 * keys / non-hex values, and reject non-objects (codex CF-3). */
function loadTermColors(): Partial<ITheme> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem("termColors") || "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (TERM_COLOR_KEYS.has(k) && isHex(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as Partial<ITheme>) : null;
}

/** Persisted popout window geometry (logical px) so a reopened popout lands where
 * it was (multiwindow P2). */
export interface PopoutGeo {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Safe-parse the persisted popout layouts (`label -> projectPath -> dockview
 * JSON`). Layouts are opaque blobs — validate only the nesting shape so a
 * corrupt/old entry can't break startup (multiwindow P2). */
function loadPopoutLayouts(): Record<string, Record<string, unknown>> {
  try {
    const v = JSON.parse(localStorage.getItem("popoutLayouts") || "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [label, byProj] of Object.entries(v as Record<string, unknown>)) {
      if (byProj && typeof byProj === "object" && !Array.isArray(byProj)) {
        out[label] = byProj as Record<string, unknown>;
      }
    }
    return out;
  } catch {
    return {};
  }
}
function savePopoutLayouts(m: Record<string, Record<string, unknown>>) {
  try {
    localStorage.setItem("popoutLayouts", JSON.stringify(m));
  } catch {
    /* quota / serialization — best-effort */
  }
}

/** Safe-parse the persisted popout geometry, dropping non-finite / non-positive
 * entries (multiwindow P2). */
function loadPopoutGeometry(): Record<string, PopoutGeo> {
  try {
    const v = JSON.parse(localStorage.getItem("popoutGeometry") || "null");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const num = (x: unknown): number | null =>
      typeof x === "number" && Number.isFinite(x) ? x : null;
    const out: Record<string, PopoutGeo> = {};
    for (const [label, g] of Object.entries(v as Record<string, unknown>)) {
      const o = (g ?? {}) as Record<string, unknown>;
      const x = num(o.x);
      const y = num(o.y);
      const w = num(o.width);
      const h = num(o.height);
      if (x != null && y != null && w != null && h != null && w > 0 && h > 0) {
        out[label] = { x, y, width: w, height: h };
      }
    }
    return out;
  } catch {
    return {};
  }
}
function savePopoutGeometry(m: Record<string, PopoutGeo>) {
  try {
    localStorage.setItem("popoutGeometry", JSON.stringify(m));
  } catch {
    /* quota — best-effort */
  }
}

// Each window has its OWN Zustand store, but localStorage is shared. Writing the
// whole in-memory map would let one popout clobber another popout's entry
// (last-writer-wins — codex P2). So persistence is label-granular: re-read the
// shared store, merge/delete just THIS label, write back (multiwindow P2).
function persistPopoutLayout(label: string, byProject: Record<string, unknown>) {
  const fresh = loadPopoutLayouts();
  fresh[label] = byProject;
  savePopoutLayouts(fresh);
}
function persistRemovePopout(label: string) {
  const fresh = loadPopoutLayouts();
  if (label in fresh) {
    delete fresh[label];
    savePopoutLayouts(fresh);
  }
  const freshGeo = loadPopoutGeometry();
  if (label in freshGeo) {
    delete freshGeo[label];
    savePopoutGeometry(freshGeo);
  }
}
function persistPopoutGeometry(label: string, geo: PopoutGeo) {
  const fresh = loadPopoutGeometry();
  fresh[label] = geo;
  savePopoutGeometry(fresh);
}

const SURFACE_TREE_KEY = "surfaceTree";
const LEGACY_DUAL_KEY = "dualProject";

/**
 * Load the surface tree from localStorage (멀티프로젝트 P6 — 트리 디스크 정본화).
 *
 * P6부터 트리는 **방향/위치**를 담으므로 `surfaceTree` 블롭이 디스크 정본이다.
 * 레거시 `dualProject` 문자열은 **다운그레이드용 파생 미러**(구버전 앱이 읽는 유일
 * 키)로 병행 기록된다. parseSurfaceTree가 이미: 트리 present·유효→채택(방향 보존)·
 * present-but-corrupt→기본·부재→legacy 마이그레이션(구버전에서 올라온 경우)으로
 * 견고화돼 있다.
 *
 * **다운그레이드 화해(P6)**: 구버전 앱은 `dualProject`만 만질 수 있고 `surfaceTree`
 * 는 손 못 댄다(무시). 그래서 두 키가 어긋나면(구버전이 분할을 닫았거나 다른
 * 프로젝트로 바꿈) **legacy가 멤버십 정본, 트리가 방향 정본**이 되도록 단방향
 * 화해한다 — "닫힌 분할 부활"(stale 트리가 legacy null을 이김)을 원천 차단.
 * 신버전이 두 키를 동기 기록하는 정상 경로에선 항상 일치라 화해는 no-op. 화해
 * 로직 정본 = surfaceTree.resolveSurfaceTree(순수·테스트 대상). */
export function loadSurfaceTree(): SurfaceTree {
  const stored = localStorage.getItem(SURFACE_TREE_KEY);
  const legacy = localStorage.getItem(LEGACY_DUAL_KEY);
  // 진짜 부재(키 없음) → 레거시 마이그레이션 경로(pre-P6 세션 정상 승격).
  if (stored === null) return resolveSurfaceTree(null, legacy);
  let rawTree: unknown;
  try {
    rawTree = JSON.parse(stored);
  } catch {
    // 손상 블롭(문법 깨짐)은 **부재가 아니다**(F2 — codex P1-2): stale legacy를
    // 신뢰해 닫힌 분할을 부활시키지 않도록 손상 플래그로 보수적 기본을 알린다.
    return resolveSurfaceTree(null, legacy, true);
  }
  return resolveSurfaceTree(rawTree, legacy);
}

/**
 * Persist the surface tree to disk (멀티프로젝트 P6). **이중 기록**이지만 P3'에서
 * 위험했던 비원자 분기와 다르다: 트리(`surfaceTree`)가 **방향까지 담는 유일 정본**
 * 이고, 레거시 문자열(`dualProject`)은 그 secondary의 **단방향 파생 미러**(다운그레이드
 * 전용)다. 한 함수·연속 setItem으로 항상 함께 기록/삭제하므로 신버전 세션에선 두 키가
 * 절대 어긋나지 않고, 어긋남은 오직 구버전 세션이 낀 뒤에만 생겨 loadSurfaceTree의
 * 화해가 흡수한다(legacy=멤버십·트리=방향). secondary 없으면 두 키 모두 제거. */
function persistSurfaceTree(tree: SurfaceTree) {
  const secondary = secondaryProject(tree);
  if (secondary) {
    // 정본(방향 포함) + provenance 마커 `legacyMirror`(= 이 쓰기 시점의 legacy 값).
    // 로드 시 legacyMirror ≠ 현재 legacy면 그 사이 구버전이 legacy를 바꾼 것
    // (진짜 다운그레이드)임을 판별해 stale legacy가 valid 트리를 이기지 못하게 한다
    // (F1 — codex P1-1). 마커는 항상 secondary와 일치(불변식).
    localStorage.setItem(SURFACE_TREE_KEY, JSON.stringify({ ...tree, legacyMirror: secondary }));
    localStorage.setItem(LEGACY_DUAL_KEY, secondary); // 다운그레이드 파생 미러
  } else {
    localStorage.removeItem(SURFACE_TREE_KEY);
    localStorage.removeItem(LEGACY_DUAL_KEY);
  }
}

/** 우측(secondary) 표면이 실제로 렌더되는가 — **활성 표면 정규화의 단일 술어**
 * (G4 + codex 최종확인 H1). 두 축을 AND한다:
 *   ① **멤버십·겹침·닫힘**: `resolveVisibleDual`과 동일 판정(우측 프로젝트가 열린
 *      탭이고 좌측과 다른가).
 *   ② **dual 레이어 가시**: 주 프로젝트가 dev 모드면 DevView 오버레이가 dual-row
 *      **전체**를 가린다(App: layerMode=activeProject 구동 → main-layer-back). 이땐
 *      어떤 표면도 실제로 안 보이므로 secondary도 false.
 * 이로써 dev 축이 술어에 통합되어, 단일 진입점 reconcileActiveSurface가 dev **진입**
 * (setProjectMode)뿐 아니라 **이미 dev인 프로젝트로 primary가 바뀌는**
 * (applyRemoteActive·closeProject 재인덱스) 경로까지 균일하게 정규화한다 — 숨은
 * dock으로의 무음 유실 갭이 자동으로 닫힌다. */
function secondaryIsVisible(s: {
  surfaceTree: SurfaceTree;
  activeProject: string | null;
  projects: Project[];
  projectModes: Record<string, "integrated" | "dev">;
}): boolean {
  if (resolveLayerMode(s.projectModes, s.activeProject) === "dev") return false;
  return (
    resolveVisibleDual(
      secondaryProject(s.surfaceTree),
      s.activeProject,
      s.projects.map((p) => p.path),
    ) !== null
  );
}

/** A request to open a diff in the main area (file change or a commit). */
export interface DiffSpec {
  title: string;
  cwd: string;
  /** File diff: the path (+ `staged`). */
  path?: string;
  staged?: boolean;
  /** Commit diff: the commit hash. */
  hash?: string;
}

/**
 * Global shell state.
 *
 * Invariants:
 *  - `projects` is the set of open tabs; `activeProject` is the path of the
 *    active one (or null).
 *  - Tree expansion is stored *per project* (`project.tree_state.expanded`) so
 *    manipulating one project's tree never affects another's.
 *  - `childrenCache` is keyed by absolute directory path. It is pure filesystem
 *    data (project-independent) and is NOT persisted.
 */
interface AppState {
  projects: Project[];
  activeProject: string | null;
  /**
   * 활성 표면(멀티프로젝트 P4', 범위 축소본) — 마지막으로 클릭/상호작용(dock)한
   * 표면. **표시/추적 전용**: 사이드바·헤더·검색 내용이 이 표면의 프로젝트
   * (`activeSurfaceProject`, App 파생)를 반영하고 시각 지시자(테두리)가 이 표면을
   * 강조한다. 우측 표면이 뚜렷이 안 보이면 "primary"로 정규화(표시 정합). **요청버스
   * 목적지 라우팅에는 쓰지 않는다** — 라우팅은 P5 F1에서 **표면별 슬롯**으로 바뀌어
   * 발행부가 자기 origin surfaceId 슬롯에 기록한다(활성-추종 아님 — 컴파일-고정).
   * `activeProject`는 primary/left 앵커(persist·sync·dev·resolveVisibleDual). */
  activeSurfaceId: SurfaceId;
  /** dirPath -> its immediate children (transient cache). */
  childrenCache: Record<string, DirEntry[]>;
  /** dirPath -> in-flight read_dir guard. */
  loadingDirs: Record<string, boolean>;
  /** Keyboard cursor in the folder tree (focused node path), or null. Transient. */
  treeCursor: string | null;
  /** File currently shown in the peek viewer overlay, or null (closed). Transient. */
  peekFile: string | null;
  /** Optional 1-based line to scroll to in the peek viewer (content-search jump). */
  peekLine: number | null;
  /** Git history viewer state: a commit selected in the Git panel, shown as a
   * SECOND sidebar listing that commit's changed files (next to the main sidebar),
   * or null (closed). Transient. */
  gitHistory: { root: string; commit: string } | null;
  /** A file opened from the commit-files sidebar, shown as a peek-style view over
   * the main area (file content at the commit + diff toggle), or null. Transient. */
  gitHistoryFile: { root: string; commit: string; path: string } | null;
  /**
   * ── 요청버스 표면 라우팅 (멀티프로젝트 P5 F1 — 표면별 슬롯) ─────────────
   * 아래 라우팅 채널들은 `SurfaceSlots<T>`(`{primary, secondary}`)다. 발행부는
   * **origin surfaceId 슬롯에만** 기록하고(기본 primary — 앱-전역·상단 툴바),
   * 소비자(MainArea)는 자기 `useSurfaceId()` 슬롯(`slot[mySurfaceId]`)만 읽고
   * 자기 슬롯만 clear 한다. **두 표면이 소비 전에 같은 채널을 동시 발행해도
   * 서로를 덮어쓰지 않는다**(무음 유실 0 — 예전 단일 슬롯의 last-write 삼킴 해소,
   * codex P1). 표면 키가 라우팅이라 별도 targetSurfaceId 필드는 없다(컴파일-고정).
   *
   * 표면 단위가 아니라 **세션 단위**인 요청(`claudeInjectRequest`/`Acks`·
   * `devReviewQueue`·`focusSessionRequest` — uuid/프로젝트로 짝지어 어느 표면이든
   * 그 세션을 찾아가는 것)은 이 라우팅 대상이 **아니다**. focusMain·termMenu·
   * detach는 **주 표면 고정 단일 슬롯**(SSH/전송 envelope 전역 — 부 표면 미발행).
   * ──────────────────────────────────────────────────────────────────── */
  /** A request to open a file in the editor (consumed by MainArea, which owns the
   * dockview api). 표면별 슬롯(P5 F1) — `slot[mySurfaceId]`만 소비. */
  editorOpenRequest: SurfaceSlots<{ path: string }>;
  /** A request to open a diff panel (consumed by MainArea), or null. Transient. */
  diffRequest: SurfaceSlots<DiffSpec>;
  /** A request to open a new Claude session bound to `project` (consumed by
   * MainArea, which owns the dockview api), or null. Transient — used by the
   * worktree panel's one-click "Claude 열기" and review mode (`seed`/`title`:
   * a fresh review session pre-seeded with "이 커밋 리뷰하자"). */
  claudeOpenRequest: SurfaceSlots<{
    project: string;
    seed?: string;
    title?: string;
    /** Open this panel to the right of an existing panel (review: beside the diff). */
    referencePanelId?: string;
    /** Spawn options (`--model` / `--effort`). Omitted = no flag, exactly as
     * before options existed. Set by the toolbar's options popover and by the
     * surfaces that inherit the last-used options (worktree, review). */
    model?: string;
    effort?: string;
  }>;
  /**
   * A request to open a new **codex** session bound to `project` (consumed by
   * MainArea), or null.
   *
   * `claudeOpenRequest`와 합치지 않은 것이 의도다. 저쪽은 seed·referencePanelId·
   * adopt 같은 claude 전용 개념을 들고 있고 소비부도 그만큼 크다 — codex를 그
   * 분기 안에 끼워 넣으면 claude 경로에 손이 가고(회귀 0이 이 작업의 불변식),
   * codex가 절대 쓰지 않을 필드를 계속 지나치게 된다. 두 요청은 각자 작고
   * 각자 완결이다.
   */
  codexOpenRequest: SurfaceSlots<{ project: string; model?: string; effort?: string }>;
  /** Inject a prompt into an already-live Claude session (dev mode's 확인 button
   * re-uses the project's dev session). Matched by session uuid in ClaudeTermPanel.
   *
   * `mode` decides the bytes written to the PTY, and it is the whole safety
   * boundary of the prompt-refine [적용] path:
   * - `"submit"` (default, 기존 동작 그대로) — 텍스트 + LF.
   * - `"fill"` — bracketed paste로 **입력창에 채우기만**. CR을 절대 만들지 않는다
   *   (`promptRefine.bracketedPaste`). 정리 세션의 최종본이 이 길로만 간다. */
  claudeInjectRequest: {
    /** 이 요청의 고유 id — 배달 결과를 짝지어 확인하는 유일한 키. */
    id: string;
    uuid: string;
    text: string;
    mode?: "submit" | "fill";
  } | null;
  /**
   * 최근 주입의 **배달 결과들** — 요청 id로 짝짓는다(최신이 뒤).
   *
   * 슬롯이 비는 것을 성공 신호로 삼던 추론을 대체한다(감사 G1). 그 추론은 두 군데
   * 서 틀렸다: `claude_write`는 이 창이 driver가 아니면 아무것도 쓰지 않고도
   * 성공을 반환했고(백엔드가 이제 사실을 돌려준다), 슬롯을 비운 주체가 우리
   * 요청의 소비자였다는 보장도 없었다. 소비 패널이 실제 쓰기 결과를 여기 남기고,
   * 요청을 낸 쪽은 **자기 id의 결과만** 신뢰한다.
   *
   * 단일 슬롯이 아니라 **목록**인 이유(감사 H1): 결과를 확인하기 전에 다른 주입
   * (dev 시드 등)이 끝나면 단일 슬롯은 덮여 버리고, 기다리던 쪽은 아무 소식 없이
   * 타임아웃까지 간다. 상한을 둔 목록이면 서로의 결과를 지우지 않는다.
   */
  claudeInjectAcks: readonly { id: string; ok: boolean; reason?: string }[];
  /** Dev mode 확인/🧪: review (or generate a test for) the just-saved file. The
   * project's own DevView consumes it — injecting into its live dev Claude
   * session, or seeding a fresh one. No panel-positioning field: the dev session
   * lives in DevView's own dock, not beside an editor panel.
   *
   * A FIFO QUEUE (not a single slot) with a stable id per entry: rapid ✓확인
   * clicks (or clicks across projects) must not clobber each other, and delivery
   * consumes by id so a re-run (or the onReady/effect double path) can't
   * double-deliver or drop an entry (③). Each DevView consumes only its own
   * project's entries, in order; other projects' entries never block it. */
  devReviewQueue: Array<{ id: string; project: string; prompt: string }>;
  /** Build/test runner: open a terminal panel that runs `cmd` (consumed by MainArea). */
  runRequest: SurfaceSlots<{ project: string; cmd: string; title: string }>;
  /** 트리 폴더 우클릭 "여기서 터미널 열기" → 그 폴더 cwd의 일반 터미널 탭.
   *
   * 소비자는 **화면 앞에 있는 dock 하나**다 — 통합=MainArea(주 surface)·개발=
   * DevView·스터디=StudySession. 세 표면은 서로 배타적으로 마운트/전면이라
   * (스터디 모드는 MainArea 자체가 언마운트, 개발/통합은 레이어 게이트) 요청
   * 하나가 두 dock에 열리지 않는다. `nonce`는 같은 폴더를 연달아 열어도 효과가
   * 다시 발화하게 한다. */
  terminalOpenRequest: SurfaceSlots<{ cwd: string; title: string; nonce: number }>;
  /** Bumped to ask MainArea to focus the active dockview panel (Ctrl+B from the
   * already-focused tree toggles focus back to the open tab). `nonce` counter so
   * every press re-fires even when the value would otherwise be unchanged.
   * `targetSurfaceId`로 라우팅(P2 — 활성 표면의 MainArea만 소비). */
  focusMainRequest: { targetSurfaceId: SurfaceId; nonce: number };
  /** Request MainArea activate the Claude panel for a session uuid (the toolbar
   * attention roll-up's cycle-click). `nonce` re-fires the effect even when the
   * same uuid is requested twice in a row. Transient. No-op if that session has
   * no panel in this window's dock (another window's session). */
  focusSessionRequest: { uuid: string; nonce: number } | null;
  /** App-toolbar "+ Terminal" click → MainArea toggles its terminal menu (the
   * menu/dialog UI stays in MainArea, which owns the dockview api). `nonce`
   * counter so every press re-fires. `targetSurfaceId`로 라우팅(P2). Transient. */
  termMenuRequest: { targetSurfaceId: SurfaceId; nonce: number };
  /** App-toolbar "+ Claude" click → MainArea opens its session picker. `nonce`
   * counter. `targetSurfaceId`로 라우팅(P2). */
  claudePickerRequest: SurfaceCounters;
  /** App-toolbar "⤢ 분리" click → MainArea pops the active panel out to a new
   * window. `nonce` counter. `targetSurfaceId`로 라우팅(P2). Consumed only while
   * the integrated layer is front. */
  detachPanelRequest: { targetSurfaceId: SurfaceId; nonce: number };
  /** App-toolbar "메모" click (and the session picker's memo row) → MainArea
   * opens this project's memo panel. `nonce` counter. `targetSurfaceId`로
   * 라우팅(P2). Consumed only while the integrated layer is front. */
  memoRequest: SurfaceCounters;
  /** 아카이브 "이어서" — resume a saved session in the main dock, pinned to its
   * own `project` (no activeProject switch; MainArea consumes without a project
   * gate and clears with null). Already-open session → activate that panel. */
  sessionResumeRequest: SurfaceSlots<{ uuid: string; project: string; title: string; nonce: number }>;
  /** 우측 분할 surface에 열린 프로젝트 경로 (null=닫힘). 수동적 dock —
   * 전역 요청 버스는 주(좌) surface만 소비한다. surfaceTree의 secondary 파생
   * 미러(소비처 호환). 닫힌 프로젝트 정리는 store(closeProject·init)가 정본. */
  dualProject: string | null;
  /** 표면 트리(멀티프로젝트 P3') — 우측 표면 멤버십의 **정본**. dualProject는
   * 이 트리의 secondary 파생 미러다(소비처 호환). P3'은 primary + secondary
   * 0~1개까지만 실사용하되 스키마는 N-way·상하 분할을 대비한다. persist = P3'
   * 트리는 legacy 문자열과 동형이라 **디스크는 legacy `dualProject` 단일 키만**
   * 기록한다(FB — 분기 원천 제거·다운그레이드 자명). 트리는 메모리 정본. */
  surfaceTree: SurfaceTree;
  /** 부 표면 분할 열기(path)/닫기(null) — 트리 addSurface/removeSurface로 매핑되고
   * dualProject 미러를 갱신한 뒤 트리(정본)+legacy 미러를 함께 저장. `placement`
   * (P6)로 방향/위치를 정한다 — 생략 시 기본 우측(row·after, 우클릭 경로 보존). */
  setDualProject: (path: string | null, placement?: SurfacePlacement) => void;
  /** Color theme (persisted to localStorage). Drives CSS vars + xterm palette. */
  theme: "dark" | "light";
  /** Code font size in px (terminals + editor/viewer), persisted. */
  fontSize: number;
  /** Workspace view mode: normal workspace or the two-folder study view. Persisted. */
  mode: "workspace" | "study";
  /** Per-project workspace flavor (개발↔통합 토글). "dev": opening a tree file
   * shows the editable editor tab with the project's dev Claude session pinned
   * beside it (확인 loop layout). Absent key = "integrated". Persisted. */
  projectModes: Record<string, "integrated" | "dev">;
  /** Per-project dev Claude session uuid — stable across restarts so the dev
   * session resumes. The backend already degrades a stale uuid gracefully
   * (missing transcript → fresh `--session-id` under the same uuid). Persisted. */
  devUuids: Record<string, string>;
  /** Study view: root folder per side (persisted). */
  studyFolders: { left: string | null; right: string | null };
  /** 스터디 트리별 확장 dir 목록(키 = 트리 인스턴스 id ?? root). P5 F-g:
   * 컴포넌트 로컬 Set이던 것을 승격 — 캐시 상한 keep-set·구독 분리의 전제.
   * 비영속(ephemeral — savePersisted에 넣지 않는다, 기존 수명 계약 유지). */
  studyExpanded: Record<string, string[]>;
  /** Study view: open file tabs per side, MRU order (most recent first). */
  studyTabs: { left: string[]; right: string[] };
  /** Study view: active tab path per side. */
  studyActive: { left: string | null; right: string | null };
  /** Study view: dockview layout of the single pinned Claude study session
   * (in-memory — keeps the session attached across mode switches within a run). */
  studySessionLayout: unknown | null;
  /** Study view: stable Claude session UUID (persisted). The study session is
   * always created/resumed under this id so it survives restart even before any
   * chat (claude writes the JSONL only on interaction). */
  studySessionUuid: string | null;
  /** Study view: per-side open behavior. "viewer" = tree cursor follows and
   * replaces a single preview (read); "editor" = files accumulate as tabs. */
  studyMode: { left: "viewer" | "editor"; right: "viewer" | "editor" };
  /** Custom terminal color overrides (merged over the theme base), or null to
   * follow the theme. Persisted. */
  termColors: Partial<ITheme> | null;
  /** Saved SSH connections (app-global, non-secret). Secrets live in the OS
   * keychain. Persisted as part of WorkspaceState. */
  savedConnections: SshConnection[];
  /** Session-archive root override (null = default app-data dir). Part of
   * WorkspaceState — MUST ride through persist() or it gets wiped. */
  archiveRoot: string | null;
  /** Archive-extraction claude model / effort (null = 기본 opus / xhigh). Part
   * of WorkspaceState — MUST ride through persist() or they get wiped. */
  archiveModel: string | null;
  archiveEffort: string | null;
  /** Set archive root/model/effort together in ONE save (two racing saves could
   * land out of order and roll fields back — 리뷰 G5). Resolves `true` only
   * when the backend save actually succeeded (리뷰 G6 — 실패 무음 금지). */
  setArchiveConfig: (
    root: string | null,
    model: string | null,
    effort: string | null,
  ) => Promise<boolean>;
  /** Opt-in: persist terminal/SSH scrollback to disk so tabs restore their prior
   * output after a restart. Default OFF — output can contain secrets (review
   * F11). Persisted to localStorage. */
  persistScrollback: boolean;

  /** Load persisted state from the backend on startup. */
  init: () => Promise<void>;
  /** Toggle scrollback disk persistence. */
  setPersistScrollback: (on: boolean) => void;
  /** Add or replace (by id) a saved SSH connection and persist. */
  upsertConnection: (conn: SshConnection) => void;
  /** Delete a saved SSH connection: remove its keychain secret first, then the
   * metadata. Returns false (keeping the connection) if the keychain delete
   * fails, so the secret can't be silently orphaned. */
  deleteConnection: (id: string) => Promise<boolean>;
  /** Open a folder as a new project tab (or focus it if already open). */
  addProject: (path: string) => Promise<void>;
  /** Close a project tab. */
  closeProject: (path: string) => void;
  /** Move `fromPath`'s tab to just before/after `toPath` and persist. */
  reorderProject: (
    fromPath: string,
    toPath: string,
    insertAfter: boolean,
  ) => void;
  /** Make a project active (swaps the visible tree) + broadcast to other
   * windows so every window shares the same project (multiwindow). */
  setActive: (path: string) => void;
  /** 활성 표면 전환(P4' 포커스 모델) — 표면 클릭/상호작용 시 호출. 우측 표면이
   * 뚜렷이 보이지 않으면 "primary"로 정규화한다. React 상태와 `activeSurfaceId()`
   * seam 홀더를 함께 갱신해 요청버스 라우팅과 화면(사이드바·시각 피드백)이 정합. */
  setActiveSurface: (id: SurfaceId) => void;
  /** 활성 표면 정규화(무음 유실 차단) — 좌/우 프로젝트·멤버십이 바뀌는 경로
   * (setDualProject·closeProject·applyRemoteActive)가 호출한다. 활성이 secondary
   * 인데 우측이 렌더되지 않으면 primary로 되돌린다. */
  reconcileActiveSurface: () => void;
  /** Apply a project switch broadcast from ANOTHER window — sets state only, no
   * persist/re-emit (the originating window already did both; review R0-3). */
  applyRemoteActive: (path: string | null) => void;
  /** Subscribe to cross-window `project-sync` events; returns an unlisten fn.
   * Both the main window and popout windows call this (review R0-4). */
  initProjectSync: () => Promise<UnlistenFn>;
  /** Expand/collapse a directory for the active project (= toggleExpandedFor의
   * 활성 프로젝트 위임 — 하위호환). */
  toggleExpanded: (dirPath: string) => void;
  /** Expand/collapse a directory for a **specific project** (P5 F2 — 부 표면
   * 트리가 자기 프로젝트의 tree_state에만 기록하게). */
  toggleExpandedFor: (project: string | null, dirPath: string) => void;
  /** Lazily load a directory's children via the backend. */
  loadChildren: (dirPath: string) => Promise<void>;
  /** Force re-read a directory (after create/delete) — bypasses the cache. */
  reloadDir: (dirPath: string) => Promise<void>;
  /** Re-read the active project's root + expanded dirs (disk reload). */
  reloadActiveTree: () => Promise<void>;
  /** Re-read a **specific** project's root + expanded dirs (disk reload). P5:
   * 표면-스코프 — 각 표면의 FolderTree가 자기 프로젝트 트리만 폴한다(전역
   * activeProject 재로드하던 2인스턴스 버그 차단). null이면 no-op. */
  reloadTreeFor: (project: string | null) => Promise<void>;
  /** Save a project's dockview main-area layout (opaque JSON) and persist. */
  setLayout: (path: string, layout: unknown) => void;
  /** Dockview layouts for popout windows, per project (multiwindow swap — review
   * R1-5/decision). `windowLabel -> projectPath -> layout`. Persisted to
   * localStorage so popouts reopen on restart (P2). */
  popoutLayouts: Record<string, Record<string, unknown>>;
  /** Save a popout window's layout for a project (persists). */
  setPopoutLayout: (windowLabel: string, project: string, layout: unknown) => void;
  /** Read a popout window's saved layout for a project (or null). */
  getPopoutLayout: (windowLabel: string, project: string) => unknown | null;
  /** Drop a popout's persisted layout + geometry — a genuine close (user X /
   * empty auto-close) must NOT reopen next launch (P2). */
  removePopoutLayout: (windowLabel: string) => void;
  /** Persisted popout window geometry (logical px) for restart reopen (P2). */
  popoutGeometry: Record<string, PopoutGeo>;
  /** Save a popout window's geometry (persists). */
  setPopoutGeometry: (windowLabel: string, geo: PopoutGeo) => void;
  /** 레이아웃 없는 고아 popout geometry 정리 (기동 시 1회 — P5 F-h). */
  pruneOrphanPopoutGeometry: () => void;
  /** Move the folder-tree keyboard cursor. */
  setTreeCursor: (path: string | null) => void;
  /** Open/close the peek viewer on a file (null closes it). */
  setPeekFile: (path: string | null, line?: number) => void;
  /** Open the commit-files sidebar for a commit (closes any prior file view). */
  openGitHistory: (root: string, commit: string) => void;
  /** Close the commit-files sidebar (and any open file view). */
  closeGitHistory: () => void;
  /** Open/close the peek-style file view for a file in the selected commit. */
  openGitHistoryFile: (root: string, commit: string, path: string) => void;
  closeGitHistoryFile: () => void;
  /**
   * 표면별 슬롯 라우팅(P5 F1): 요청 발행부는 자기 표면의 **origin id** 슬롯에 쓴다
   * (기본 "primary" — 앱-전역/상단 툴바 발행부는 그대로 primary). 각 emitter가
   * 자기 `<SurfaceProvider>`의 `useSurfaceId()`(컴파일-고정)를 넘기고, 소비부
   * (MainArea)가 `slot[mySurfaceId]`만 읽어 자기 슬롯을 소비/clear → 그 표면 dock에
   * 열리고 **두 표면 동시발행이 서로를 안 덮는다**(무음 유실 0 — codex P1 해소).
   */
  /** Request opening a file in the editor (MainArea consumes + clears with null). */
  requestEditorOpen: (path: string | null, surfaceId?: SurfaceId) => void;
  /** Request opening a diff panel (MainArea consumes + clears with null). */
  requestDiff: (spec: DiffSpec | null, surfaceId?: SurfaceId) => void;
  /** Request opening a new Claude session in `project` (MainArea consumes + clears).
   * Optional `seed`/`title` pre-seed a review session. */
  requestClaudeOpen: (
    req: {
      project: string;
      seed?: string;
      title?: string;
      referencePanelId?: string;
      model?: string;
      effort?: string;
    } | null,
    surfaceId?: SurfaceId,
  ) => void;
  /** Request opening a new codex session in `project` (MainArea consumes + clears). */
  requestCodexOpen: (
    req: { project: string; model?: string; effort?: string } | null,
    surfaceId?: SurfaceId,
  ) => void;
  /** Inject a prompt into a live Claude session (consumed by the matching panel). */
  requestClaudeInject: (
    req: { id: string; uuid: string; text: string; mode?: "submit" | "fill" } | null,
  ) => void;
  /** 배달 결과를 남긴다 (같은 id가 있으면 갈아끼운다). */
  reportClaudeInjectAck: (ack: { id: string; ok: boolean; reason?: string }) => void;
  /** 확인이 끝난 결과를 치운다. */
  clearClaudeInjectAck: (id: string) => void;
  /** Enqueue a dev-mode review of a saved file (the project's DevView consumes by
   * id). Mints a stable id and appends to the FIFO queue. */
  requestDevReview: (req: { project: string; prompt: string }) => void;
  /** Remove a devReview entry by id after delivering it (idempotent — a missing
   * id is a no-op, so a double consume from the onReady/effect paths is safe). */
  consumeDevReview: (id: string) => void;
  /** Request running a build/test command in a terminal (MainArea consumes). */
  requestRun: (req: { project: string; cmd: string; title: string } | null, surfaceId?: SurfaceId) => void;
  /** 트리 "여기서 터미널 열기" 요청 (앞 dock이 소비); null이면 지운다. */
  requestTerminalOpen: (req: { cwd: string; title: string } | null, surfaceId?: SurfaceId) => void;
  /** Ask MainArea to focus the active dockview panel (Ctrl+B tree→tab toggle). */
  requestFocusMain: () => void;
  /** Ask MainArea to activate the panel for `uuid` (attention roll-up cycle). */
  requestFocusSession: (uuid: string) => void;
  /** Ask MainArea to toggle the "+ Terminal" menu (app-toolbar button). */
  requestTermMenu: () => void;
  /** Ask MainArea to open the "+ Claude" session picker (툴바 버튼). */
  requestClaudePicker: (surfaceId?: SurfaceId) => void;
  /** Ask MainArea to detach the active panel to a new window (app-toolbar button). */
  requestDetachPanel: () => void;
  /** Ask MainArea to open the active project's memo panel (툴바·피커). */
  requestMemo: (surfaceId?: SurfaceId) => void;
  /** Ask MainArea to resume a saved session (아카이브 "이어서"); null clears. */
  requestSessionResume: (
    req: { uuid: string; project: string; title: string } | null,
    surfaceId?: SurfaceId,
  ) => void;
  /** Switch the color theme. */
  setTheme: (theme: "dark" | "light") => void;
  /** Set the code font size (clamped 9–28). */
  setFontSize: (n: number) => void;
  /** Set (or clear with null) the custom terminal color overrides. */
  setTermColors: (c: Partial<ITheme> | null) => void;
  /** Switch the workspace view mode (workspace / study). */
  setMode: (mode: "workspace" | "study") => void;
  /** Toggle a project's 개발↔통합 flavor and persist. */
  setProjectMode: (project: string, mode: "integrated" | "dev") => void;
  /** Get (minting + persisting on first use) the project's stable dev session uuid. */
  ensureDevUuid: (project: string) => string;
  /** Set (or clear) a study side's root folder (resets that side's tabs). */
  setStudyFolder: (side: "left" | "right", path: string | null) => void;
  /** 스터디 트리(key)의 확장 목록 교체 — 항상 새 배열(메모 계약). */
  setStudyExpanded: (key: string, dirs: string[]) => void;
  /** Open a file in a study side's viewer (front of MRU + active). */
  openStudyTab: (side: "left" | "right", path: string) => void;
  /** Close a study tab (fixes the active tab if it was the one closed). */
  closeStudyTab: (side: "left" | "right", path: string) => void;
  /** Activate a study tab (moves it to front of MRU). */
  setStudyActive: (side: "left" | "right", path: string) => void;
  /** Save the study session's dockview layout (in-memory). */
  setStudySessionLayout: (layout: unknown | null) => void;
  /** Return the stable study session UUID, generating + persisting if absent. */
  ensureStudySessionUuid: () => string;
  /** Set a study side's open mode (viewer / editor). */
  setStudyMode: (side: "left" | "right", mode: "viewer" | "editor") => void;
  /** Viewer-mode open: replace the side's single preview tab (no accumulation). */
  openStudyPreview: (side: "left" | "right", path: string) => void;
  /** Cycle the active tab by `dir` (+1/-1) in stable order (Alt+←/→ tab nav). */
  cycleStudyTab: (side: "left" | "right", dir: 1 | -1) => void;
  /** Close any study tabs at `path` or under it (after a delete) — both sides. */
  closeStudyTabsUnder: (path: string) => void;
  /** Persist the current workspace to the backend. */
  persist: () => void;
}

// basename은 utils/path 단일 출처 (P4 — 동일 구현 3벌 통합).

/** Broadcast the active project to other windows (origin-tagged so the sender
 * skips its own echo). Every path that changes `activeProject` calls this so all
 * windows stay on the same project — switch, open, and close (review R0-3/R1-9). */
function broadcastActiveProject(path: string | null) {
  emit("project-sync", { activeProject: path, sourceWindow: getCurrentWindow().label }).catch(
    () => {},
  );
}

/** P2: 트리 배치 사이클 in-flight 가드 + 재실행 요청 비트. **P5: 프로젝트별**
 * (Set) — 두 표면이 서로 다른 프로젝트 트리를 동시 폴할 수 있으므로 가드를
 * 프로젝트 키로 분리한다(같은 프로젝트 2표면이면 자연 직렬화: 한쪽 사이클 중
 * 다른 호출은 pending 표시 → 종료 후 1회 더). 겹친 호출(수동 ↻ 포함)은 버리지
 * 않고 현 사이클 종료 후 한 번 더 돈다 — "최신 요청 우선". */
const treeReloadInFlight = new Set<string>();
const treeReloadPending = new Set<string>();

/** hang한 read_dir(끊긴 네트워크 마운트 등) 하나가 폴링을 영구 정지시키지
 * 않도록 사이클당 가드 점유 상한 — 초과 시 가드만 풀고 늦은 응답의 쓰기는
 * 세대 가드(gen/epoch)가 걸러낸다(리뷰 P2 + 감사 B1). */
const TREE_RELOAD_GUARD_MS = 10_000;

/** 배치 사이클 세대 — 새 사이클 시작마다 증가. 타임아웃으로 가드를 넘긴 구
 * 사이클의 늦은 set은 세대 불일치로 무효(감사 B1: 구 사이클이 신 사이클의
 * before 기준을 오염시켜 더 새 결과를 버리게 하던 경로 차단). **P5: 프로젝트별**
 * — 다른 프로젝트 사이클이 서로를 교차 취소하지 않게 세대를 키로 분리한다. */
const treeCycleGen = new Map<string, number>();

/** 트리 캐시 세대 — closeProject 축출마다 증가. 축출 **이전에** 발주된 모든
 * read_dir 응답은 세대 불일치로 버려진다(감사 B3: 응답 대기 중 재오픈하면
 * 경로 기반 허용 검사가 다시 true가 되어 구 응답이 새 캐시를 덮던 혼동까지
 * 세대 비교가 정확히 막는다). 무관한 프로젝트 close로 드롭된 조회는 다음
 * 4초 폴링(확장 dir 전부 포함)이 복원한다. */
let treeCacheEpoch = 0;


/** P5 F-g: 상한 적용 + 축출 발생 시 epoch 증가(리뷰 P2-3 — 축출은 in-flight
 * 응답의 부활 차단 가드(epoch)와 한 몸이어야 pruneTreeCache와 일관된다).
 * FIFO(삽입순) 축출 — LRU 아님(spec 하향 정정: 목적은 메모리 바운드, keep-set이
 * 표시를 보호한다). */
function capTreeCacheBumping<T>(
  cache: Record<string, T>,
  s: {
    projects: { path: string; tree_state: { expanded: string[] } }[];
    studyFolders: { left: string | null; right: string | null };
    studyExpanded: Record<string, string[]>;
  },
): Record<string, T> {
  const capped = capTreeCache(cache, computeTreeKeepSet(s.projects, s.studyFolders, s.studyExpanded));
  if (capped !== cache) treeCacheEpoch++;
  return capped;
}

/** dir별 미해결 read_dir 추적 — hang한 dir는 미해결 1건만 남기고 이후
 * 사이클에서 제외한다(감사 B2: 10초마다 새 배치가 hang dir에 invoke를
 * 무한 누적하던 경로 차단). 나머지 dir는 계속 갱신된다. */
const treeDirInFlight = new Set<string>();

/** 열린 프로젝트·스터디 폴더 아래만 트리 캐시 쓰기 허용 — epoch는 close
 * **이전** 발주를, 이 검사는 close **이후** stale 경로의 발주(늦게 완료된
 * 파일 작업의 reloadDir 등)를 막는다(재점검: 둘을 병행해야 고아 캐시 부활이
 * 완전 차단). */
function treeWriteAllowed(
  s: { projects: { path: string }[]; studyFolders: { left: string | null; right: string | null } },
  dir: string,
): boolean {
  return (
    s.projects.some((p) => underRoot(dir, p.path)) ||
    (!!s.studyFolders.left && underRoot(dir, s.studyFolders.left)) ||
    (!!s.studyFolders.right && underRoot(dir, s.studyFolders.right))
  );
}

/** One-time migration/load of the surface tree at store construction (same
 * timing as the old `dualProject` localStorage read). Shared so `surfaceTree`
 * and its `dualProject` mirror start from the identical instance. */
const SURFACE_TREE_INIT = loadSurfaceTree();

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  activeProject: null,
  activeSurfaceId: "primary",
  childrenCache: {},
  loadingDirs: {},
  treeCursor: null,
  peekFile: null,
  peekLine: null,
  gitHistory: null,
  gitHistoryFile: null,
  editorOpenRequest: noSlots(),
  diffRequest: noSlots(),
  claudeOpenRequest: noSlots(),
  codexOpenRequest: noSlots(),
  claudeInjectRequest: null,
  claudeInjectAcks: [],
  devReviewQueue: [],
  runRequest: noSlots(),
  terminalOpenRequest: noSlots(),
  focusMainRequest: { targetSurfaceId: "primary", nonce: 0 },
  focusSessionRequest: null,
  termMenuRequest: { targetSurfaceId: "primary", nonce: 0 },
  claudePickerRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
  detachPanelRequest: { targetSurfaceId: "primary", nonce: 0 },
  memoRequest: { primary: { nonce: 0 }, secondary: { nonce: 0 } },
  sessionResumeRequest: noSlots(),
  surfaceTree: SURFACE_TREE_INIT,
  dualProject: secondaryProject(SURFACE_TREE_INIT),
  theme: (localStorage.getItem("theme") as "dark" | "light") || "dark",
  fontSize: clampFontSize(Number(localStorage.getItem("fontSize")) || 13),
  termColors: loadTermColors(),
  mode: localStorage.getItem("mode") === "study" ? "study" : "workspace",
  projectModes: loadProjectModes(),
  devUuids: loadStringMap("devUuids"),
  studyFolders: STUDY0.folders,
  studyExpanded: {},
  studyTabs: STUDY0.tabs,
  studyActive: STUDY0.active,
  studyMode: STUDY0.mode,
  studySessionLayout: null,
  studySessionUuid: localStorage.getItem("studySessionUuid"),
  savedConnections: [],
  archiveRoot: null,
  archiveModel: null,
  archiveEffort: null,

  setArchiveConfig: async (root, model, effort) => {
    const norm = (v: string | null) => (v && v.trim() ? v.trim() : null);
    set({
      archiveRoot: norm(root),
      archiveModel: norm(model),
      archiveEffort: norm(effort),
    });
    // ONE awaited save — the caller re-queries only after the backend has the
    // new values, and learns about a failed save instead of a silent lie.
    return savePersisted(get);
  },
  persistScrollback: localStorage.getItem("persistScrollback") === "1",

  setPersistScrollback: (on) => {
    localStorage.setItem("persistScrollback", on ? "1" : "0");
    set({ persistScrollback: on });
    // Tell the backend so running flushers stop/start writing too (P4-R3).
    invoke("scrollback_set_enabled", { enabled: on }).catch(() => {});
  },

  init: async () => {
    // Sync the backend's scrollback-persistence flag with the saved preference
    // (default OFF) so restored sessions honor it from the first tick (P4-R3).
    invoke("scrollback_set_enabled", { enabled: get().persistScrollback }).catch(() => {});
    try {
      const ws = await invoke<WorkspaceState>("load_state");
      const loaded = ws.open_projects ?? [];
      set({
        projects: loaded,
        activeProject: ws.active_project ?? null,
        savedConnections: ws.saved_connections ?? [],
        archiveRoot: ws.archive_root ?? null,
        archiveModel: ws.archive_model ?? null,
        archiveEffort: ws.archive_effort ?? null,
      });

      // Self-heal: re-detect types for every loaded project so old saved
      // state (single `project_type`, or stale markers) normalizes to the
      // current multi-type model. Best-effort; failures keep prior value.
      const refreshed = await Promise.all(
        loaded.map(async (p) => {
          try {
            const types = await invoke<ProjectType[]>("detect_project_types", {
              path: p.path,
            });
            return { ...p, project_types: types };
          } catch (err) {
            console.error("detect_project_types failed", err);
            return { ...p, project_types: p.project_types ?? [] };
          }
        }),
      );
      set({ projects: refreshed });
      get().persist();

      // FD(리뷰): 복원된 open_projects에 우측 표면 프로젝트가 없으면(예전 세션에서
      // 닫혔거나 workspace.json과 legacy 키가 어긋난 경우) 여기서 정리한다 —
      // hydration 완료 후 1회, App 이펙트 의존 없이 트리·미러·키를 정합화한다.
      const secondary = secondaryProject(get().surfaceTree);
      if (secondary && !refreshed.some((p) => p.path === secondary)) {
        get().setDualProject(null);
      }
    } catch (err) {
      // load_state is infallible on the Rust side, but guard anyway.
      console.error("load_state failed", err);
    }
  },

  addProject: async (path) => {
    // Already open -> just focus it (좌측 primary로 — 목적지 라우팅은 P4' 범위 밖).
    if (get().projects.some((p) => p.path === path)) {
      set({ activeProject: path });
      get().persist();
      broadcastActiveProject(path);
      get().reconcileActiveSurface(); // 새 activeProject가 dev/겹침이면 활성 표면 표시 정규화
      return;
    }

    let projectTypes: ProjectType[] = [];
    try {
      projectTypes = await invoke<ProjectType[]>("detect_project_types", {
        path,
      });
    } catch (err) {
      console.error("detect_project_types failed", err);
    }

    const project: Project = {
      path,
      name: basename(path),
      project_types: projectTypes,
      tree_state: { expanded: [] },
    };

    set((s) => ({
      projects: [...s.projects, project],
      activeProject: path,
    }));
    get().persist();
    broadcastActiveProject(path);
    get().reconcileActiveSurface(); // 새 activeProject가 dev/겹침이면 활성 표면 표시 정규화
  },

  closeProject: (path) => {
    const before = get().activeProject;
    // FD(리뷰): 닫는 프로젝트가 우측 표면이면 **이 갱신 안에서** 트리·미러를 함께
    // 제거한다. 예전엔 App 이펙트(projects.length>0 가드)가 정리했는데, 마지막
    // 프로젝트를 닫아 목록이 비면 그 가드가 정리를 막아 닫은 경로가 트리·미러·
    // 키에 잔존했다. store 액션이 정본이 되어 effect 의존을 없앤다.
    const clearedSurface = secondaryProject(get().surfaceTree) === path;
    set((s) => {
      const projects = s.projects.filter((p) => p.path !== path);
      let activeProject = s.activeProject;
      if (activeProject === path) {
        activeProject = projects.length > 0 ? projects[0].path : null;
      }
      // P2 F3: 닫힌 프로젝트의 트리 캐시 축출(무제한 성장 방지 — 모노repo
      // 수십 MB 잔존). 남은 프로젝트·스터디 폴더 아래는 보존(중첩 대비).
      // epoch 증가로 **이 시점 이전에 발주된** 모든 read_dir 응답을 무효화
      // — in-flight 완료가 축출을 되살리거나(리뷰 P1) 재오픈 후 구 응답이
      // 새 캐시를 덮는(감사 B3) 경로 차단. 재오픈은 cache-miss → 새로 읽음.
      treeCacheEpoch++;
      const keep = [...projects.map((p) => p.path), s.studyFolders.left, s.studyFolders.right];
      const surfaceTree = clearedSurface ? removeSurface(s.surfaceTree) : s.surfaceTree;
      return {
        projects,
        activeProject,
        surfaceTree,
        dualProject: secondaryProject(surfaceTree),
        childrenCache: pruneTreeCache(s.childrenCache, path, keep),
        loadingDirs: pruneTreeCache(s.loadingDirs, path, keep),
        // P5 F1: 부 표면이 닫혔으면 그 표면 요청 슬롯도 비운다(teardown 누출 차단).
        ...(clearedSurface ? clearSecondarySlots(s) : {}),
      };
    });
    // 우측 표면이 닫혔으면 legacy 키(디스크 정본)도 즉시 정리 — 잔존 방지.
    if (clearedSurface) persistSurfaceTree(get().surfaceTree);
    // G1(리뷰): 우측 표면 제거뿐 아니라 **재인덱스로 좌측이 우측과 같은 프로젝트가
    // 되는 경로**(primary 닫힘 → projects[0]=secondary 프로젝트 → 겹침 숨김)에서도
    // 활성이 secondary로 남아 무음 유실됐다. 최종 상태에서 정규화 술어를 재적용한다.
    get().reconcileActiveSurface();
    get().persist();
    // If closing the active project moved focus elsewhere, sync other windows
    // so they swap too (review R1-9).
    const after = get().activeProject;
    if (after !== before) broadcastActiveProject(after);
  },

  reorderProject: (fromPath, toPath, insertAfter) => {
    set((s) => {
      if (fromPath === toPath) return {};
      const fromIdx = s.projects.findIndex((p) => p.path === fromPath);
      if (fromIdx === -1) return {};
      const projects = [...s.projects];
      const [moved] = projects.splice(fromIdx, 1);
      // Compute the insertion point AFTER removal so no index-shift correction
      // is needed; `toPath` still exists in the array (from !== to).
      const targetIdx = projects.findIndex((p) => p.path === toPath);
      if (targetIdx === -1) return {};
      projects.splice(insertAfter ? targetIdx + 1 : targetIdx, 0, moved);
      return { projects };
    });
    get().persist();
  },

  setActive: (path) => {
    set({ activeProject: path });
    get().persist();
    broadcastActiveProject(path);
    get().reconcileActiveSurface(); // 새 activeProject가 dev/겹침이면 활성 정규화(H1 균일)
  },
  setActiveSurface: (id) => {
    // 우측 표면이 **뚜렷이 보이지 않으면**(없음·좌우 겹침 숨김·닫힘) secondary를
    // 활성으로 둘 수 없다 — primary로 정규화(G4: 완전 가시성 술어 통일).
    const next: SurfaceId = id === "secondary" && secondaryIsVisible(get()) ? "secondary" : "primary";
    setActiveSurfaceSeam(next); // imperative 발행 경로(요청버스 stamp)가 읽는 홀더
    if (get().activeSurfaceId !== next) set({ activeSurfaceId: next });
  },
  reconcileActiveSurface: () => {
    // 좌/우 프로젝트·멤버십이 바뀌는 모든 경로가 호출하는 정규화 단일 진입점.
    // 활성이 secondary인데 우측이 안 보이면 primary로 되돌린다 — setActiveSurface가
    // 가시성 술어를 재적용하므로 현재 id를 그대로 재확정하면 된다(무음 유실 차단).
    if (get().activeSurfaceId === "secondary") get().setActiveSurface("secondary");
  },
  applyRemoteActive: (path) => {
    set({ activeProject: path });
    // 크로스윈도우 전환이 좌측을 우측 표면과 같은 프로젝트로 만들면 secondary가
    // 숨겨진다 — 활성을 primary로 정규화해 유령 라우팅(무음 유실)을 막는다(P4').
    get().reconcileActiveSurface();
  },
  initProjectSync: async () => {
    const self = getCurrentWindow().label;
    return await listen<{ activeProject: string | null; sourceWindow: string }>(
      "project-sync",
      (e) => {
        const { activeProject, sourceWindow } = e.payload;
        // Ignore our own echo + no-op if already on that project (review R0-3).
        if (sourceWindow === self || activeProject === get().activeProject) return;
        get().applyRemoteActive(activeProject);
      },
    );
  },

  setTreeCursor: (path) => set({ treeCursor: path }),
  setPeekFile: (path, line) => set({ peekFile: path, peekLine: line ?? null }),
  openGitHistory: (root, commit) =>
    set({ gitHistory: { root, commit }, gitHistoryFile: null }),
  closeGitHistory: () => set({ gitHistory: null, gitHistoryFile: null }),
  openGitHistoryFile: (root, commit, path) =>
    set({ gitHistoryFile: { root, commit, path } }),
  closeGitHistoryFile: () => set({ gitHistoryFile: null }),
  // 요청버스 라우팅 — **P5 F1 표면별 슬롯**: 각 발행부가 자기 표면의 **origin id**
  // 슬롯에 쓴다(기본 "primary" — 앱-전역/상단 툴바). 표면-스코프 emitter(부 표면
  // 툴바·양 표면 사이드바)는 자기 `useSurfaceId()`(컴파일-고정)를 넘긴다. 소비부
  // (MainArea)는 `slot[mySurfaceId]`만 읽고 자기 슬롯만 clear → 그 표면 dock에 열리고
  // **두 표면 동시발행이 서로를 안 덮는다**(무음 유실 0). putSlot/bumpCounter가 상대
  // 표면 슬롯을 보존하며 origin 슬롯만 갱신한다. `activeSurfaceId()` seam은 라우팅에
  // 쓰이지 않고(사이드바 표시/추적용 상태만) 존치한다.
  requestEditorOpen: (path, surfaceId = "primary") =>
    set((s) => ({ editorOpenRequest: putSlot(s.editorOpenRequest, surfaceId, path === null ? null : { path }) })),
  requestDiff: (spec, surfaceId = "primary") =>
    set((s) => ({ diffRequest: putSlot(s.diffRequest, surfaceId, spec) })),
  requestClaudeOpen: (req, surfaceId = "primary") =>
    set((s) => ({ claudeOpenRequest: putSlot(s.claudeOpenRequest, surfaceId, req) })),
  requestCodexOpen: (req, surfaceId = "primary") =>
    set((s) => ({ codexOpenRequest: putSlot(s.codexOpenRequest, surfaceId, req) })),
  requestClaudeInject: (req) => set({ claudeInjectRequest: req }),
  reportClaudeInjectAck: (ack) =>
    set((s) => ({
      // 상한 8 — 확인되지 않은 결과가 무한히 쌓이지 않게(오래된 것부터 버린다).
      claudeInjectAcks: [...s.claudeInjectAcks.filter((a) => a.id !== ack.id), ack].slice(-8),
    })),
  clearClaudeInjectAck: (id) =>
    set((s) => ({ claudeInjectAcks: s.claudeInjectAcks.filter((a) => a.id !== id) })),
  requestDevReview: (req) =>
    set((s) => ({
      devReviewQueue: [...s.devReviewQueue, { id: crypto.randomUUID(), ...req }],
    })),
  consumeDevReview: (id) =>
    set((s) => ({ devReviewQueue: s.devReviewQueue.filter((r) => r.id !== id) })),
  requestRun: (req, surfaceId = "primary") =>
    set((s) => ({ runRequest: putSlot(s.runRequest, surfaceId, req) })),
  requestTerminalOpen: (req, surfaceId = "primary") =>
    set((s) => ({
      terminalOpenRequest: putSlot(
        s.terminalOpenRequest,
        surfaceId,
        req ? { ...req, nonce: (s.terminalOpenRequest[surfaceId]?.nonce ?? 0) + 1 } : null,
      ),
    })),
  requestFocusMain: () =>
    // picker-UI-open(G2): 항상 primary. Ctrl+B 포커스는 primary 크롬 기준.
    set((s) => ({ focusMainRequest: { targetSurfaceId: "primary", nonce: s.focusMainRequest.nonce + 1 } })),
  requestFocusSession: (uuid) =>
    set((s) => ({
      focusSessionRequest: { uuid, nonce: (s.focusSessionRequest?.nonce ?? 0) + 1 },
    })),
  requestTermMenu: () =>
    // termMenu 팝오버(+SSH 다이얼로그/호스트키 모달)는 주 표면 `.main-menus`에만
    // 렌더 → 항상 primary. 부 표면 "터미널"은 requestTerminalOpen 직접(로컬).
    set((s) => ({ termMenuRequest: { targetSurfaceId: "primary", nonce: s.termMenuRequest.nonce + 1 } })),
  requestClaudePicker: (surfaceId = "primary") =>
    // 세션 피커는 표면-로컬(P5): 각 표면이 자기 `.main-menus`에 SessionPicker를
    // 렌더하고 자기 dock/project로 조회·오픈한다. **F1**: 표면별 카운터라 두 표면이
    // 동시에 눌러도 서로의 발화를 삼키지 않는다.
    set((s) => ({ claudePickerRequest: bumpCounter(s.claudePickerRequest, surfaceId) })),
  requestDetachPanel: () =>
    // 분리(창 전송)는 주 표면만 — installDragOut/전송 envelope가 activeProject 기준.
    set((s) => ({ detachPanelRequest: { targetSurfaceId: "primary", nonce: s.detachPanelRequest.nonce + 1 } })),
  requestMemo: (surfaceId = "primary") =>
    set((s) => ({ memoRequest: bumpCounter(s.memoRequest, surfaceId) })),
  setDualProject: (path, placement) => {
    // 트리가 멤버십·방향 정본: 열기=addSurface(방향·위치 = placement, 기본 우측),
    // 닫기=removeSurface. persist = 트리(정본)+legacy 미러(다운그레이드).
    const prevSecondary = secondaryProject(get().surfaceTree);
    const tree = path
      ? addSurface(get().surfaceTree, path, placement)
      : removeSurface(get().surfaceTree);
    persistSurfaceTree(tree); // 트리 블롭(방향 포함) + legacy 파생 미러(P6)
    const nextSecondary = secondaryProject(tree);
    set((s) => ({
      surfaceTree: tree,
      dualProject: nextSecondary,
      // **P5 F1 teardown**: 부 표면 멤버십이 바뀌면(닫힘·교체) 부 표면 object
      // 슬롯을 전부 비운다 — 닫는 프레임에 대기하던 요청이 다음 부 표면으로
      // 누출(Opus P3-2 레이스)되지 않게. 카운터(picker·memo)는 새 마운트의
      // dedup ref가 현재 nonce를 캡처하므로 clear 불필요.
      ...(prevSecondary !== nextSecondary ? clearSecondarySlots(s) : {}),
    }));
    get().reconcileActiveSurface(); // 우측이 안 보이게 됐으면 활성→primary(무음 유실 차단)
  },
  requestSessionResume: (req, surfaceId = "primary") =>
    set((s) => ({
      sessionResumeRequest: putSlot(
        s.sessionResumeRequest,
        surfaceId,
        req === null ? null : { ...req, nonce: (s.sessionResumeRequest[surfaceId]?.nonce ?? 0) + 1 },
      ),
    })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (n) => set({ fontSize: clampFontSize(n) }),
  setTermColors: (c) => {
    if (c) localStorage.setItem("termColors", JSON.stringify(c));
    else localStorage.removeItem("termColors");
    set({ termColors: c });
  },
  setMode: (mode) => {
    localStorage.setItem("mode", mode);
    set({ mode });
  },
  setProjectMode: (project, mode) => {
    const next = { ...get().projectModes };
    if (mode === "dev") next[project] = "dev";
    else delete next[project]; // "integrated" is the default — keep the map sparse
    localStorage.setItem("projectModes", JSON.stringify(next));
    set({ projectModes: next });
    // G3→H1(codex 최종확인): dev 축이 secondaryIsVisible 술어에 통합됐으므로,
    // dev 진입도 단일 진입점 reconcileActiveSurface가 균일하게 처리한다(예전
    // setActiveSurface("primary") 특수 경로 제거 — 단일 술어가 정본). 주 프로젝트가
    // dev면 술어가 false → 활성=secondary는 primary로 정규화(오버레이가 dual 가림).
    get().reconcileActiveSurface();
  },
  ensureDevUuid: (project) => {
    const cur = get().devUuids[project];
    if (cur) return cur;
    const uuid = crypto.randomUUID();
    const next = { ...get().devUuids, [project]: uuid };
    localStorage.setItem("devUuids", JSON.stringify(next));
    set({ devUuids: next });
    return uuid;
  },
  setStudyFolder: (side, path) => {
    set((s) => ({
      studyFolders: { ...s.studyFolders, [side]: path },
      studyTabs: { ...s.studyTabs, [side]: [] },
      studyActive: { ...s.studyActive, [side]: null },
    }));
    saveStudyView(get());
  },
  setStudyExpanded: (key, dirs) =>
    set((s) => ({ studyExpanded: { ...s.studyExpanded, [key]: dirs } })),
  openStudyTab: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path, ...s.studyTabs[side].filter((p) => p !== path)] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  setStudyActive: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path, ...s.studyTabs[side].filter((p) => p !== path)] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  closeStudyTab: (side, path) => {
    set((s) => {
      const next = s.studyTabs[side].filter((p) => p !== path);
      const active = s.studyActive[side] === path ? (next[0] ?? null) : s.studyActive[side];
      return {
        studyTabs: { ...s.studyTabs, [side]: next },
        studyActive: { ...s.studyActive, [side]: active },
      };
    });
    saveStudyView(get());
  },
  setStudySessionLayout: (layout) => set({ studySessionLayout: layout }),
  ensureStudySessionUuid: () => {
    let u = get().studySessionUuid;
    if (!u) {
      u = crypto.randomUUID();
      localStorage.setItem("studySessionUuid", u);
      set({ studySessionUuid: u });
    }
    return u;
  },
  setStudyMode: (side, mode) => {
    set((s) => ({ studyMode: { ...s.studyMode, [side]: mode } }));
    saveStudyView(get());
  },
  openStudyPreview: (side, path) => {
    set((s) => ({
      studyTabs: { ...s.studyTabs, [side]: [path] },
      studyActive: { ...s.studyActive, [side]: path },
    }));
    saveStudyView(get());
  },
  cycleStudyTab: (side, dir) => {
    set((s) => {
      const tabs = s.studyTabs[side];
      if (tabs.length === 0) return {};
      const i = tabs.indexOf(s.studyActive[side] ?? "");
      const ni = ((i === -1 ? 0 : i) + dir + tabs.length) % tabs.length;
      return { studyActive: { ...s.studyActive, [side]: tabs[ni] } };
    });
    saveStudyView(get());
  },
  closeStudyTabsUnder: (path) => {
    const match = (p: string) => p === path || p.startsWith(`${path}/`);
    set((s) => {
      const prune = (side: "left" | "right") => {
        const tabs = s.studyTabs[side].filter((p) => !match(p));
        const active = match(s.studyActive[side] ?? "\0") ? (tabs[0] ?? null) : s.studyActive[side];
        return { tabs, active };
      };
      const L = prune("left");
      const R = prune("right");
      return {
        studyTabs: { left: L.tabs, right: R.tabs },
        studyActive: { left: L.active, right: R.active },
      };
    });
    saveStudyView(get());
  },

  toggleExpanded: (dirPath) => get().toggleExpandedFor(get().activeProject, dirPath),
  toggleExpandedFor: (project, dirPath) => {
    if (!project) return;
    // expanded는 항상 **새 배열**로 교체한다 — expandedSetOf의 identity 메모
    // 계약(in-place push/splice 금지, treeSelectors 참조). P5 F2: **인자 project**의
    // tree_state에만 기록 → 부 표면 확장이 주 프로젝트 확장을 오염시키지 않고,
    // reloadTreeFor(project)가 자기 확장 dir를 정확히 본다.
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.path !== project) return p;
        const expanded = p.tree_state.expanded;
        const next = expanded.includes(dirPath)
          ? expanded.filter((d) => d !== dirPath)
          : [...expanded, dirPath];
        return { ...p, tree_state: { ...p.tree_state, expanded: next } };
      }),
    }));
    get().persist();
  },

  loadChildren: async (dirPath) => {
    const { childrenCache, loadingDirs } = get();
    if (childrenCache[dirPath] || loadingDirs[dirPath]) return;

    set((s) => ({ loadingDirs: { ...s.loadingDirs, [dirPath]: true } }));
    // 발주 시점 세대 — 그 사이 축출이 있었으면 응답을 버린다(부활·재오픈
    // 혼동 차단, 감사 B3). 드롭된 dir는 다음 폴링/재확장이 복원.
    const epoch = treeCacheEpoch;
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dirPath });
      set((s) =>
        epoch === treeCacheEpoch && treeWriteAllowed(s, dirPath)
          ? {
              // P5 F-g: 성장 지점에서 상한 강제(keep-set 밖 접힌 dir만 축출).
              childrenCache: capTreeCacheBumping({ ...s.childrenCache, [dirPath]: entries }, s),
            }
          : s,
      );
    } catch (err) {
      // Surface as an empty (but resolved) listing; do not crash the tree.
      console.error("read_dir failed", err);
      set((s) =>
        epoch === treeCacheEpoch && treeWriteAllowed(s, dirPath)
          ? { childrenCache: capTreeCacheBumping({ ...s.childrenCache, [dirPath]: [] }, s) }
          : s,
      );
    } finally {
      // 축출로 키가 사라졌으면 false 재삽입도 하지 않는다(고아 키 방지).
      set((s) => {
        if (!(dirPath in s.loadingDirs)) return s;
        return { loadingDirs: { ...s.loadingDirs, [dirPath]: false } };
      });
    }
  },

  reloadDir: async (dirPath) => {
    const epoch = treeCacheEpoch;
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dirPath });
      // P2: 내용 무변화면 기존 state 그대로 반환(Object.is로 알림 자체 스킵 —
      // 리뷰: `{}` 반환은 merge로 새 루트 state를 만들어 전 리스너를 깨운다).
      // 축출(epoch 증가) 뒤 늦은 응답은 쓰지 않는다.
      set((s) =>
        epoch !== treeCacheEpoch ||
        !treeWriteAllowed(s, dirPath) ||
        sameEntries(s.childrenCache[dirPath], entries)
          ? s
          : { childrenCache: capTreeCacheBumping({ ...s.childrenCache, [dirPath]: entries }, s) },
      );
    } catch (err) {
      console.error("reloadDir failed", err);
    }
  },

  reloadActiveTree: async () => {
    await get().reloadTreeFor(get().activeProject);
  },
  reloadTreeFor: async (project) => {
    if (!project) return;
    // P2(리뷰 재설계): 겹침은 pending 비트로 "종료 후 1회 더"(최신 우선 —
    // 수동 ↻ 무시 방지), 사이클은 가드 점유 상한으로 hang 복구, 쓰기는
    // ①before-스냅샷(읽는 사이 사용자 조작이 쓴 dir는 건드리지 않는다 —
    // 삭제 파일 유령 부활 차단) ②treeWriteAllowed(축출 부활 차단) 이중 가드.
    // P5: 가드는 **프로젝트 키**(Set) — 두 표면이 다른 프로젝트를 동시 폴 가능.
    if (treeReloadInFlight.has(project)) {
      treeReloadPending.add(project);
      return;
    }
    treeReloadInFlight.add(project);
    try {
      do {
        treeReloadPending.delete(project);
        const { projects } = get();
        const expanded =
          projects.find((p) => p.path === project)?.tree_state.expanded ?? [];
        // hang으로 미해결인 dir는 제외 — 미해결 invoke를 dir당 1건으로 상한
        // (감사 B2: 타임아웃마다 새 배치가 같은 dir에 무한 누적하던 경로).
        const dirs = [project, ...expanded].filter((d) => !treeDirInFlight.has(d));
        if (dirs.length === 0) continue;
        const before = get().childrenCache;
        // 세대는 **프로젝트별**(P5) — 두 표면이 다른 프로젝트를 동시 폴할 때
        // 공유 세대면 서로의 사이클을 교차 취소한다(다른 dir인데도).
        const gen = (treeCycleGen.get(project) ?? 0) + 1;
        treeCycleGen.set(project, gen);
        const epoch = treeCacheEpoch;
        const cycle = (async () => {
          // 배치 — 직렬 IPC N회·set N회를 병렬 조회 1배치·set 1회로. 실패
          // dir는 기존 캐시 유지(기존 reloadDir 오류 경로와 동일 관측 동작).
          const results = await Promise.all(
            dirs.map(async (d) => {
              treeDirInFlight.add(d);
              try {
                return [d, await invoke<DirEntry[]>("read_dir", { path: d })] as const;
              } catch (err) {
                console.error("reloadDir failed", err);
                return [d, null] as const;
              } finally {
                treeDirInFlight.delete(d);
              }
            }),
          );
          // 세대 가드: 그 사이 새 사이클이 시작됐거나(gen — 타임아웃 경유 구
          // 사이클) 축출이 있었으면(epoch) 이 사이클의 결과 전체를 버린다.
          if (gen !== treeCycleGen.get(project) || epoch !== treeCacheEpoch) return;
          set((s) => {
            let changed = false;
            const next = { ...s.childrenCache };
            for (const [d, entries] of results) {
              if (!entries) continue;
              // 배치 시작 후 다른 경로(runOp reloadDir·loadChildren)가 이
              // dir를 이미 갱신했다면 그쪽이 더 새 데이터 — 덮지 않는다.
              if (s.childrenCache[d] !== before[d]) continue;
              if (!treeWriteAllowed(s, d)) continue;
              if (!sameEntries(next[d], entries)) {
                next[d] = entries;
                changed = true;
              }
            }
            return changed ? { childrenCache: capTreeCacheBumping(next, s) } : s;
          });
        })();
        // hang한 read_dir 하나가 폴링을 영구 정지시키지 않게 가드 점유만
        // 시간 상한 — 타임아웃된 사이클의 늦은 쓰기는 gen 가드가 무효화.
        await Promise.race([
          cycle,
          new Promise<void>((r) => setTimeout(r, TREE_RELOAD_GUARD_MS)),
        ]);
      } while (treeReloadPending.has(project));
    } finally {
      treeReloadInFlight.delete(project);
    }
  },

  setLayout: (path, layout) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.path === path ? { ...p, layout } : p,
      ),
    }));
    get().persist();
  },

  popoutLayouts: loadPopoutLayouts(),
  setPopoutLayout: (windowLabel, project, layout) =>
    set((s) => {
      const byProject = { ...(s.popoutLayouts[windowLabel] ?? {}), [project]: layout };
      // Read-merge-write the shared store at label granularity (codex P2).
      persistPopoutLayout(windowLabel, byProject);
      return { popoutLayouts: { ...s.popoutLayouts, [windowLabel]: byProject } };
    }),
  getPopoutLayout: (windowLabel, project) => get().popoutLayouts[windowLabel]?.[project] ?? null,
  removePopoutLayout: (windowLabel) =>
    set((s) => {
      // Always drop from the shared store even if our in-memory map lacks it.
      persistRemovePopout(windowLabel);
      const next = { ...s.popoutLayouts };
      delete next[windowLabel];
      const nextGeo = { ...s.popoutGeometry };
      delete nextGeo[windowLabel];
      return { popoutLayouts: next, popoutGeometry: nextGeo };
    }),
  popoutGeometry: loadPopoutGeometry(),
  setPopoutGeometry: (windowLabel, geo) =>
    set((s) => {
      persistPopoutGeometry(windowLabel, geo);
      return { popoutGeometry: { ...s.popoutGeometry, [windowLabel]: geo } };
    }),
  // P5 F-h(P2 이관): 레이아웃 없는 고아 geometry 정리 — geometry는 레이아웃
  // 라벨을 재열 때만 읽히므로(App 재오픈 흐름) 레이아웃이 사라진 라벨의
  // geometry는 영구 잔존하는 죽은 데이터다. 기동 시 1회 호출(App.tsx).
  pruneOrphanPopoutGeometry: () =>
    set(() => {
      // label-granular 지속 계약(위 persist* 3형제와 동형 — 리뷰 P2-2): 공유
      // localStorage를 **신선 읽기**한 뒤 고아만 지운다. 인메모리 전체 덮어
      // 쓰기는 다른 창이 그 사이 쓴 엔트리를 소실시킨다(last-writer-wins).
      const freshGeo = loadPopoutGeometry();
      const freshLayouts = loadPopoutLayouts();
      const orphans = Object.keys(freshGeo).filter((l) => !(l in freshLayouts));
      for (const l of orphans) delete freshGeo[l];
      if (orphans.length > 0) savePopoutGeometry(freshGeo);
      // 판정에 쓴 fresh 스냅샷을 인메모리에도 반영 — 직후 App 재오픈 루프가
      // 레이아웃/좌표를 같은 시점으로 읽게(감사 ①: 한쪽만 갱신하면 어긋난다).
      return { popoutGeometry: freshGeo, popoutLayouts: freshLayouts };
    }),

  upsertConnection: (conn) => {
    set((s) => {
      const others = s.savedConnections.filter((c) => c.id !== conn.id);
      return { savedConnections: [...others, conn] };
    });
    get().persist();
  },

  deleteConnection: async (id) => {
    // Remove the keychain secret first; the backend treats "no entry" as success,
    // so this only fails on a real keychain error. On failure keep the metadata
    // so the secret isn't orphaned and the user can retry (review P3-R4).
    try {
      await invoke("ssh_delete_secret", { id });
    } catch {
      return false;
    }
    set((s) => ({ savedConnections: s.savedConnections.filter((c) => c.id !== id) }));
    get().persist();
    return true;
  },

  persist: () => {
    void savePersisted(get);
  },
}));

/** The single assembly point for the persisted WorkspaceState — every field the
 * backend stores MUST appear here, or the next save wipes it (the archive_root
 * lesson). Resolves `true` on a successful backend save, `false` on failure
 * (logged) — settings callers surface the failure instead of pretending. */
function savePersisted(get: () => AppState): Promise<boolean> {
  const state: WorkspaceState = {
    open_projects: get().projects,
    active_project: get().activeProject,
    saved_connections: get().savedConnections,
    archive_root: get().archiveRoot,
    archive_model: get().archiveModel,
    archive_effort: get().archiveEffort,
  };
  return invoke("save_state", { state })
    .then(() => true)
    .catch((err) => {
      console.error("save_state failed", err);
      return false;
    });
}
