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
  refresh: () => void;
} {
  const [hosts, setHosts] = useState<RemoteHostSnapshot[]>([]);
  const [live, setLive] = useState<Map<number, RemoteLiveTimeline>>(new Map());
  const liveRef = useRef(live);
  liveRef.current = live;

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

  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    let unClosed: UnlistenFn | undefined;
    void (async () => {
      un = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
        if (!isRemoteId(e.payload.id)) return; // 로컬 세션 — 이 패널의 것이 아니다
        setLive((prev) => {
          const next = new Map(prev);
          next.set(e.payload.id, toLiveTimeline(e.payload));
          liveRef.current = next;
          return next;
        });
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
      }
    })();
    return () => {
      disposed = true;
      un?.();
      unClosed?.();
    };
  }, [refresh]);

  return { hosts, live, refresh };
}
