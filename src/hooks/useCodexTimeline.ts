/**
 * codex 세션 타임라인 **데이터 공급** (작업③ H).
 *
 * claude 쪽([`useClaudeTimeline`])과 **공급 경로를 공유하지 않는다** — 저쪽은
 * 백엔드 tail 스레드가 밀어 주는 `claude-timeline` 이벤트를 구독하고, 이쪽은
 * rollout 전사를 주기 조회한다. (거기서 가져오는 것은 토큰 합산·컨텍스트 점유
 * 같은 **순수 함수 둘**뿐이고, 그건 TimelineView에 넘길 값의 정의라 오히려 같아야
 * 한다.) 그 차이는 취향이 아니라 codex의 사실에서 온다:
 *
 * - codex에는 `--session-id`가 없어 앱이 전사 경로를 **미리 알 수 없다**. 스폰
 *   시각·cwd로 사후에 찾아야 하고, 그 찾기는 백엔드가 매 조회마다 한다.
 * - 전사 파일은 세션이 뜰 때가 아니라 **첫 메시지를 보낼 때** 생긴다(실측).
 *   즉 "아직 없는 파일"을 기다리는 구간이 정상 상태다.
 *
 * 그래서 화면은 세 가지를 구분해서 보여 준다: 아직 못 찾음(searching) / 못 찾기로
 * 결정(contested·ambiguous — 남의 세션을 띄우느니 안 띄운다) / 찾음(matched).
 * **빈 화면으로 뭉개지 않는 것**이 이 훅의 계약이다(spec ②, 무음 금지).
 *
 * 폴링은 패널이 타임라인을 펼친 동안에만 돈다(`enabled`). 백엔드가 파일 서명을
 * 돌려주고 다음 조회에 그대로 되보내므로, 변화가 없으면 전사가 다시 직렬화되어
 * 넘어오지 않는다.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TimelineItem } from "../types";
import { ctxOccupancy, sumTokenTotals, type TokenUsage } from "./useClaudeTimeline";
import { errText } from "../utils/error";

/** 조회 주기. 터미널이 이미 실시간 화면이라 타임라인은 요약 뷰다 — 1.5초면 충분히
 * 따라오면서 큰 전사에서도 부담이 없다. */
const POLL_MS = 1500;

/** 백엔드가 파싱한 전사 한 벌 (`core_lib::codex_rollout::RolloutParse`). */
export interface CodexRolloutSnapshot {
  session_id: string;
  cwd: string | null;
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
  dates: [number, string][];
  tokens: [number, TokenUsage][];
  model: string | null;
  effort: string | null;
  context_window: number | null;
  last_usage: TokenUsage | null;
  lines: number;
  bad_lines: number;
  /** 인식하지 못해 건너뛴 레코드 종류별 개수 — codex가 스키마를 늘리면 여기 뜬다. */
  skipped: [string, number][];
}

export type CodexTimelineStatus =
  | "matched"
  | "searching"
  | "contested"
  | "ambiguous"
  /** 잡았던 전사 파일이 사라졌다 — 다시 찾지 않는다(다른 세션을 집을 위험). */
  | "lost"
  | "unavailable"
  | "error";

interface CodexTimelinePayload {
  status: Exclude<CodexTimelineStatus, "error">;
  note: string | null;
  path: string | null;
  /** 이 탭의 PTY가 살아 있는가. 죽어도 타임라인은 남는다(마지막 상태 보존). */
  alive: boolean;
  /** 후보를 앱 표식(originator)으로 좁혔는가. `false`면 이 codex가 표식을 남기지
   * 않아 시각·경로 추측으로 골랐다는 뜻 — `note`가 그 사실을 담는다. */
  marked: boolean;
  fingerprint: string | null;
  unchanged: boolean;
  snapshot: CodexRolloutSnapshot | null;
}

/** TimelineView + 헤더가 필요로 하는 전부. */
export interface CodexTimelineState {
  status: CodexTimelineStatus;
  /** 매칭 실패·오류의 사람 말 설명. `status === "matched"`면 null. */
  note: string | null;
  path: string | null;
  alive: boolean;
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
  dates: Map<number, string>;
  tokenTotal: { input: number; output: number };
  model: string | null;
  effort: string | null;
  /** 컨텍스트 점유/창 (전사의 `model_context_window`). 창을 모르면 0. */
  ctxTokens: number;
  ctxWindow: number;
  badLines: number;
  skipped: [string, number][];
}

const EMPTY: CodexTimelineState = {
  status: "searching",
  note: null,
  path: null,
  alive: true,
  items: [],
  turns: new Map(),
  answers: new Map(),
  dates: new Map(),
  tokenTotal: { input: 0, output: 0 },
  model: null,
  effort: null,
  ctxTokens: 0,
  ctxWindow: 0,
  badLines: 0,
  skipped: [],
};

/** 페이로드 → 렌더 상태. `TimelineView`가 seq 순서를 전제하므로 여기서 정렬한다
 * (claude 경로의 `applySnapshot`과 같은 계약). */
export function stateFromSnapshot(
  s: CodexRolloutSnapshot,
  path: string | null,
  alive = true,
  note: string | null = null,
): CodexTimelineState {
  return {
    status: "matched",
    // 매칭돼도 note가 붙을 수 있다 — 표식 없이 시각으로만 골랐을 때.
    note,
    path,
    alive,
    items: [...s.items].sort((a, b) => a.seq - b.seq),
    turns: new Map(s.turns),
    answers: new Map(s.answers),
    dates: new Map(s.dates),
    tokenTotal: sumTokenTotals(s.tokens),
    model: s.model,
    effort: s.effort,
    // codex 모델은 `ctxWindow()`(claude 모델명 매칭)로는 항상 0이다 — 창 크기는
    // 전사가 직접 알려 주므로(`task_started.model_context_window`) 그걸 쓴다.
    ctxTokens: ctxOccupancy(s.last_usage),
    ctxWindow: s.context_window ?? 0,
    badLines: s.bad_lines,
    skipped: s.skipped,
  };
}

export function useCodexTimeline({
  sessionId,
  enabled,
}: {
  sessionId: number | null;
  enabled: boolean;
}): CodexTimelineState {
  const [state, setState] = useState<CodexTimelineState>(EMPTY);

  useEffect(() => {
    if (!enabled || sessionId == null) return;
    let stopped = false;
    let timer: number | undefined;
    // 마지막으로 받은 파일 서명. 되보내면 변화 없을 때 전사가 다시 오지 않는다.
    let since: string | null = null;

    const tick = async () => {
      try {
        const p = await invoke<CodexTimelinePayload>("codex_timeline_snapshot", {
          id: sessionId,
          since,
        });
        if (stopped) return;
        since = p.fingerprint;
        if (p.snapshot) setState(stateFromSnapshot(p.snapshot, p.path, p.alive, p.note));
        else if (p.unchanged)
          setState((s) => ({ ...s, status: p.status, note: p.note, path: p.path, alive: p.alive }));
        // 전사를 잃은 경우(파일 삭제)는 목록을 남겨 두지 않는다 — 화면에 남은 옛
        // 타임라인이 지금 세션의 것으로 읽힌다. 세션 **종료**는 여기가 아니다:
        // 그때는 백엔드가 마지막 전사를 계속 돌려주므로 타임라인이 그대로 남는다.
        else setState({ ...EMPTY, status: p.status, note: p.note, alive: p.alive });
      } catch (e) {
        if (stopped) return;
        setState((s) => ({ ...s, status: "error", note: errText(e, "타임라인을 읽지 못했습니다.") }));
      }
      // setInterval이 아니라 매번 다시 건다 — 느린 조회가 겹쳐 쌓이지 않게.
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [sessionId, enabled]);

  return state;
}
