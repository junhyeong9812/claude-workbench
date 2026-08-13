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
import type { ClaudeTimelineEvent } from "../hooks/useClaudeTimeline";

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
 * 저장해 둔 "여기까지 봤다"가 **이 연결의 것이 아닌** 호스트들.
 *
 * `seq`가 호스트 안에서 단조인 것은 맞지만 그건 **한 Host 객체 안에서**다.
 * 다시 붙으면(`Registry::attach` 마다 새 Host) 카운터가 1부터 다시 시작하는데,
 * 화면이 들고 있는 seen 은 옛 연결의 큰 값이라 새 연결의 알림 전부가 "이미
 * 본 것"으로 걸러진다 — 갭·데몬 재시작·읽지 못한 줄까지 통째로 안 보인다.
 * 알림 채널이 조용히 죽는 것이 이 단계에서 가장 나쁜 실패다.
 *
 * 판정은 epoch 비교가 아니라 **되감김 자체**다: 같은 데몬에 다시 붙어도
 * (epoch 동일) 카운터는 리셋되므로 epoch 로는 못 잡는다.
 */
export function staleSeenHosts(
  hosts: readonly RemoteHostSnapshot[],
  seen: Readonly<Record<string, number>>,
): string[] {
  return hosts
    .filter((h) => {
      const mine = seen[h.host_id] ?? 0;
      if (mine === 0) return false;
      const newest = h.notices.length ? h.notices[h.notices.length - 1].seq : 0;
      return mine > newest;
    })
    .map((h) => h.host_id);
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
  model: string | null;
  last_usage: { input: number; output: number; cache_read: number; cache_creation: number } | null;
}

/** 회수한 본문 → 라이브 타임라인 (순수). 라이브 payload 와 같은 모양으로 만든다. */
export function fetchedToLive(r: RemoteTimelineReply): RemoteLiveTimeline {
  const u = r.last_usage;
  return {
    items: [...r.items].sort((a, b) => a.seq - b.seq),
    turns: r.turns ?? [],
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
  model: string | null;
  ctxTokens: number;
}

/** payload → 라이브 타임라인 (순수). 원격 payload의 `answers`/`dates`/`tokens`는
 * 언제나 비어 있다 — 데몬이 보내지 않는다(백엔드 `remote/host.rs` 주석). */
export function toLiveTimeline(e: ClaudeTimelineEvent): RemoteLiveTimeline {
  const u = e.last_usage;
  return {
    items: [...e.items].sort((a, b) => a.seq - b.seq),
    turns: e.turns ?? [],
    model: e.model ?? null,
    ctxTokens: u ? u.input + u.cache_read + u.cache_creation : 0,
  };
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
