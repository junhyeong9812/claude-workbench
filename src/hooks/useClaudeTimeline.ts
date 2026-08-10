/**
 * Claude 세션 타임라인 **데이터 공급** — ClaudeTermPanel에서 순수 이동한 훅.
 *
 * TimelineView는 완전 presentational이라 props만 채우면 어디든 붙지만, 그 props를
 * 만드는 구독(JSONL tail → `claude-timeline` 이벤트 → 상태)은 ClaudeTermPanel의
 * 마운트 이펙트 안에만 있었다. 우측 단발성 peek 패널이 같은 세션의 타임라인을
 * 보려면 그 공급부가 둘 다에서 쓸 수 있어야 한다:
 *
 * - {@link useTimelineState} — 상태 + `applySnapshot` 만 소유(구독 배선 없음).
 *   ClaudeTermPanel이 쓴다: 이벤트 리스너·PTY 수명은 기존 마운트 이펙트가 그대로
 *   들고 있고(순서 계약 보존), 상태 갱신만 이 훅에 위임한다 — **렌더 등가**.
 * - {@link useClaudeTimeline} — uuid만 아는 소비자(peek)를 위한 완제품. 숫자 PTY
 *   id는 이벤트 payload에만 있으므로 기존 레지스트리(claudeStatus)로 역매핑해
 *   자기 세션 이벤트만 고르고, 스냅샷으로 초기 화면을 시드한다.
 *
 * peek는 attention 배지(updateFromTimeline)를 **건드리지 않는다** — 배지 갱신은
 * 정확한 `seenNow`를 아는 소유 패널(ClaudeTermPanel) 몫이라, 그 훅 인자(onApply)로만
 * 주입된다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TimelineItem } from "../types";
import { lookupSessionId, lookupSessionUuid } from "../state/claudeStatus";

export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

/** Full timeline snapshot for this session (the backend re-sends the whole
 * modest state on any change), so plain Q&A turns show too, not just tools. */
export interface ClaudeTimelineEvent {
  id: number;
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
  dates: [number, string][];
  tokens: [number, TokenUsage][];
  /** Current assistant model id (sizes the context-window gauge), or null. */
  model?: string | null;
  /** Most recent assistant message's usage = current context occupancy (gauge
   * numerator), distinct from `tokens` which sums a turn's tool round-trips. */
  last_usage?: TokenUsage | null;
  /** 서브에이전트 프레임(발견 순서) — 완료 에이전트는 본문 없이 메타만 온다. */
  subagents: SubagentFrame[];
}

/**
 * payload의 서브에이전트 프레임 (백엔드 `SubagentFrame`과 1:1).
 *
 * 메모리 1단계(2026-08-10): 완료 에이전트의 items를 매 emit마다 다시 싣던 것이
 * payload 24.8MB 중 19.2MB(77%)였다. 이제 **완료 프레임은 `items: null`**로 오고,
 * 본문은 사용자가 그룹을 펼칠 때 `claude_subagent_items`로 조회한다. 헤더가
 * 보여주던 진행도·상태는 메타(`total`/`completed`/`last_status`)로 그대로 나온다.
 */
export interface SubagentFrame {
  id: string;
  /** 이 에이전트를 스폰한 Agent 툴콜(트리 부모). null이면 `turn` 밑에 붙는다. */
  parent: string | null;
  turn: number;
  /** 아이템 수(진행도 분모) — 본문이 없어도 헤더는 같은 값을 보인다. */
  total: number;
  /** completed 아이템 수(진행도 분자). */
  completed: number;
  /** 마지막 아이템 상태 — 본문 없이도 "진행 중" 표시가 동일하다. */
  last_status: string | null;
  /** 본문 캐시 무효화 키 = 백엔드 파일 서명 문자열(AA2). 완료 에이전트가
   * 재활성→재구축→재완료로 transcript가 바뀌면 서명이 달라져 낡은 lazy 본문을
   * 버린다. revision 합은 재구축 시 리셋돼 같은 합·다른 내용을 낼 수 있었다.
   * 활성 프레임(items 인라인)은 서명이 필요 없어 null. */
  sig: string | null;
  /** 활성 프레임의 본문. 완료 프레임은 null = "펼칠 때 조회하라". */
  items: TimelineItem[] | null;
}

/** lazy 본문 캐시의 한 칸. `sig`는 그 본문이 어느 프레임 버전의 것인지 —
 * 프레임의 sig(파일 서명)가 달라지면(재활성 후 재완료) stale이므로 버린다. */
export type LazyAgentEntry =
  | { state: "loading"; sig: string | null }
  | { state: "ready"; sig: string | null; items: TimelineItem[] }
  | { state: "error"; sig: string | null };

/** 뷰가 실제로 그리는 서브에이전트 — 프레임(메타) + 본문 도착 상태. */
export interface SubagentView {
  id: string;
  parent: string | null;
  turn: number;
  total: number;
  completed: number;
  lastStatus: string | null;
  /** 본문(미도착이면 빈 배열 — `loaded`로 구분한다). */
  items: TimelineItem[];
  /** 본문 확보됨(활성 프레임은 항상 true). */
  loaded: boolean;
  /** lazy 조회 진행 중 — 뷰는 "불러오는 중"을 보인다. */
  loading: boolean;
  /** lazy 조회 실패 — 뷰는 재시도를 제공한다(무음 금지). */
  failed: boolean;
}

/** 프레임 + lazy 캐시 → 뷰 모델 (순수). 활성 프레임은 payload 본문을 그대로
 * 쓰고, 완료 프레임은 **rev가 일치하는** 캐시만 인정한다 — rev가 어긋난
 * 캐시(재활성 후 재완료)는 없는 것으로 친다(낡은 본문 표시 금지). */
export function mergeSubagents(
  frames: readonly SubagentFrame[],
  cache: ReadonlyMap<string, LazyAgentEntry>,
): SubagentView[] {
  return frames.map((f) => {
    const meta = {
      id: f.id,
      parent: f.parent,
      turn: f.turn,
      total: f.total,
      completed: f.completed,
      lastStatus: f.last_status ?? null,
    };
    if (f.items != null) {
      return { ...meta, items: f.items, loaded: true, loading: false, failed: false };
    }
    const e = cache.get(f.id);
    // AA2: 파일 서명이 일치하는 캐시만 fresh — 재활성→재완료로 서명이 바뀐
    // 프레임의 낡은 본문은 없는 것으로 친다(낡은 표시 금지).
    const fresh = e && e.sig === f.sig ? e : undefined;
    return {
      ...meta,
      items: fresh?.state === "ready" ? fresh.items : [],
      loaded: fresh?.state === "ready",
      loading: fresh?.state === "loading",
      failed: fresh?.state === "error",
    };
  });
}

/**
 * 인라인으로 받은 본문을 lazy 캐시에 넣는다 (순수) — 활성 프레임 전용.
 *
 * 왜 필요한가: 서브에이전트는 60초 무변화로 **완료 전이**한다. 그 순간 payload는
 * 그 프레임을 메타만으로 바꾸므로, 방금까지 보고 있던 그룹의 행들과 (그 안의
 * 아이템을 선택 중이었다면) 상세 뷰어가 조용히 비어 버린다. 활성일 때 이미
 * 받아 둔 본문을 캐시에 남겨 두면 전이가 표시에 전혀 보이지 않는다 — 완료
 * 시점에 items가 변하지 않으므로 `rev`도 그대로라 캐시가 그대로 유효하다.
 *
 * 보유량: 이 패널이 **살아서 지켜본** 에이전트의 본문뿐(= 변경 전과 동일).
 * 절감의 본체는 "매 emit 재전송"을 없앤 것이지 보유를 줄인 게 아니다.
 * 변화가 없으면 같은 Map을 그대로 돌려준다(불필요한 재렌더 방지).
 */
export function adoptInlineBodies(
  frames: readonly SubagentFrame[],
  cache: ReadonlyMap<string, LazyAgentEntry>,
): Map<string, LazyAgentEntry> | ReadonlyMap<string, LazyAgentEntry> {
  let next: Map<string, LazyAgentEntry> | null = null;
  for (const f of frames) {
    if (f.items == null) continue;
    // 활성 프레임의 서명은 이번 틱의 파일 서명(백엔드 active_sig) — 완료 안정
    // 구간엔 값이 고정이라, 활성일 때 승계해 둔 본문이 완료 전이(items=null,
    // 같은 서명) 후에도 fresh로 인정된다(전이 시 깜빡임 없음).
    const cur = cache.get(f.id);
    if (cur && cur.state === "ready" && cur.sig === f.sig) continue;
    next ??= new Map(cache);
    next.set(f.id, { state: "ready", sig: f.sig, items: f.items });
  }
  return next ?? cache;
}

/** lazy 조회 응답을 캐시에 반영해도 되나 (순수 — AA3 CAS + BB3). 늦게 도착한
 * 응답이 그 사이 발주된 더 새 요청(승계·재조회)·세션 전환·**재활성(서명 변화)** 을
 * 덮으면 미도착 회귀나 낡은 본문 표시가 생긴다. 셋 다 발주 시점과 같을 때만
 * 반영한다:
 * - `latestReq === myReq`: 이 에이전트의 최신 요청이 아직 나(새 조회가 앞지르지 않음).
 * - `currentUuid === myUuid`: 세션이 그대로(전환된 세션 캐시 오염 방지).
 * - `currentSig === mySig`: 프레임 서명이 그대로 — 재활성으로 서명이 바뀌었으면
 *   그 조회는 낡은 것이라 폐기한다(활성 인라인 승계 본문을 늦은 조회가 덮는 경로 차단). */
export function lazyResponseIsCurrent(
  latestReq: number | undefined,
  myReq: number,
  currentUuid: string | null,
  myUuid: string | null,
  currentSig: string | null,
  mySig: string | null,
): boolean {
  return latestReq === myReq && currentUuid === myUuid && currentSig === mySig;
}

/** 이 timeline 이벤트가 종료 표시를 풀어야 하나 (순수 — BB2, 종결 우선).
 *
 * 세션을 닫은 뒤(`claude-session-closed`) 그 세션의 **같은 PTY id**로 늦게 도착한
 * straggler timeline(자연 종료 flush가 closed보다 늦게 도착하는 순서 뒤집힘 등)은
 * 최종 상태를 그리되 **종료 표시를 되돌리면 안 된다**. 오직 **새 id**(같은 uuid를
 * 다시 연 resume — 새 PTY)일 때만 다시 연다. 이로써 백엔드 emit 순서와 무관하게
 * "닫힌 세션이 다시 열리는" 회귀가 사라진다(순서 안전을 프론트가 흡수). */
export function resumesSession(eventId: number, closedId: number | null): boolean {
  return closedId == null || eventId !== closedId;
}

/** 이 프레임의 본문을 지금 조회해야 하나 (순수). 활성 프레임(본문 인라인)은
 * 불필요, 같은 서명의 캐시가 이미 있으면 불필요(실패 sentinel 포함 — 재시도는
 * `force`로만, 실패 재조회 폭주 방지). */
export function needsSubagentFetch(
  frame: SubagentFrame | undefined,
  entry: LazyAgentEntry | undefined,
): boolean {
  if (!frame || frame.items != null) return false;
  return !entry || entry.sig !== frame.sig;
}

/** The part of a payload `applySnapshot` reads — a live event or the stored
 * snapshot from `claude_session_snapshot` (which has no subagents/id). */
export interface TimelineSnapshotLike {
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
  dates: [number, string][];
  tokens?: [number, TokenUsage][];
  model?: string | null;
  last_usage?: TokenUsage | null;
}

/** Where a snapshot came from: a restore seed (silent) vs a live JSONL edge. */
export type TimelineOrigin = "snapshot" | "live";

/** Context-window size (tokens) for a Claude model id. The `[1m]` variants carry
 * a 1M window; other Claude models default to 200k. Unknown / non-Claude → 0, so
 * the gauge is hidden rather than showing a made-up window. */
export function ctxWindow(model?: string | null): number {
  if (!model || !model.includes("claude")) return 0;
  if (model.includes("[1m]") || model.includes("-1m")) return 1_000_000;
  return 200_000;
}

/** Session token totals: ↑ = new context processed (input + cache write),
 * ↓ = generated output. Summed across turns. */
export function sumTokenTotals(
  tokens: [number, TokenUsage][] | undefined,
): { input: number; output: number } {
  return (tokens ?? []).reduce(
    (acc, [, u]) => ({
      input: acc.input + u.input + u.cache_creation,
      output: acc.output + u.output,
    }),
    { input: 0, output: 0 },
  );
}

/** Current context occupancy (gauge numerator) = the latest assistant message's
 * input + cache tokens. No usage yet → 0 (gauge hidden). */
export function ctxOccupancy(lu: TokenUsage | null | undefined): number {
  return lu ? lu.input + lu.cache_read + lu.cache_creation : 0;
}

/** Everything TimelineView (+ the header gauges) needs to render a session. */
export interface ClaudeTimelineState {
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
  dates: Map<number, string>;
  subagents: SubagentView[];
  tokenTotal: { input: number; output: number };
  ctxModel: string | null;
  ctxTokens: number;
  /** 완료 서브에이전트 본문 요청(펼침 시). 활성/이미 도착한 프레임은 no-op.
   * `force`는 실패한 조회의 재시도용. */
  requestSubagent: (agentId: string, force?: boolean) => void;
}

/**
 * Timeline state + the snapshot applier — the state half of the old
 * ClaudeTermPanel wiring, unchanged.
 *
 * `onApply` runs after the state is set, with the same payload+origin: the panel
 * derives its attention badge there (peek passes nothing). The returned
 * `applySnapshot` is **stable** (the callback is read through a ref), so the
 * caller's mount effect may capture it once — as ClaudeTermPanel does.
 */
export function useTimelineState(
  onApply?: (s: TimelineSnapshotLike, origin: TimelineOrigin) => void,
  /** lazy 서브에이전트 본문 조회 대상 세션. 없으면 조회는 no-op이고 완료
   * 그룹은 접힌 채로 남는다(메타 표시는 그대로). */
  source?: { project: string | null; uuid: string | null },
): ClaudeTimelineState & {
  applySnapshot: (s: TimelineSnapshotLike, origin: TimelineOrigin) => void;
  setSubagentFrames: (v: SubagentFrame[]) => void;
} {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [turns, setTurns] = useState<Map<number, string>>(new Map());
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());
  const [dates, setDates] = useState<Map<number, string>>(new Map());
  // Per-subagent frames (B1) — 완료 프레임은 메타만, 본문은 아래 lazy 캐시.
  const [subagentFrames, setFrames] = useState<SubagentFrame[]>([]);
  const [lazyAgents, setLazyAgents] = useState<Map<string, LazyAgentEntry>>(new Map());
  // 최신 프레임/캐시/세션을 콜백에서 읽기 위한 거울(요청 콜백을 stable하게 유지).
  const framesRef = useRef(subagentFrames);
  framesRef.current = subagentFrames;
  const lazyRef = useRef(lazyAgents);
  lazyRef.current = lazyAgents;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const putLazy = useCallback((aid: string, e: LazyAgentEntry) => {
    setLazyAgents((prev) => {
      const next = new Map(prev);
      next.set(aid, e);
      lazyRef.current = next;
      return next;
    });
  }, []);

  // AA3: lazy 조회 CAS — 요청마다 단조 토큰을 발급하고 에이전트별 최신 토큰을
  // 기록한다. 응답 resolve/reject 시 (같은 세션 · 여전히 최신 요청)일 때만 캐시에
  // 반영한다. 늦게 도착한 rev7 응답이 그 사이 승계된 rev8/새 조회를 덮어
  // "미도착"으로 되돌리는 경로를 막는다.
  const reqSeqRef = useRef(0);
  const reqOfRef = useRef<Map<string, number>>(new Map());

  /** payload의 프레임 반영 + 인라인 본문을 캐시로 승계(완료 전이 시 표시 유지). */
  const setSubagentFrames = useCallback((frames: SubagentFrame[]) => {
    setFrames(frames);
    setLazyAgents((prev) => {
      const next = adoptInlineBodies(frames, prev) as Map<string, LazyAgentEntry>;
      lazyRef.current = next;
      return next;
    });
  }, []);

  // 세션이 바뀌면 다른 세션의 서브에이전트 본문이 남아 있으면 안 된다.
  const srcUuid = source?.uuid ?? null;
  useEffect(() => {
    lazyRef.current = new Map();
    setLazyAgents(new Map());
  }, [srcUuid]);

  /**
   * 완료 서브에이전트 본문 조회 — 사용자가 그룹을 펼칠 때만 호출된다(자동
   * 프리페치 없음: 세션당 에이전트가 수십 개라 전부 당기면 lazy의 의미가 없다).
   * 도착한 본문은 언마운트까지 유지한다 — 상한 축출을 두면 축출된 그룹이
   * 재요청 없이 "불러오는 중"에 고착되기 때문(무음 실패). 보유량의 상한은
   * "사용자가 실제로 펼친 에이전트 수"다.
   */
  const requestSubagent = useCallback(
    (agentId: string, force = false) => {
      const frame = framesRef.current.find((f) => f.id === agentId);
      const entry = lazyRef.current.get(agentId);
      if (!frame) return;
      if (!force && !needsSubagentFetch(frame, entry)) return;
      if (force && frame.items != null) return; // 활성 프레임은 조회 대상이 아니다
      const sig = frame.sig;
      const src = sourceRef.current;
      // AA3: 이 요청을 식별 — 토큰 + 발주 시점 세션 uuid. 응답 반영 전 둘 다
      // 여전히 유효한지 확인한다(늦은 응답이 새 요청/세션 전환을 덮지 않게).
      const myReq = ++reqSeqRef.current;
      reqOfRef.current.set(agentId, myReq);
      const myUuid = src?.uuid ?? null;
      const commit = (e: LazyAgentEntry) => {
        // BB3: 반영 시점의 현재 프레임 서명 — 재활성으로 프레임이 활성(인라인)이
        // 되었거나 사라졌으면 발주 시 sig와 달라져 폐기된다.
        const curSig = framesRef.current.find((f) => f.id === agentId)?.sig ?? null;
        if (
          !lazyResponseIsCurrent(
            reqOfRef.current.get(agentId),
            myReq,
            sourceRef.current?.uuid ?? null,
            myUuid,
            curSig,
            sig,
          )
        )
          return; // 더 새 요청·세션 전환·재활성(서명 변화) — 늦은 응답 폐기
        putLazy(agentId, e);
      };
      if (!src?.project || !src?.uuid) {
        // 조회 좌표를 모르면 본문은 영영 못 온다 — "불러오는 중"으로 매달아
        // 두지 말고 실패로 표시한다(무음 금지).
        commit({ state: "error", sig });
        return;
      }
      commit({ state: "loading", sig });
      invoke<TimelineItem[]>("claude_subagent_items", {
        project: src.project,
        uuid: src.uuid,
        agentId,
      })
        .then((its) => commit({ state: "ready", sig, items: its ?? [] }))
        .catch(() => commit({ state: "error", sig }));
    },
    [putLazy],
  );

  const subagents = useMemo(
    () => mergeSubagents(subagentFrames, lazyAgents),
    [subagentFrames, lazyAgents],
  );
  const [tokenTotal, setTokenTotal] = useState<{ input: number; output: number }>({
    input: 0,
    output: 0,
  });
  // Context-window gauge (P5): current occupancy = the latest assistant message's
  // input+cache tokens (last_usage), sized by the session model's window.
  const [ctxModel, setCtxModel] = useState<string | null>(null);
  const [ctxTokens, setCtxTokens] = useState<number>(0);

  // Latest callback, so `applySnapshot` can stay stable across renders.
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  const applySnapshot = useCallback((s: TimelineSnapshotLike, origin: TimelineOrigin) => {
    setItems([...s.items].sort((a, b) => a.seq - b.seq));
    setTurns(new Map(s.turns));
    setAnswers(new Map(s.answers));
    setDates(new Map(s.dates));
    setTokenTotal(sumTokenTotals(s.tokens));
    setCtxModel(s.model ?? null);
    setCtxTokens(ctxOccupancy(s.last_usage));
    onApplyRef.current?.(s, origin);
  }, []);

  return {
    items,
    turns,
    answers,
    dates,
    subagents,
    tokenTotal,
    ctxModel,
    ctxTokens,
    applySnapshot,
    setSubagentFrames,
    requestSubagent,
  };
}

/**
 * Subscribe to a session's timeline knowing only its **uuid** (the peek panel).
 *
 * - live: `claude-timeline` carries the numeric PTY id only, so each event is
 *   reverse-mapped through the claudeStatus registry (the same path the app-level
 *   global listener uses) and kept only when it resolves to `uuid`. The mapping
 *   outlives the owning panel's unmount, so a backgrounded tab's session still
 *   streams here.
 * - seed: the stored snapshot fills the list before the next live change (skipped
 *   if a live event already landed — that one is newer).
 * - `ended`: the session's PTY died / was force-closed (`claude-session-closed`),
 *   matched by the numeric id we last resolved — the broadcast's uuid mapping may
 *   already be gone by the time it arrives.
 *
 *   **적극 신호(브로드캐스트)만 쓴다.** 마운트 시 `claude_live_uuids`로 생존을
 *   조회하던 백스톱은 뺐다: 스폰 직후(runtime 등록 전)에 peek를 열면 살아 있는
 *   세션을 "종료"로 오판하는 race만 남기 때문이다. 그 백스톱이 덮던 경우(언마운트
 *   중 지나간 종료)는 이제 필요 없다 — peek는 재시작으로 부활하지 않고(복원 시
 *   제거), 창 간 이동도 하지 않으며(전송 시 닫힘), 원본 탭이 사라지면 스스로
 *   닫히므로(TimelinePeekPanel) "종료를 놓친 채 오래 떠 있는 peek"가 성립하지 않는다.
 */
export function useClaudeTimeline({
  uuid,
  project,
}: {
  uuid: string | null;
  project: string | null;
}): ClaudeTimelineState & { ended: boolean } {
  // uuid/project를 넘겨야 완료 서브에이전트 본문을 펼침 시 조회할 수 있다.
  const state = useTimelineState(undefined, { project, uuid });
  const { applySnapshot, setSubagentFrames } = state;
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!uuid) return;
    let disposed = false;
    // A live event is newer than the stored snapshot — don't let a slow snapshot
    // seed overwrite it (same guard as the owning panel's `gotLive`).
    let gotLive = false;
    // Seed from the registry (the owning panel registered it when the session
    // opened) so a session that ends without emitting another timeline event is
    // still recognized as ours.
    let numericId: number | null = lookupSessionId(uuid) ?? null;
    // BB2: 이미 닫힌 PTY id를 기억한다(종결 우선). 자연 종료 flush(BB1)로 closed
    // 뒤에 같은 id의 straggler timeline이 늦게 와도 종료 표시를 되돌리지 않는다.
    let closedId: number | null = null;
    let unTl: UnlistenFn | undefined;
    let unClosed: UnlistenFn | undefined;
    (async () => {
      unTl = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
        if (lookupSessionUuid(e.payload.id) !== uuid) return;
        const eid = e.payload.id;
        gotLive = true;
        // 폴 스레드는 세션이 살아 있을 때만 emit한다 — 이벤트 자체가 생존 증거다.
        // 하지만 **닫힌 그 세션(같은 id)의 늦은 straggler**는 최종 상태만 그리고
        // 종료 표시는 유지한다(BB2 — 백엔드 emit 순서 무관 종결 우선). 새 id로
        // 재개되면(resume — 새 PTY) 그때만 다시 연다.
        if (resumesSession(eid, closedId)) {
          setEnded(false);
          closedId = null;
        }
        numericId = eid;
        applySnapshot(e.payload, "live");
        setSubagentFrames(e.payload.subagents ?? []);
      });
      unClosed = await listen<number>("claude-session-closed", (e) => {
        if (numericId != null && e.payload === numericId) {
          setEnded(true);
          closedId = e.payload;
        }
      });
      // Unmounted while awaiting listen() — cleanup already ran, so release here.
      if (disposed) {
        unTl?.();
        unClosed?.();
        unTl = undefined;
        unClosed = undefined;
        return;
      }
      if (project) {
        try {
          const snap = await invoke<TimelineSnapshotLike | null>("claude_session_snapshot", {
            project,
            uuid,
          });
          if (snap && !gotLive && !disposed) applySnapshot(snap, "snapshot");
        } catch {
          /* no snapshot yet (fresh session) — live events will fill it */
        }
      }
    })();
    return () => {
      disposed = true;
      unTl?.();
      unClosed?.();
    };
  }, [uuid, project, applySnapshot, setSubagentFrames]);

  return { ...state, ended };
}
