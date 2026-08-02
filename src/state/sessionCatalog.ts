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
