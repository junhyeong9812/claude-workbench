/**
 * 저장된 세션 카탈로그 — "+ Claude" 피커가 보여주는 목록의 순수 규칙
 * (MainArea에서 순수 이동, P5 F-b). React/DOM/tauri 의존 없음.
 */

/** Archive freshness of a saved session — the picker's three groups.
 * `current` = 아카이브가 최신, `stale` = 아카이브 이후 작업 있음, `none` = 아카이브 없음. */
export type ArchState = "current" | "stale" | "none";

/** A saved session normalized for the reopen picker (ACP `claude` or A
 * `claudeterm`). `id` is the session UUID. */
export interface SessionSummary {
  id: string;
  date: string;
  name: string;
  title: string;
  count: number;
  /** The project (cwd) this session belongs to — passed through on reopen. */
  project: string;
  /** Archive freshness (책·요약·지식 유무 + 최신 여부) — picker grouping. */
  archState: ArchState;
  /** When the latest archive was written (unix seconds), if archived. */
  archivedAt: number | null;
  /** Preserved past archive versions of this session. */
  versions: number;
}

/** The picker's archive groups, in display order. */
export const PICKER_GROUPS: { key: ArchState; label: string; hint: string }[] = [
  { key: "current", label: "📦 아카이브됨", hint: "아카이브가 최신입니다 (책·요약·지식 있음)" },
  {
    key: "stale",
    label: "🕓 아카이브 이후 작업",
    hint: "아카이브 뒤에 세션이 더 진행됐습니다 — 다시 아카이브하면 최신화됩니다",
  },
  { key: "none", label: "미아카이브", hint: "아카이브가 없습니다" },
];

/** `claude_sessions` 백엔드 행. */
export interface RawSessionRow {
  uuid: string;
  name: string;
  title: string;
  date: string;
  count: number;
}

/** `archive_status` 백엔드 행. */
export interface ArchiveStatusRow {
  uuid: string;
  up_to_date: boolean;
  archived_at: number | null;
  versions: number;
}

/** 세션 목록 + 아카이브 상태 → 피커 행. 상태 행이 없으면 `none`, 있으면
 * up_to_date로 current/stale 2분. `project`는 모든 행에 그대로 pin된다
 * (cross-project resume 의미 보존). */
export function buildSessionSummaries(
  raw: RawSessionRow[],
  statuses: ArchiveStatusRow[],
  project: string,
): SessionSummary[] {
  const byUuid = new Map(statuses.map((s) => [s.uuid, s]));
  return raw.map((s) => {
    const st = byUuid.get(s.uuid);
    return {
      id: s.uuid,
      name: s.name,
      title: s.title,
      date: s.date,
      count: s.count,
      project,
      archState: (st ? (st.up_to_date ? "current" : "stale") : "none") as ArchState,
      archivedAt: st?.archived_at ?? null,
      versions: st?.versions ?? 0,
    };
  });
}

/**
 * `claude_external_sessions` 백엔드 행 — 터미널에서 직접 연 세션(전사는 있고
 * 앱 스냅샷은 없는 uuid). 앱이 붙으면(adopt) 스냅샷이 생겨 저절로 목록에서
 * 빠진다.
 */
export interface ExternalSessionRow {
  uuid: string;
  title: string;
  /** 세션이 시작된 디렉토리 — resume 스폰은 **반드시** 여기서 해야 한다
   * (CLI가 원 디렉토리에서만 세션을 찾는다). */
  cwd: string;
  /** 전사 mtime (unix 초). */
  modified: number;
  /** free = 붙어도 안전 · live = 다른 곳에서 열려 있음 · unknown = 판정 불가. */
  live: "free" | "live" | "unknown";
  /**
   * 막힌 **이유** (free면 null). 같은 "확인 불가"라도 사용자에게 할 말이 다르다:
   * - `this_session` — 이 세션이 다른 곳에서 열려 있다(그 창을 닫으면 열린다).
   * - `undecidable` — 어디서 도는지 알 수 없는 프로세스가 있어 **어떤 세션도**
   *   지금은 열 수 없다.
   * - `written_since_start` — 이 디렉토리의 무특정 claude가 시작된 뒤에 이 전사가
   *   쓰였다. 그 전에 마지막으로 쓰인 세션은 그대로 열 수 있다.
   */
  reason: "this_session" | "undecidable" | "written_since_start" | null;
}

/**
 * `claude_external_sessions` 응답 — 보이는 행과 **숨긴** 행(사용자가 삭제한
 * 세션)이 한 번에 온다. 숨김은 표시 계층 결정이라 전사·스냅샷은 그대로다.
 *
 * 개수는 `hidden.length`다 — 별도 카운트 필드를 두지 않는다. 화면은 이 배열을
 * 한 번 더 거른 뒤(이미 열려 있는 세션 제외) 보여주므로, 백엔드가 세어 준 수는
 * 두 값이 어긋나는 순간 **틀린 수**가 된다.
 */
export interface ExternalListing {
  sessions: ExternalSessionRow[];
  hidden: ExternalSessionRow[];
}

/** 조회 실패·프로젝트 없음일 때의 빈 응답 (한 곳에서만 만든다). */
export const EMPTY_EXTERNAL: ExternalListing = { sessions: [], hidden: [] };

/** 지금 붙어도 되는 세션인가. `unknown`은 **막는다** — 판정 못 한 세션에 붙으면
 * 같은 전사에 두 프로세스가 append해서 세션이 깨진다(복구 불가). */
export const adoptable = (row: ExternalSessionRow): boolean => row.live === "free";

/**
 * 막힌 이유 배지. 붙을 수 있는 행은 배지가 없다.
 *
 * 힌트는 `live`가 아니라 **`reason`**으로 갈린다: "확인 불가" 두 종류가 사용자에게
 * 정반대의 안내를 요구하기 때문이다. 시각 임계에 걸린 행은 "더 오래된 세션은
 * 열린다"가 참이지만, 판정 자체가 불가능한 상태(어디서 도는지 모를 프로세스)에서
 * 같은 말을 하면 거짓말이 된다(리뷰 P2).
 */
export function liveBadge(row: ExternalSessionRow): { label: string; hint: string } | null {
  if (row.live === "free") return null;
  if (row.live === "live") {
    return {
      label: "사용 중",
      hint: "이 세션이 다른 터미널에서 열려 있습니다 — 그 창을 닫으면 붙일 수 있습니다",
    };
  }
  if (row.reason === "written_since_start") {
    return {
      label: "확인 불가",
      hint: "이 디렉토리에서 세션을 특정할 수 없는 claude가 돌고 있고, 이 전사는 그 claude가 시작된 뒤에 쓰였습니다 — 그 claude가 쓰고 있는 세션일 수 있어 막습니다. 그 시각 이전에 마지막으로 쓰인 세션은 그대로 열 수 있습니다",
    };
  }
  return {
    label: "확인 불가",
    hint: "지금은 어떤 외부 세션도 열 수 없습니다 — 어디서 도는지 알 수 없는 프로세스가 있어 어느 세션이 물려 있는지 특정할 수 없습니다. 그 프로세스가 사라지면 다시 열 수 있습니다",
  };
}

/** 외부 세션 행: 이미 열려 있는 세션 제외 + 최신순. 백엔드도 최신순으로 주지만
 * 정렬 규칙은 저장 세션과 같은 자리(이 모듈)에 둔다. */
export function externalRows(
  rows: ExternalSessionRow[],
  open: ReadonlySet<string>,
): ExternalSessionRow[] {
  return rows.filter((r) => !open.has(r.uuid)).sort((a, b) => b.modified - a.modified);
}

/** dockview 패널 params 중 세션 식별에 쓰이는 부분. */
export interface SessionPanelParams {
  /** claude 패널은 문자열 세션 id; claudeterm은 숫자 PTY id다. */
  sessionId?: unknown;
  sessionUuid?: string;
  loadSessionId?: string;
}

/** 지금 패널에 열려 있는 세션 id 집합 — 피커가 이들을 제외한다 (B3-2).
 * claude 패널은 문자열 sessionId를, claudeterm은 sessionUuid를 들고 있고,
 * 아직 붙기 전이면 resume용 loadSessionId가 그 자리를 대신한다. */
export function openSessionIds(
  paramsList: readonly (SessionPanelParams | undefined)[],
): Set<string> {
  const ids = new Set<string>();
  for (const prm of paramsList) {
    if (typeof prm?.sessionId === "string") ids.add(prm.sessionId);
    if (prm?.sessionUuid) ids.add(prm.sessionUuid);
    if (prm?.loadSessionId) ids.add(prm.loadSessionId);
  }
  return ids;
}

/** Picker rows: saved sessions newest-first, excluding already-open ones (B3-2).
 * 입력 배열은 건드리지 않는다 (filter가 새 배열을 만든 뒤 정렬). */
export function pickerRows(
  sessions: SessionSummary[],
  open: ReadonlySet<string>,
): SessionSummary[] {
  return sessions.filter((s) => !open.has(s.id)).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 피커 조회 응답을 화면에 반영해도 되는가.
 *
 * `apply` = 반영 · `stale` = 더 새 조회가 시작됨(버림) · `switched` = 조회하는
 * 사이 사용자가 프로젝트를 바꿈(버리고 재조회).
 *
 * 세션 목록과 외부 세션은 **프로젝트별** 데이터라, 늦게 도착한 응답이 그대로
 * set되면 A 프로젝트를 보면서 B의 세션 목록이 뜬다. 배지(archBusyUpdate)와 달리
 * 여기서는 세대만으로 부족하다 — 프로젝트 전환은 새 조회를 동반하지 않을 수도
 * 있어서, 응답이 어느 프로젝트 것인지 함께 확인해야 한다.
 */
export function pickerLoadOutcome(
  current: number,
  mine: number,
  requestedProject: string | null,
  currentProject: string | null,
): "apply" | "stale" | "switched" {
  if (current !== mine) return "stale";
  if (requestedProject !== currentProject) return "switched";
  return "apply";
}

/**
 * in_flight 조회 세대 가드 — 늦게 도착한 낡은 응답이 "아카이브 진행 중" 배지를
 * 되돌리지 못하게 한다(started/finished 연속 발생 시 응답 역전, post-fix P4).
 *
 * null = 무시(낡은 세대). 최신 세대의 **실패**는 fail-soft로 false: 정보성
 * 배지는 미표시가 busy 고착보다 낫다.
 */
export function archBusyUpdate(
  current: number,
  mine: number,
  result: { ok: true; value: boolean } | { ok: false },
): boolean | null {
  if (current !== mine) return null;
  return result.ok ? result.value : false;
}
