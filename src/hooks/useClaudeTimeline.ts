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
import { useCallback, useEffect, useRef, useState } from "react";
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
  /** [agentId, parentToolCallId|null, turn, items] per subagent — nested under
   * its spawning Agent item (parent), or its turn when there's no known parent. */
  subagents: [string, string | null, number, TimelineItem[]][];
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
  subagents: [string, string | null, number, TimelineItem[]][];
  tokenTotal: { input: number; output: number };
  ctxModel: string | null;
  ctxTokens: number;
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
): ClaudeTimelineState & {
  applySnapshot: (s: TimelineSnapshotLike, origin: TimelineOrigin) => void;
  setSubagents: (v: [string, string | null, number, TimelineItem[]][]) => void;
} {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [turns, setTurns] = useState<Map<number, string>>(new Map());
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());
  const [dates, setDates] = useState<Map<number, string>>(new Map());
  // Per-subagent change lists [agentId, parentToolCallId|null, turn, items] (B1).
  const [subagents, setSubagents] = useState<[string, string | null, number, TimelineItem[]][]>([]);
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
    setSubagents,
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
 *   already be gone by the time it arrives. That broadcast can also pass while
 *   this consumer is unmounted (a backgrounded peek tab), so each mount also asks
 *   `claude_live_uuids` once; a later live timeline event clears the flag again.
 */
export function useClaudeTimeline({
  uuid,
  project,
}: {
  uuid: string | null;
  project: string | null;
}): ClaudeTimelineState & { ended: boolean } {
  const state = useTimelineState();
  const { applySnapshot, setSubagents } = state;
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
    let unTl: UnlistenFn | undefined;
    let unClosed: UnlistenFn | undefined;
    (async () => {
      unTl = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
        if (lookupSessionUuid(e.payload.id) !== uuid) return;
        numericId = e.payload.id;
        gotLive = true;
        // 폴 스레드는 세션이 살아 있을 때만 emit한다 — 이벤트 자체가 생존 증거라,
        // 초기 생존 조회가 스폰과 경합해 잘못 붙인 종료 표시를 스스로 푼다.
        setEnded(false);
        applySnapshot(e.payload, "live");
        setSubagents(e.payload.subagents ?? []);
      });
      unClosed = await listen<number>("claude-session-closed", (e) => {
        if (numericId != null && e.payload === numericId) setEnded(true);
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
        // 생존 조회(기존 커맨드): `claude-session-closed`는 이 소비자가 언마운트된
        // 동안(백그라운드 탭) 지나갈 수 있어, 마운트마다 현재 상태를 한 번 확인한다.
        try {
          const live = await invoke<string[]>("claude_live_uuids", { project });
          if (!disposed && !gotLive && !live.includes(uuid)) setEnded(true);
        } catch {
          /* 조회 실패는 무해 — 종료 표시를 붙이지 않는다(오탐보다 침묵) */
        }
      }
    })();
    return () => {
      disposed = true;
      unTl?.();
      unClosed?.();
    };
  }, [uuid, project, applySnapshot, setSubagents]);

  return { ...state, ended };
}
