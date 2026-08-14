/**
 * 원격 호스트(R2a) — 백엔드 스냅샷의 타입과 화면이 쓰는 순수 규칙.
 *
 * 여기에 zustand 스토어는 없다. 원격 호스트는 **연결되어 있는 동안에만** 의미가
 * 있고 앱 전역 상태가 아니라서, 패널이 열려 있는 동안만 폴링하는 훅
 * ({@link useRemoteHosts})으로 충분하다. 로컬 세션 레지스트리(claudeStatus)는
 * 절대 건드리지 않는다 — 그게 원격이 로컬 UI에 보이지 않는(=회귀 0) 이유다.
 *
 * 타임라인은 이벤트로, 연결 상태는 폴링으로 온다. 이유는 백엔드
 * `commands/remote.rs` 모듈 주석에 적혀 있다: 흐르는 것은 이미 있는 이벤트로
 * 흘리고, 연결 상태에는 대응하는 이벤트 계약이 없으니 새로 만들지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TimelineItem } from "../types";
import {
  sumTokenTotals,
  type ClaudeTimelineEvent,
  type TokenUsage,
} from "../hooks/useClaudeTimeline";
import { errText } from "../utils/error";
import {
  shouldAutoFetch,
  useAutoFetch,
  type AutoFetch,
  type Fetched,
} from "./autoFetch";

/**
 * 원격 세션 id가 시작하는 지점 — `core/src/remote/host.rs`의 `REMOTE_ID_BASE`와
 * 같은 값이어야 한다(2^40).
 *
 * 로컬 `SessionManager`의 id는 1부터 하나씩 올라가므로 이 아래로는 절대 오지
 * 않는다. 그래서 이 한 줄이 "이 `claude-timeline` 이벤트가 원격 것인가"의
 * 전부이고, 원격 패널은 로컬 세션 이벤트를 한 번도 보지 않는다.
 */
export const REMOTE_ID_BASE = 2 ** 40;

export function isRemoteId(id: number): boolean {
  return Number.isFinite(id) && id >= REMOTE_ID_BASE;
}

export type RemotePhase = "idle" | "connecting" | "live" | "reconnecting" | "failed";

export type RemoteResume =
  | { kind: "fresh" }
  | { kind: "continued"; from_seq: number }
  | { kind: "gap"; message: string };

export interface RemoteNotice {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  session: number | null;
  at_ms: number;
}

export interface RemoteSessionMeta {
  id: number;
  key: string;
  uuid: string;
  session_id: string;
  agent: string;
  cwd: string;
  label: string | null;
  state: string;
  started_at_ms: number;
  exit_code: number | null;
  signal: string | null;
  adopted: string | null;
  body_omitted: boolean;
  /** 데몬이 이 세션에 대해 갖고 있는 아이템 수(헤더). "본문 생략됨"과 "항목 0"의 차이. */
  timeline_len: number;
  turns: number;
  items: number;
  model: string | null;
  ctx_tokens: number;
  last_title: string | null;
  last_hook: string | null;
  closed: boolean;
}

export interface RemoteDaemonInfo {
  version: string;
  hostname: string;
  user: string;
  os: string;
  epoch: string;
}

export interface RemoteHostSnapshot {
  host_id: string;
  label: string;
  /** 이 연결(attach)의 식별자 — 다시 붙을 때마다 바뀐다. 백엔드 `HostSnapshot`. */
  incarnation: number;
  phase: RemotePhase;
  daemon: RemoteDaemonInfo | null;
  resume: RemoteResume | null;
  cursor: string | null;
  last_error: string | null;
  attempts: number;
  /** 아무 프레임이나 마지막으로 도착한 시각(워크벤치 시계, ms). */
  last_frame_at_ms: number | null;
  /** 데몬이 마지막 하트비트에서 알린 실행 중 세션 수. */
  running: number | null;
  sessions: RemoteSessionMeta[];
  notices: RemoteNotice[];
}

/** 연결 상태 한 줄 — 사용자가 읽는 말. */
export function phaseLabel(phase: RemotePhase): string {
  switch (phase) {
    case "live":
      return "연결됨";
    case "connecting":
      return "연결 중";
    case "reconnecting":
      return "끊김 — 다시 붙는 중";
    case "failed":
      return "연결 실패";
    default:
      return "연결 안 됨";
  }
}

/**
 * 이어받기 결과 한 줄. **"처음부터"와 "이어받음"이 같은 화면이 되면 안 된다** —
 * 그게 조용히 낡은 화면의 첫 단계다.
 */
export function resumeLabel(resume: RemoteResume | null): string | null {
  if (!resume) return null;
  if (resume.kind === "continued") return `이어받음 (seq ${resume.from_seq}부터)`;
  if (resume.kind === "fresh") return "처음부터 받음";
  return "이어받지 못해 전체를 다시 받음";
}

/** 아직 안 본 알림 — `seq`는 호스트 안에서 단조라 마지막 본 값 하나로 충분하다. */
export function unseenNotices(notices: readonly RemoteNotice[], seenSeq: number): RemoteNotice[] {
  return notices.filter((n) => n.seq > seenSeq);
}

/**
 * "여기까지 봤다"를 담아 두는 키 — **host_id 하나로는 부족하다**.
 *
 * `seq`가 단조인 것은 맞지만 그건 **한 Host 객체 안에서**다. 다시 붙으면
 * (`Registry::attach` 마다 새 Host) 카운터가 1부터 다시 시작하는데, 화면이 들고
 * 있는 seen 은 옛 연결의 값이라 새 연결의 알림이 "이미 본 것"으로 걸러진다 —
 * 갭·데몬 재시작·읽지 못한 줄까지 통째로 안 보인다. 알림 채널이 조용히 죽는
 * 것이 이 단계에서 가장 나쁜 실패다.
 *
 * 카운터 비교로는 못 막는다: 이전에 1까지 봤는데 새 연결의 첫 알림이 seq 1이면
 * **동률**이라 되감김이 아니고, 폴링 사이에 다시 붙어 옛 표시를 지나가 버리면
 * 아예 **추월**이다 — 둘 다 새 연결의 알림을 옛 표시 뒤에 영원히 숨긴다. epoch
 * 도 답이 못 된다(같은 데몬에 다시 붙으면 epoch 는 그대로). 그래서 백엔드가
 * 연결마다 새로 찍어 주는 `incarnation` 을 키에 넣는다 — 다른 연결이면 표시
 * 자체가 다른 칸이라 비교할 일이 없다.
 */
export function seenKey(h: Pick<RemoteHostSnapshot, "host_id" | "incarnation">): string {
  return `${h.host_id}#${h.incarnation}`;
}

/** 이 연결에서 어디까지 봤나 (다른 연결의 표시는 이 연결의 것이 아니다). */
export function seenSeqOf(
  h: Pick<RemoteHostSnapshot, "host_id" | "incarnation">,
  seen: Readonly<Record<string, number>>,
): number {
  return seen[seenKey(h)] ?? 0;
}

/**
 * 지금 붙어 있는 연결의 것이 아닌 표시들 — 지울 키.
 *
 * 떨어졌거나 다시 붙은 연결의 표시는 다시 쓰일 일이 없다(같은 incarnation 은
 * 다시 오지 않는다). 남겨 두면 패널이 열려 있는 동안 계속 쌓이기만 한다.
 */
export function staleSeenKeys(
  hosts: readonly RemoteHostSnapshot[],
  seen: Readonly<Record<string, number>>,
): string[] {
  const alive = new Set(hosts.map(seenKey));
  return Object.keys(seen).filter((k) => !alive.has(k));
}

/**
 * 접힌 행의 "턴 N · 항목 M".
 *
 * 끝난 세션은 데몬이 본문을 스냅샷에 싣지 않는다 — 그때 로컬 개수(0)를 그대로
 * 보이면 **"아무 일도 없었다"로 읽힌다**. 데몬이 헤더에 실어 보내는
 * `timeline_len`이 정확히 그 혼동을 막으려고 있는 값이라 그것을 쓴다.
 */
export function countsLabel(
  s: Pick<RemoteSessionMeta, "turns" | "items" | "body_omitted" | "timeline_len">,
  live?: Pick<RemoteLiveTimeline, "items" | "turns">,
): string {
  const turns = Math.max(s.turns, live?.turns.length ?? 0);
  const items = Math.max(s.items, live?.items.length ?? 0);
  if (items === 0 && s.body_omitted && s.timeline_len > 0) {
    return `턴 ${turns} · 본문 생략됨 · ${s.timeline_len}개`;
  }
  return `턴 ${turns} · 항목 ${items}`;
}

/**
 * 한 턴 옆에 붙는 **날짜 · 토큰** 한 줄. 붙일 것이 없으면 `null`.
 *
 * 데몬은 R2b 부터 `dates`·`tokens` 를 실어 보내고 소비자도 필수로 받는데
 * ({@link required}), 화면은 그 둘을 상태에 넣어 두고 **그리지 않았다** — 원격
 * 타임라인이 "로컬과 같은 내용"이 아니라던 R7 의 절반이 이것이다.
 *
 * ↑/↓ 의 정의는 로컬 게이지와 **같은 함수**({@link sumTokenTotals})에서 온다.
 * 여기서 손으로 더하면 두 화면이 같은 세션에 다른 숫자를 말하게 된다.
 */
export function turnMetaLabel(
  turn: number,
  dates: ReadonlyMap<number, string>,
  tokens: ReadonlyMap<number, TokenUsage>,
): string | null {
  const parts: string[] = [];
  const date = dates.get(turn);
  if (date) parts.push(date);
  const usage = tokens.get(turn);
  if (usage) {
    const { input, output } = sumTokenTotals([[turn, usage]]);
    if (input > 0 || output > 0) {
      parts.push(`↑${input.toLocaleString()} ↓${output.toLocaleString()}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "N개 중 최근 M개만" — 항목 목록을 잘라 그렸다는 사실. 다 보이면 `null`.
 *
 * 원격 세션 하나에 아이템이 수백 개일 수 있어 목록은 최근 몇 개만 그린다. 그
 * 상한 자체는 문제가 아니지만, **잘렸다는 말이 없으면** 사용자는 그 몇 개가
 * 세션 전부라고 읽는다 — 앞 슬라이스가 트리·git-log 잘림에 세운 규칙
 * ({@link dirCutNote} 계열)을 타임라인에도 그대로 적용한다.
 */
export function itemCutNote(total: number, shown: number): string | null {
  if (total <= shown) return null;
  return `항목 ${total}개 중 최근 ${shown}개만 보이고 있습니다.`;
}

/** 펼쳤을 때 원격에서 본문을 가져올 수 **있나** (본문이 없고 데몬은 갖고 있다). */
export function shouldFetchBody(
  s: Pick<RemoteSessionMeta, "body_omitted" | "timeline_len">,
  live: RemoteLiveTimeline | undefined,
): boolean {
  if (live && (live.items.length > 0 || live.turns.length > 0)) return false;
  return s.body_omitted || s.timeline_len > 0;
}

/**
 * 펼쳤을 때 **자동으로** 한 번 가져오나 — 두 질문의 합이다.
 *
 * ① 가져올 것이 있나({@link shouldFetchBody} — 도메인 질문) ② 자동으로 걸어도
 * 되나({@link shouldAutoFetch} — **자동 회수 원시의 잠금**). 잠금은 여기 없다:
 * 여기 두면 또 한 벌이 되고, 세 벌이 병렬로 존재하던 것이 정확히 세 번 재발한
 * 그 사고의 구조다(`autoFetch.ts` 머리말).
 *
 * ②가 없으면 회수가 **성공했는데 본문이 비었을 때** 판정이 다시 true 로 돌아온다:
 * `pickTimeline` 이 빈 값을 돌려주고 `loading` 이 true→false 로 바뀌며 effect 가
 * 재발화한다. 그 한 바퀴가 `remote_timeline` → `Registry::call` → **새 SSH 연결
 * 1회**이고 백오프도 지연도 없다(실측: 빈 세션 하나에 5초 동안 1,400회 이상).
 * `body_omitted:true, timeline_len:0`(아무것도 하지 않고 끝난 세션)은 데몬이
 * 정상적으로 내는 조합이라 이 루프는 가정이 아니라 도달 상태다.
 */
export function shouldAutoFetchBody(
  s: Pick<RemoteSessionMeta, "body_omitted" | "timeline_len">,
  live: RemoteLiveTimeline | undefined,
  body: Fetched<unknown>,
): boolean {
  if (!shouldAutoFetch(body)) return false;
  return shouldFetchBody(s, live);
}

/** `remote_timeline` 응답 — 백엔드 `RemoteTimeline`. */
export interface RemoteTimelineReply {
  session_id: string;
  total: number;
  items: TimelineItem[];
  turns: [number, string][];
  /** 라이브와 같은 셋 — 회수한 본문이 스트림보다 가난해서는 안 된다. */
  answers: [number, string][];
  dates: [number, string][];
  tokens: [number, TokenUsage][];
  model: string | null;
  last_usage: TokenUsage | null;
  /** 이 응답이 **누구의** 본문인가 — null 이면 세션 자신, 아니면 그 에이전트. */
  subagent: string | null;
  /** 세션의 에이전트 목록(메타) — 회수 한 번이 두 질문에 답한다. */
  subagents: RemoteSubagentFrame[];
}

/**
 * 생산자가 **항상** 쓰는 배열 필드 — 없으면 드러낸다.
 *
 * `?? []` 로 받으면 필드 이름이 바뀌거나 생산자가 멈춘 것이 예외가 아니라
 * **조용한 빈 타임라인**이 된다: 화면은 "아무 일도 없었다"를 정직한 답으로
 * 보이고, 아무도 계약이 깨진 줄 모른다. Rust 쪽은 이 넷(`turns`·`answers`·
 * `dates`·`tokens`)을 항상 직렬화하고 키 집합까지 테스트로 못박았으므로
 * (R2b ②: 생산자가 항상 쓰면 소비자도 필수), 여기서는 없는 것이 곧 결함이다.
 */
function required<T>(v: unknown, field: string, where: string): T[] {
  if (!Array.isArray(v)) {
    throw new Error(
      `${where}: '${field}' 가 오지 않았습니다 — 데몬/브리지 계약이 깨졌습니다(빈 타임라인으로 감추지 않습니다).`,
    );
  }
  return v as T[];
}

/**
 * 이 응답이 **내가 물어본 자리의 것인가** — 아니면 예외.
 *
 * 백엔드가 `subagent` 를 에코하는 목적이 타입 주석에 적혀 있다: *"늦은 응답이
 * 세션에 잘못 편입되는 것을 막으려고"*. 그런데 소비자가 그것을 보지 않으면
 * 오배치를 막으려고 만든 필드가 오배치를 안 막는다 — 만들어 두고 부르는 사람이
 * 0인 표면(R10)의 재발이고, 이번에는 **가장 큰 본문**이 그 위를 지난다.
 *
 * 등급은 {@link required} 와 같다: 빈 값으로 축소하지 않고 예외로 드러낸다.
 * 잘못 편입된 본문은 "틀렸다"고 말해 주는 사람이 아무도 없기 때문이다.
 */
export function expectSubagent(
  r: Pick<RemoteTimelineReply, "subagent">,
  want: string | null,
): void {
  const got = r.subagent ?? null;
  if (got === want) return;
  const where = want === null ? "세션 본문" : `서브에이전트 ${want}`;
  const came = got === null ? "세션 본문" : `서브에이전트 ${got}`;
  throw new Error(
    `${where} 를 물었는데 ${came} 의 응답이 왔습니다 — 다른 자리의 것을 여기에 편입하지 않습니다.`,
  );
}

/** 회수한 본문 → 라이브 타임라인 (순수). 라이브 payload 와 같은 모양으로 만든다. */
export function fetchedToLive(r: RemoteTimelineReply): RemoteLiveTimeline {
  const u = r.last_usage;
  const w = "회수한 원격 타임라인";
  return {
    items: [...required<TimelineItem>(r.items, "items", w)].sort((a, b) => a.seq - b.seq),
    turns: required<[number, string]>(r.turns, "turns", w),
    answers: required<[number, string]>(r.answers, "answers", w),
    dates: required<[number, string]>(r.dates, "dates", w),
    tokens: required<[number, TokenUsage]>(r.tokens, "tokens", w),
    model: r.model ?? null,
    ctxTokens: u ? u.input + u.cache_read + u.cache_creation : 0,
    subagents: required<RemoteSubagentFrame>(r.subagents, "subagents", w),
  };
}

/**
 * 화면에 그릴 타임라인 — 스트림이 준 것이 있으면 그것, 없으면 회수해 온 본문.
 *
 * 회수본을 라이브가 **비어 있을 때만** 쓰는 것이 핵심이다: 끝난 세션은 갭 뒤
 * 스냅샷마다 빈 payload 가 다시 오는데, 그걸 그대로 쓰면 사용자가 방금 일부러
 * 가져온 본문이 사라진다.
 */
export function pickTimeline(
  live: RemoteLiveTimeline | undefined,
  fetched: RemoteLiveTimeline | undefined,
): RemoteLiveTimeline | undefined {
  if (live && (live.items.length > 0 || live.turns.length > 0)) return live;
  return fetched ?? live;
}

/**
 * 늦게 도착한 seed 를 지금 상태에 합친다 — **이미 라이브 이벤트가 채운 항목은
 * 절대 덮지 않는다**(CAS).
 *
 * seed 는 커맨드 왕복이라 그 사이에 도착한 이벤트보다 항상 낡았다. 리스너를
 * 먼저 달고 seed 를 나중에 부어야 유실이 없는데, 그 순서면 seed 가 새 것을
 * 덮을 수 있다 — `livened` 가 그걸 막는다.
 */
export function mergeSeed(
  current: ReadonlyMap<number, RemoteLiveTimeline>,
  seed: readonly { id: number; live: RemoteLiveTimeline }[],
  livened: ReadonlySet<number>,
): Map<number, RemoteLiveTimeline> {
  const next = new Map(current);
  for (const s of seed) {
    if (livened.has(s.id)) continue; // 이벤트가 이미 더 새 것을 넣었다
    next.set(s.id, s.live);
  }
  return next;
}

/**
 * 들고 있는 타임라인 중 **버려도 되는** id, 그리고 이번에 안 보인 id.
 *
 * 패널이 열려 있는 동안 `live`/`fetched` 는 늘기만 했다. 항목 하나가 최대 수 KB
 * 이고 세션은 계속 생기므로, 이 프로젝트가 이미 크게 물린 클래스(웹뷰 RSS
 * 5.22GB — 원인은 payload 보유였다)를 원격 패널이 그대로 다시 만든다.
 *
 * 그런데 **끝난 세션과 사라진 세션은 다르다**. `claude-session-closed` 는 "끝났다"
 * 는 말이고 그 세션은 호스트 목록에 그대로 남는다(카드가 보이고 사용자가 마지막
 * 내용을 읽는다 — 원래 핸들러가 아무것도 안 지운 이유가 이것이다). 그래서 축은
 * 종료가 아니라 **호스트 목록에서의 부재**다: 데몬이 정리했거나 epoch 이 바뀌어
 * 주소가 무효해진 세션은 그릴 카드 자체가 없고, 회수할 주소도 없다.
 *
 * 한 번 안 보인 것으로는 지우지 않는다. 폴링 응답은 이벤트보다 낡을 수 있어서
 * (막 생긴 세션이 그 스냅샷에는 아직 없다) 첫 실종은 경합과 구별되지 않는다.
 * 연속 두 번이면 경합이 아니다.
 */
export function droppableIds(
  held: Iterable<number>,
  known: ReadonlySet<number>,
  missedBefore: ReadonlySet<number>,
): { missing: Set<number>; drop: Set<number> } {
  const missing = new Set<number>();
  const drop = new Set<number>();
  for (const id of held) {
    if (known.has(id)) continue;
    missing.add(id);
    if (missedBefore.has(id)) drop.add(id);
  }
  return { missing, drop };
}

/** 지금 어느 호스트든 목록에 올려 둔 세션 id 전부. */
export function knownSessionIds(hosts: readonly RemoteHostSnapshot[]): Set<number> {
  const out = new Set<number>();
  for (const h of hosts) for (const s of h.sessions) out.add(s.id);
  return out;
}

/**
 * 서브에이전트 본문 키({@link subagentAttemptKey})가 어느 세션의 것인가.
 *
 * 모양이 다르면 **null** 이다. 못 읽은 키에 0 을 돌려주면 세션 0 의 본문으로
 * 취급돼 엉뚱한 자리가 지워진다 — 모르면 건드리지 않는 편이 맞다.
 */
export function sessionOfSubagentKey(key: string): number | null {
  const head = key.split("/", 1)[0];
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isSafeInteger(n) ? n : null;
}

/** 이 호스트가 지금 사용자에게 알릴 게 있나 (배지 판정). */
export function noticeBadge(
  notices: readonly RemoteNotice[],
  seenSeq: number,
): { count: number; level: "info" | "warn" | "error" } | null {
  const unseen = unseenNotices(notices, seenSeq);
  if (unseen.length === 0) return null;
  const level = unseen.some((n) => n.level === "error")
    ? "error"
    : unseen.some((n) => n.level === "warn")
      ? "warn"
      : "info";
  return { count: unseen.length, level };
}

/**
 * 한 서브에이전트의 프레임 — **메타뿐이다**.
 *
 * 로컬 payload 의 `SubagentFrame` 과 같은 모양이지만 `items` 는 원격에서
 * **항상 null** 이다: 로컬은 진행 중 에이전트의 본문을 인라인으로 싣지만
 * (파일 읽기 한 번), 원격에서 같은 짓을 하면 델타마다 SSH 로 전사를 다시
 * 보내는 것이 된다 — 웹뷰 RSS 5.22GB 사고에 네트워크를 하나 더 낀 모양이다.
 * 그래서 원격은 전부 지연 회수(deferred hydration)다.
 */
export interface RemoteSubagentFrame {
  id: string;
  /** 이 에이전트를 띄운 툴콜의 `tool_call_id`. 못 찾으면 null. */
  parent: string | null;
  turn: number;
  /** 진행도 분모 — 본문이 없어도 헤더가 같은 숫자를 보인다. */
  total: number;
  completed: number;
  last_status: string | null;
  /** 본문 캐시 무효화 키(`<len>-<mtime_ns>`). 없으면 무효화할 수단이 없다. */
  sig: string | null;
  /** 원격에서는 언제나 null — "펼치면 가져와라"라는 뜻이다. */
  items: TimelineItem[] | null;
}

/**
 * 한 세션 본문의 **주소**. 자동 회수 원시의 잠금 키다.
 *
 * 가리키는 대상만 들어간다 — 호스트와 세션. 회수 결과·개수·서명은 들어가지
 * 않는다(`autoFetch.ts` 계약 1).
 */
const SEP = "\u0000";
export function sessionBodyKey(hostId: string, id: number): string {
  return `s${SEP}${hostId}${SEP}${id}`;
}

/**
 * 한 서브에이전트 본문의 **주소** — (호스트·세션·에이전트).
 *
 * **서명은 여기 없다.** 앞 판은 `${session}/${agent}#${sig}` 였고 `sig` 는 파일
 * 서명(`<len>-<mtime_ns>`)이라, **돌고 있는** 에이전트는 델타마다 전사가 자라
 * 서명이 바뀌었다 → 키가 바뀌어 `attempted` 가 초기화 → 자동 회수 재발화 →
 * 델타당 SSH 왕복 1회 + 전사 1벌 추가 상주(L2-2). 서명은 이제 값과 함께 보관돼
 * **신선도 표시**로만 쓰인다({@link isStale}).
 */
export function subagentBodyKey(hostId: string, id: number, agent: string): string {
  return `a${SEP}${hostId}${SEP}${id}${SEP}${agent}`;
}

/**
 * 이 본문 주소가 어느 세션의 것인가 — 모양이 다르면 **null**.
 *
 * 못 읽은 키에 0 을 돌려주면 세션 0 의 본문으로 취급돼 엉뚱한 자리가 지워진다.
 */
export function sessionOfBodyKey(key: string): number | null {
  const part = key.split(SEP)[2];
  if (!part || !/^\d+$/.test(part)) return null;
  const n = Number(part);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 회수해 둔 본문 옆에 붙는 신선도 한 줄 — 붙일 말이 없으면 `null`.
 *
 * **자동으로 다시 받지 않는다.** 다시 받는 판단이 화면(사람)에 있는 것이
 * 재슬라이스의 요지다: 진행 중인 에이전트는 델타마다 서명이 바뀌므로,
 * "달라졌으니 다시 받자"를 자동으로 하면 그것이 곧 델타당 SSH 왕복이다(L2-2).
 *
 * 그리고 **모르는 것을 안다고 말하지 않는다**. 서명이 한쪽이라도 없으면 바뀌었는지
 * 알 수 없는 것이지 바뀐 것이 아니다 — 없는 잘림을 지어내던 `dirCutNote`(L2-11)와
 * 같은 종류의 거짓말이라, 그때는 "확인할 수단이 없다"고 적는다.
 */
export function subagentFreshnessNote(
  cachedSig: string | null,
  frameSig: string | null,
): string | null {
  if (cachedSig !== null && frameSig !== null) {
    return cachedSig === frameSig
      ? null
      : "이 에이전트의 기록이 그 뒤에 바뀌었습니다 — 보이는 것은 이전 회수본입니다.";
  }
  return "이 기록이 그 뒤에 바뀌었는지 확인할 수단이 없습니다(서명 없음) — 보이는 것은 회수한 시점의 것입니다.";
}

/** 접힌 에이전트 행의 한 줄 — 진행도와 상태. 본문 없이 메타만으로 그린다. */
export function subagentLabel(f: RemoteSubagentFrame): string {
  const status =
    f.last_status === "completed"
      ? "완료"
      : f.last_status === "in_progress"
        ? "진행 중"
        : f.last_status === "error"
          ? "오류"
          : f.last_status === "pending"
            ? "대기"
            : "상태 미상";
  return `${f.completed}/${f.total} · ${status}`;
}

/** 한 세션의 라이브 타임라인 — `claude-timeline` payload에서 화면이 쓰는 만큼. */
export interface RemoteLiveTimeline {
  items: TimelineItem[];
  turns: [number, string][];
  /** 턴별 **답변**. R2b ⓓ 이전에는 데몬이 계산해 놓고 버렸고, 그 뒤에는 데몬이
   * 실어 보내는데 여기서 버렸다 — 두 경우 모두 화면에는 질문만 남았다. */
  answers: [number, string][];
  dates: [number, string][];
  tokens: [number, TokenUsage][];
  model: string | null;
  ctxTokens: number;
  /** 이 세션의 서브에이전트 — 메타만. 본문은 {@link RemoteSubagentFrame} 참조. */
  subagents: RemoteSubagentFrame[];
}

/** payload → 라이브 타임라인 (순수).
 *
 * `answers`/`dates`/`tokens` 는 생산자가 **항상** 쓴다(빈 배열이라도). 그래서
 * 여기서도 필수다 — 안 온 것은 "없다"가 아니라 계약이 깨진 것이고,
 * {@link required} 가 그것을 예외로 드러낸다. */
export function toLiveTimeline(e: ClaudeTimelineEvent): RemoteLiveTimeline {
  const u = e.last_usage;
  const w = "원격 타임라인 payload";
  return {
    items: [...required<TimelineItem>(e.items, "items", w)].sort((a, b) => a.seq - b.seq),
    turns: required<[number, string]>(e.turns, "turns", w),
    answers: required<[number, string]>(e.answers, "answers", w),
    dates: required<[number, string]>(e.dates, "dates", w),
    tokens: required<[number, TokenUsage]>(e.tokens, "tokens", w),
    model: e.model ?? null,
    ctxTokens: u ? u.input + u.cache_read + u.cache_creation : 0,
    // 생산자가 항상 쓴다(빈 배열이라도) — 그래서 필수다. `?? []` 로 받으면
    // "에이전트를 안 돌렸다"와 "계약이 깨졌다"가 같은 화면이 되고, 그 동일시가
    // 정확히 R7 이 지적한 결함이다.
    subagents: required<RemoteSubagentFrame>(e.subagents, "subagents", w),
  };
}

// ---------------------------------------------------------------------------
// R2b — 제어(스폰·종료·터미널)의 판단들. 전부 순수 함수다: 버튼이 무엇을 해도
// 되는지, 크기를 언제 원격까지 보내는지, 끝난 이유를 뭐라고 말하는지가 여기
// 있고 컴포넌트에는 배선만 남는다.
// ---------------------------------------------------------------------------

/** 버튼 한 개의 상태 — 왜 눌리지 않는지까지 같이 말한다(비활성 이유 없는 회색
 * 버튼이 이 패널에서 가장 흔한 "조용한 손실"이다). */
export interface ControlGate {
  enabled: boolean;
  hint: string;
}

/** `종료` 버튼. 이미 끝난 세션에 신호를 보내면 데몬이 거절할 뿐이라 막는다. */
export function killGate(
  s: Pick<RemoteSessionMeta, "state" | "closed">,
  pending: boolean,
): ControlGate {
  if (s.closed || s.state === "exited") {
    return { enabled: false, hint: "이미 끝난 세션입니다." };
  }
  if (pending) return { enabled: false, hint: "요청을 보내는 중…" };
  return { enabled: true, hint: "이 세션에 종료 신호를 보냅니다." };
}

/** `터미널` 버튼. 끝난 세션에는 붙을 pty가 없다 — 붙였다면 검은 화면 하나가
 * 늘 뿐이고, 그 세션의 내용은 행을 펼쳐 보는 쪽이 정본이다. */
export function attachGate(
  s: Pick<RemoteSessionMeta, "state" | "closed">,
  pending: boolean,
  shown: boolean,
): ControlGate {
  if (s.closed || s.state === "exited") {
    return { enabled: false, hint: "끝난 세션은 터미널을 열 수 없습니다 — 행을 펼쳐 보세요." };
  }
  if (shown) return { enabled: false, hint: "이미 아래에 열려 있습니다." };
  if (pending) return { enabled: false, hint: "터미널을 여는 중…" };
  return { enabled: true, hint: "이 세션의 화면을 아래에 엽니다." };
}

/**
 * 호스트에 **직접 물어본** 세션 수와 화면이 아는 수를 나란히 놓는 한 줄.
 *
 * 빈 목록은 두 가지를 동시에 뜻한다 — 호스트에 아무것도 안 돌거나, 이 워크벤치가
 * 놓쳤거나. 사용자가 해야 할 일이 정반대인데 화면은 같다. `remote_sessions` 는
 * 스트림을 거치지 않고 데몬에 묻는 유일한 경로라 그 둘을 가른다.
 *
 * 어느 쪽이 옳다고 말하지 않는다. 말할 수 있는 것은 두 숫자가 다르다는 사실과
 * 각각이 무엇인지뿐이고, 그 이상은 이 화면이 알 수 없다.
 */
export function sessionCountNote(daemon: number, shown: number): string {
  if (daemon === shown) {
    return `호스트가 지금 답한 세션 ${daemon}개 — 이 화면이 아는 수와 같습니다.`;
  }
  return `호스트는 세션 ${daemon}개라고 답했고 이 화면은 ${shown}개를 알고 있습니다 — 스트림이 뒤처졌거나 놓친 프레임이 있습니다(다시 붙으면 전체를 새로 받습니다).`;
}

/** 데몬이 발행하는 에이전트 홈 하나 — `remote_accounts` 응답의 한 줄. */
export interface RemoteAccount {
  id: string;
  agent: string | null;
  displayName: string;
  home: string | null;
  isDefault: boolean;
}

/**
 * `remote_accounts` 응답 → 계정 목록.
 *
 * 백엔드가 데몬의 JSON을 그대로 넘겨주므로(스키마 고정 없음) 여기서 읽는다.
 * **id 없는 줄은 버린다** — 스폰에 실제로 넣을 수 있는 것은 id뿐이고, 화면에만
 * 보이고 고를 수 없는 줄은 사용자를 속인다.
 */
export function parseAccounts(v: unknown): RemoteAccount[] {
  const raw = (v as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(raw)) return [];
  const out: RemoteAccount[] = [];
  for (const e of raw) {
    const o = e as Record<string, unknown> | null;
    const id = typeof o?.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    const display = typeof o?.display_name === "string" ? o.display_name.trim() : "";
    out.push({
      id,
      agent: typeof o?.agent === "string" ? o.agent : null,
      displayName: display || id,
      home: typeof o?.home === "string" ? o.home : null,
      isDefault: o?.is_default === true,
    });
  }
  return out;
}

/** 이 에이전트로 고를 수 있는 계정 — 에이전트가 적힌 계정은 그 에이전트에서만. */
export function accountChoices(
  accounts: readonly RemoteAccount[],
  agent: string,
): RemoteAccount[] {
  return accounts.filter((a) => a.agent == null || a.agent === agent);
}

/** 처음 선택될 계정 id (`is_default` → 첫 줄 → 없음=데몬 기본값). */
export function defaultAccountId(accounts: readonly RemoteAccount[], agent: string): string {
  const choices = accountChoices(accounts, agent);
  return (choices.find((a) => a.isDefault) ?? choices[0])?.id ?? "";
}

/** 새 세션 폼이 들고 있는 것 전부. 경로를 직접 넣는 칸은 **없다**(계정 참조). */
export interface SpawnForm {
  agent: string;
  cwd: string;
  /** 계정 **id**. 빈 문자열 = 데몬 기본 계정. */
  account: string;
  label: string;
}

/** `remote_spawn` 에 그대로 넘길 인자 (camelCase = 브리지 계약). */
export interface SpawnArgs {
  hostId: string;
  agent: string;
  cwd: string;
  account: string | null;
  label: string | null;
}

/** 새 세션을 만들 수 있는 에이전트 — 데몬의 `--agent` 가 아는 값. */
export const SPAWN_AGENTS = ["claude", "codex"] as const;

/**
 * 폼 → 스폰 인자, 또는 사용자가 읽을 거절 사유.
 *
 * 계정은 **목록에 있는 id 여야 한다**. 경로를 타이핑해 넣을 수 있으면 계정
 * 목록은 장식이 되고, 데몬이 경로 필드를 일부러 없앤(R1b) 이유가 프런트에서
 * 되살아난다 — 그래서 아는 id 가 아니면 여기서 막는다.
 *
 * cwd 는 절대 경로만 받는다. 상대 경로는 데몬의 작업 디렉터리 기준으로 조용히
 * 해석되어, 사용자가 의도한 곳이 아닌 데서 에이전트가 돌기 시작한다.
 */
export function spawnRequest(
  hostId: string,
  form: SpawnForm,
  knownAccountIds: readonly string[],
): { ok: true; args: SpawnArgs } | { ok: false; error: string } {
  if (!hostId) return { ok: false, error: "호스트를 알 수 없습니다." };
  const agent = form.agent.trim();
  if (!(SPAWN_AGENTS as readonly string[]).includes(agent)) {
    return { ok: false, error: "에이전트는 claude 또는 codex 여야 합니다." };
  }
  const cwd = form.cwd.trim();
  if (!cwd) return { ok: false, error: "원격 작업 디렉터리를 입력하세요." };
  if (!cwd.startsWith("/")) {
    return {
      ok: false,
      error: "원격 작업 디렉터리는 절대 경로여야 합니다 (예: /home/me/project).",
    };
  }
  const account = form.account.trim();
  if (account && !knownAccountIds.includes(account)) {
    return { ok: false, error: "계정 목록에 없는 계정입니다 — 목록에서 고르세요." };
  }
  const label = form.label.trim();
  return {
    ok: true,
    args: { hostId, agent, cwd, account: account || null, label: label || null },
  };
}

/** 크기가 멎었다고 보는 시간 — `remote_resize` 는 SSH 왕복 한 번이다. */
export const REMOTE_RESIZE_DEBOUNCE_MS = 250;

export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * 이 크기를 **원격 pty 까지** 보내야 하나.
 *
 * 두 가지를 막는다. 하나는 퇴화 크기: 호스트가 0px 로 접히면 FitAddon 이 2×1 을
 * 주는데, 그대로 보내면 전체화면 TUI 가 실제로 2×1 로 리사이즈되어 원격 화면이
 * 부서진다(로컬 터미널의 같은 백스톱). 다른 하나는 같은 값의 재전송 —
 * 드래그 한 번이 왕복 수십 번이 되는 것을 막는다.
 */
export function shouldSendRemoteResize(last: TermSize | null, next: TermSize): boolean {
  if (!Number.isInteger(next.cols) || !Number.isInteger(next.rows)) return false;
  if (next.cols < 10 || next.rows < 3) return false;
  if (last && last.cols === next.cols && last.rows === next.rows) return false;
  return true;
}

/**
 * 원격 리사이즈의 기준선 — **보낸 것이 아니라 확인된 것**.
 *
 * `acked` 는 데몬이 답한 크기, `inFlight` 는 답을 기다리는 요청이다. 둘을 나눠
 * 두는 이유가 이 함수의 전부다:
 *
 * - 요청을 보내면서 곧바로 "마지막 크기"를 그 값으로 적으면, **실패한 리사이즈가
 *   그 크기를 영구히 봉인한다** — 사용자가 창을 되돌려 같은 크기로 맞춰도
 *   중복이라며 걸러지고, 원격 pty 는 틀린 크기에 남는다. 실패는 `acked` 를
 *   건드리지 않으므로 다음 시도가 다시 나간다.
 * - 답을 기다리는 동안 같은 크기가 또 멎어도 왕복을 두 번 하지는 않는다.
 */
export function nextRemoteResize(
  state: { acked: TermSize | null; inFlight: TermSize | null },
  next: TermSize,
): boolean {
  return shouldSendRemoteResize(state.inFlight ?? state.acked, next);
}

/** 흔한 신호의 이름 — 숫자만 보이면 사용자가 무엇이 전달됐는지 알 수 없다. */
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  9: "SIGKILL",
  15: "SIGTERM",
};

/** `종료` 버튼이 요청하는 신호 — 에이전트에게 정리할 틈을 준다. */
export const KILL_SIGNAL = 15;

export function signalLabel(n: number): string {
  const name = SIGNAL_NAMES[n];
  return name ? `${name}(${n})` : `신호 ${n}`;
}

/**
 * 종료 요청의 결과 한 줄 — **전달된 신호를 말한다**.
 *
 * 데몬은 프로세스 그룹이 이미 사라졌으면 요청한 신호 대신 `SIGHUP` 을 보내고
 * 그 사실을 응답에 담는다. 요청한 값을 그대로 되읽으면 화면은 일어나지 않은 일을
 * 말하게 된다.
 */
export function killLabel(requested: number | null, delivered: number): string {
  if (requested == null || requested === delivered) {
    return `종료 신호를 보냈습니다 — ${signalLabel(delivered)}`;
  }
  return `${signalLabel(requested)} 를 요청했지만 실제로 전달된 것은 ${signalLabel(delivered)} 입니다`;
}

/** `remote_terminal_end` 응답 — 백엔드 `RemoteTerminalEnded`. */
export interface RemoteTerminalEnded {
  /** **로컬** 세션 id (`remote_attach` 가 돌려준 것). */
  id: number;
  host_id: string;
  code: number | null;
  signal: string | null;
  detail: string;
}

/** 한 줄에 실을 수 있는 사유 길이 — 원격 stderr 는 4KB 까지 온다. */
const DETAIL_MAX = 300;

/**
 * 원격 터미널이 멈춘 이유 한 줄.
 *
 * 이 이벤트가 따로 있는 이유가 그대로 이 함수의 이유다: "에이전트가 끝났다"와
 * "`cwcd attach` 가 거절당했다"는 화면에서 똑같이 조용한 검은 상자로 끝난다.
 * 그래서 **빈 문자열을 절대 돌려주지 않는다** — 사유가 없으면 없다고 말한다.
 */
export function endedReason(
  e: Pick<RemoteTerminalEnded, "code" | "signal" | "detail">,
): string {
  const detail = (e.detail ?? "").replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);
  let head: string;
  if (e.signal) head = `원격 터미널이 신호 ${e.signal} 로 끝났습니다`;
  else if (e.code === 0) head = "원격 터미널이 정상 종료되었습니다 (exit 0)";
  else if (e.code != null) head = `원격 터미널이 exit ${e.code} 로 끝났습니다`;
  else head = "원격 터미널이 끊겼습니다";
  if (detail) return `${head} — ${detail}`;
  if (e.signal == null && e.code == null) return `${head} — 사유를 알 수 없습니다`;
  return head;
}

/**
 * 호스트 목록을 주기 조회하고, 원격 세션의 `claude-timeline`을 모은다.
 *
 * 폴링은 패널이 떠 있는 동안만 돈다. 이벤트 구독은 **원격 id 범위만** 통과시켜
 * 로컬 세션 이벤트를 한 번도 만지지 않는다.
 */
export interface RemoteHostsView {
  hosts: RemoteHostSnapshot[];
  live: Map<number, RemoteLiveTimeline>;
  /**
   * 회수해 둔 **세션 본문** — 주소는 {@link sessionBodyKey}.
   *
   * 값·오류·진행·시도가 한 칸에 같이 있다. 앞 판은 그 넷이 서로 다른 네 개의
   * 컬렉션(`fetched`·`fetching`·`attempted`·`fetchError`)에 흩어져 있었고, 정리
   * 경로가 그중 셋만 치우면 나머지 하나가 조용히 남았다.
   */
  bodies: AutoFetch<RemoteLiveTimeline>;
  /** 회수해 둔 **서브에이전트 본문** — 주소는 {@link subagentBodyKey}. */
  agentBodies: AutoFetch<TimelineItem[]>;
  /** 호스트 목록 조회가 실패한 사유. 성공하면 지워진다. */
  hostsError: string | null;
  /** 목록이 마지막으로 **성공한** 시각(ms) — 화면이 얼마나 낡았는지. */
  hostsAt: number | null;
  /** 이벤트 구독·해독이 실패한 사유(구독 자체 실패 포함). */
  streamError: string | null;
  /** 지금 상태 seed 조회가 실패한 사유 — 빈 배열로 축소하지 않는다. */
  seedError: string | null;
  fetchBody: (hostId: string, id: number) => void;
  fetchSubagentBody: (hostId: string, id: number, f: RemoteSubagentFrame) => void;
  /** 구독+seed 를 다시 세운다(구독 실패·seed 실패의 재시도). */
  retryStream: () => void;
  refresh: () => void;
}

export function useRemoteHosts(pollMs = 700): RemoteHostsView {
  const [hosts, setHosts] = useState<RemoteHostSnapshot[]>([]);
  const [live, setLive] = useState<Map<number, RemoteLiveTimeline>>(new Map());
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [hostsAt, setHostsAt] = useState<number | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [streamNonce, setStreamNonce] = useState(0);
  /** 이번 마운트에서 **라이브 이벤트가** 채운 id — 늦은 seed 가 덮지 못하게. */
  const livenedRef = useRef<Set<number>>(new Set());

  // 회수는 전부 하나의 원시를 지난다(`autoFetch.ts`). 잠금(=시도)·in-flight
  // 합치기·세대 교체·캐시 교체 규칙이 거기 한 곳에 있고, 여기 남은 것은 **주소를
  // 어떻게 쓰나**와 **응답을 어떻게 검증하나**뿐이다.
  const bodies = useAutoFetch<RemoteLiveTimeline>();
  const agentBodies = useAutoFetch<TimelineItem[]>();

  /**
   * 지금 들고 있는 것의 거울 — 정리 판정이 렌더 밖에서 읽는다.
   *
   * 상태를 updater 안에서 읽으면서 그 안에 부수효과(연속 실종 표시)를 두면
   * StrictMode 의 이중 호출에 무너진다. 판정은 effect 에서 한 번, 적용만
   * updater 로.
   */
  const liveRef = useRef(live);
  liveRef.current = live;
  const bodyMapRef = useRef(bodies.entries);
  bodyMapRef.current = bodies.entries;
  const agentMapRef = useRef(agentBodies.entries);
  agentMapRef.current = agentBodies.entries;
  /** 직전 폴링에서 목록에 없던 id — 연속 두 번이라야 지운다. */
  const missingRef = useRef<Set<number>>(new Set());

  /**
   * 목록 조회의 **요청 세대** — 늦게 온 낡은 답은 적용하지 않는다.
   *
   * 정리 규칙("연속 두 폴링에서 안 보이면 지운다")이 세는 것은 *요청* 순서여야
   * 한다. 완료 순서로 세면, 세션이 생기기 전에 나간 요청 둘이 늦게 잇달아
   * 답하는 것만으로 **살아 있는 세션의 payload 가 지워진다**(L2-8). 응답을 요청
   * 순서로만 적용하면 그 상황 자체가 성립하지 않는다.
   */
  const askSeq = useRef(0);
  const appliedSeq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++askSeq.current;
    void invoke<RemoteHostSnapshot[]>("remote_hosts")
      .then((v) => {
        if (mine <= appliedSeq.current) return; // 더 새 답이 이미 적용됐다
        appliedSeq.current = mine;
        setHosts(v ?? []);
        setHostsAt(Date.now());
        setHostsError(null);
      })
      .catch((e) => {
        // 이전 목록은 그대로 두되(빈 화면보다 낫다) **조용히** 두지는 않는다 —
        // 말없이 유지된 목록은 "지금 이렇다"로 읽히고, 그게 낡은 화면의 첫 단계다.
        setHostsError(errText(e, "호스트 목록을 읽지 못했습니다."));
      });
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);

  const forgetBodies = bodies.forget;
  const forgetAgents = agentBodies.forget;

  /**
   * 호스트 목록이 새로 올 때마다, 그 목록에 더는 없는 세션의 자리를 치운다.
   *
   * `hosts` 는 폴링이 **성공**할 때만 새 배열이 된다 — 실패하면 이전 목록이
   * 그대로 남고(그리고 화면이 그 사실을 말한다), 이 effect 도 돌지 않는다.
   * 낡은 목록을 근거로 지우지 않는다는 뜻이다.
   *
   * 들고 있는 것(`held`)은 **회수해 둔 본문까지 포함해 매번 다시 센다**. 앞 판은
   * `live`/`fetched` 만 셌는데, 드롭 시점에 나가 있던 회수가 뒤늦게 본문을 되넣으면
   * 그 세션 id 는 더 이상 held 가 아니라 **두 번 다시 drop 대상이 안 됐다** —
   * 가장 큰 payload 가 영구 상주(L2-9). 이제 축은 오직 "`known` 에 없다"이다.
   */
  useEffect(() => {
    const known = knownSessionIds(hosts);
    const held = new Set<number>(liveRef.current.keys());
    const owners = (keys: Iterable<string>) => {
      const out = new Map<number, string[]>();
      for (const k of keys) {
        const id = sessionOfBodyKey(k);
        if (id == null) continue;
        held.add(id);
        out.set(id, [...(out.get(id) ?? []), k]);
      }
      return out;
    };
    const bodyOwners = owners(bodyMapRef.current.keys());
    const agentOwners = owners(agentMapRef.current.keys());
    const { missing, drop } = droppableIds(held, known, missingRef.current);
    missingRef.current = missing;
    if (drop.size === 0) return;
    setLive((m) => {
      const next = new Map(m);
      for (const id of drop) next.delete(id);
      return next;
    });
    for (const id of drop) livenedRef.current.delete(id);
    const keysOf = (owned: Map<number, string[]>) =>
      [...drop].flatMap((id) => owned.get(id) ?? []);
    // 버리면 세대가 올라가므로, 지금 나가 있는 회수의 늦은 답도 이 자리를 다시
    // 차지하지 못한다(L2-9).
    forgetBodies(keysOf(bodyOwners));
    forgetAgents(keysOf(agentOwners));
  }, [hosts, forgetAgents, forgetBodies]);

  const retryStream = useCallback(() => setStreamNonce((n) => n + 1), []);

  const fetchBody = useCallback(
    (hostId: string, id: number) => {
      bodies.run({
        key: sessionBodyKey(hostId, id),
        fallback: "본문을 가져오지 못했습니다.",
        call: async () => {
          const r = await invoke<RemoteTimelineReply>("remote_timeline", { hostId, id });
          expectSubagent(r, null);
          return fetchedToLive(r);
        },
      });
    },
    [bodies],
  );

  /**
   * 한 서브에이전트의 본문을 회수한다 — deferred hydration 의 당기는 쪽.
   *
   * 주소는 (호스트·세션·에이전트)뿐이고 **서명은 값에 붙는다**. 그래서 돌고 있는
   * 에이전트의 델타가 아무리 와도 자동 회수는 한 번이고, 새 서명으로 받아 오면
   * 옛 벌을 교체한다(누적 0).
   */
  const fetchSubagentBody = useCallback(
    (hostId: string, id: number, f: RemoteSubagentFrame) => {
      agentBodies.run({
        key: subagentBodyKey(hostId, id, f.id),
        sig: f.sig,
        fallback: "서브에이전트 본문을 가져오지 못했습니다.",
        call: async () => {
          const r = await invoke<RemoteTimelineReply>("remote_timeline", {
            hostId,
            id,
            subagent: f.id,
          });
          expectSubagent(r, f.id);
          // 여기도 `?? []` 가 아니다(R12): 가장 큰 본문을 나르는 경로에서 계약이
          // 깨진 것이 "기록이 비어 있습니다"로 도착하면 아무도 모른다.
          return required<TimelineItem>(r.items, "items", "회수한 서브에이전트 본문");
        },
      });
    },
    [agentBodies],
  );

  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    let unClosed: UnlistenFn | undefined;
    void (async () => {
      try {
        // 리스너 **먼저**. 이벤트는 이미 붙어 있는 리스너에게만 가므로, seed 를
        // 먼저 받으면 그 왕복 동안의 이벤트가 통째로 사라진다.
        un = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
          if (!isRemoteId(e.payload.id)) return; // 로컬 세션 — 이 패널의 것이 아니다
          livenedRef.current.add(e.payload.id);
          try {
            const next = toLiveTimeline(e.payload);
            setLive((prev) => new Map(prev).set(e.payload.id, next));
            setStreamError(null);
          } catch (err) {
            // 계약이 깨진 payload — 빈 타임라인으로 감추지 않는다(R12).
            setStreamError(errText(err, "원격 타임라인을 읽지 못했습니다."));
          }
        });
        unClosed = await listen<number>("claude-session-closed", (e) => {
          // 종료 표시는 스냅샷의 `closed`가 갖는다. 여기서는 아무것도 지우지
          // 않는다 — 마지막 내용은 남아 있어야 사용자가 읽을 수 있고, 끝난
          // 세션은 **목록에 그대로 남는다**(데몬이 정리하기 전까지). 자리를
          // 치우는 축은 종료가 아니라 목록에서의 부재다({@link droppableIds}).
          if (!isRemoteId(e.payload)) return;
          refresh();
        });
      } catch (e) {
        // 구독 자체가 실패했다. 잡지 않으면 unhandled rejection 하나와 **빈
        // 화면**만 남고, 이 패널은 앞으로 어떤 이벤트도 받지 못한다(R18).
        if (!disposed) setStreamError(errText(e, "원격 이벤트를 구독하지 못했습니다."));
        un?.();
        unClosed?.();
        return;
      }
      if (disposed) {
        un?.();
        unClosed?.();
        un = undefined;
        unClosed = undefined;
        return;
      }
      setStreamError(null);
      // …그리고 **그 다음에** 지금 상태를 받아 빈 자리만 채운다. 탭을 떠났다
      // 돌아온 패널은 그동안의 이벤트를 전부 놓쳤고, 끝난 세션은 앞으로도
      // 이벤트를 내지 않는다 — seed 가 없으면 영구 빈 화면이다. 그래서 실패를
      // 빈 배열로 축소하지 않는다: 그 축소가 곧 "영구 빈 화면"이고, 화면은 그것을
      // 정상으로 읽는다.
      let seed: ClaudeTimelineEvent[];
      try {
        seed = await invoke<ClaudeTimelineEvent[]>("remote_timelines");
      } catch (e) {
        if (!disposed) setSeedError(errText(e, "지금 상태를 받아오지 못했습니다."));
        return;
      }
      if (disposed) return;
      try {
        const merged = seed
          .filter((p) => isRemoteId(p.id))
          .map((p) => ({ id: p.id, live: toLiveTimeline(p) }));
        setLive((prev) => mergeSeed(prev, merged, livenedRef.current));
        setSeedError(null);
      } catch (e) {
        setSeedError(errText(e, "받아온 상태를 읽지 못했습니다."));
      }
    })();
    return () => {
      disposed = true;
      un?.();
      unClosed?.();
    };
  }, [refresh, streamNonce]);

  return {
    hosts,
    live,
    bodies,
    agentBodies,
    hostsError,
    hostsAt,
    streamError,
    seedError,
    fetchBody,
    fetchSubagentBody,
    retryStream,
    refresh,
  };
}
