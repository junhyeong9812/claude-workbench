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
import type { ClaudeTimelineEvent, TokenUsage } from "../hooks/useClaudeTimeline";

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

/** 펼쳤을 때 원격에서 본문을 가져와야 하나 (본문이 없고 데몬은 갖고 있다). */
export function shouldFetchBody(
  s: Pick<RemoteSessionMeta, "body_omitted" | "timeline_len">,
  live: RemoteLiveTimeline | undefined,
): boolean {
  if (live && (live.items.length > 0 || live.turns.length > 0)) return false;
  return s.body_omitted || s.timeline_len > 0;
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
}

/** 회수한 본문 → 라이브 타임라인 (순수). 라이브 payload 와 같은 모양으로 만든다. */
export function fetchedToLive(r: RemoteTimelineReply): RemoteLiveTimeline {
  const u = r.last_usage;
  return {
    items: [...r.items].sort((a, b) => a.seq - b.seq),
    turns: r.turns ?? [],
    answers: r.answers ?? [],
    dates: r.dates ?? [],
    tokens: r.tokens ?? [],
    model: r.model ?? null,
    ctxTokens: u ? u.input + u.cache_read + u.cache_creation : 0,
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
}

/** payload → 라이브 타임라인 (순수).
 *
 * `answers`/`dates`/`tokens`는 R2b 부터 실제로 온다. 옛 데몬은 안 보내고, 그건
 * 빈 배열로 디코드된다 — "없다"가 그 생산자의 정직한 답이다. */
export function toLiveTimeline(e: ClaudeTimelineEvent): RemoteLiveTimeline {
  const u = e.last_usage;
  return {
    items: [...e.items].sort((a, b) => a.seq - b.seq),
    turns: e.turns ?? [],
    answers: e.answers ?? [],
    dates: e.dates ?? [],
    tokens: e.tokens ?? [],
    model: e.model ?? null,
    ctxTokens: u ? u.input + u.cache_read + u.cache_creation : 0,
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

/** `remote-terminal-ended` payload — 백엔드 `RemoteTerminalEnded`. */
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
export function useRemoteHosts(pollMs = 700): {
  hosts: RemoteHostSnapshot[];
  live: Map<number, RemoteLiveTimeline>;
  fetched: Map<number, RemoteLiveTimeline>;
  fetching: ReadonlySet<number>;
  fetchError: Record<number, string>;
  fetchBody: (hostId: string, id: number) => void;
  refresh: () => void;
} {
  const [hosts, setHosts] = useState<RemoteHostSnapshot[]>([]);
  const [live, setLive] = useState<Map<number, RemoteLiveTimeline>>(new Map());
  const [fetched, setFetched] = useState<Map<number, RemoteLiveTimeline>>(new Map());
  const [fetching, setFetching] = useState<Set<number>>(new Set());
  const [fetchError, setFetchError] = useState<Record<number, string>>({});
  /** 이번 마운트에서 **라이브 이벤트가** 채운 id — 늦은 seed 가 덮지 못하게. */
  const livenedRef = useRef<Set<number>>(new Set());

  const refresh = useCallback(() => {
    void invoke<RemoteHostSnapshot[]>("remote_hosts")
      .then((v) => setHosts(v ?? []))
      .catch(() => {
        /* 커맨드 자체가 실패하면 이전 목록을 유지한다 — 빈 화면보다 낫다 */
      });
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);

  const fetchBody = useCallback((hostId: string, id: number) => {
    setFetching((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    void invoke<RemoteTimelineReply>("remote_timeline", { hostId, id })
      .then((r) => {
        setFetched((prev) => new Map(prev).set(id, fetchedToLive(r)));
        setFetchError((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      })
      .catch((e) => {
        setFetchError((prev) => ({
          ...prev,
          [id]: String((e as { message?: string })?.message ?? e),
        }));
      })
      .finally(() => {
        setFetching((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    let unClosed: UnlistenFn | undefined;
    void (async () => {
      // 리스너 **먼저**. 이벤트는 이미 붙어 있는 리스너에게만 가므로, seed 를
      // 먼저 받으면 그 왕복 동안의 이벤트가 통째로 사라진다.
      un = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
        if (!isRemoteId(e.payload.id)) return; // 로컬 세션 — 이 패널의 것이 아니다
        livenedRef.current.add(e.payload.id);
        setLive((prev) => new Map(prev).set(e.payload.id, toLiveTimeline(e.payload)));
      });
      unClosed = await listen<number>("claude-session-closed", (e) => {
        // 종료 표시는 스냅샷의 `closed`가 갖는다. 여기서는 아무것도 지우지
        // 않는다 — 마지막 내용은 남아 있어야 사용자가 읽을 수 있다.
        if (!isRemoteId(e.payload)) return;
        refresh();
      });
      if (disposed) {
        un?.();
        unClosed?.();
        un = undefined;
        unClosed = undefined;
        return;
      }
      // …그리고 **그 다음에** 지금 상태를 받아 빈 자리만 채운다. 탭을 떠났다
      // 돌아온 패널은 그동안의 이벤트를 전부 놓쳤고, 끝난 세션은 앞으로도
      // 이벤트를 내지 않는다 — seed 가 없으면 영구 빈 화면이다.
      const seed = await invoke<ClaudeTimelineEvent[]>("remote_timelines").catch(
        () => [] as ClaudeTimelineEvent[],
      );
      if (disposed) return;
      setLive((prev) =>
        mergeSeed(
          prev,
          seed.filter((p) => isRemoteId(p.id)).map((p) => ({ id: p.id, live: toLiveTimeline(p) })),
          livenedRef.current,
        ),
      );
    })();
    return () => {
      disposed = true;
      un?.();
      unClosed?.();
    };
  }, [refresh]);

  return { hosts, live, fetched, fetching, fetchError, fetchBody, refresh };
}
