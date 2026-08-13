/**
 * 원격 호스트 패널(R2a + R2b) — 다른 PC의 `cwcd` 데몬에 붙었다 떼고, 그 호스트의
 * 세션을 **띄우고 끄고 들여다보는** 사이드바 UI.
 *
 * R2a에서 하던 셋(연결·상태·타임라인)에 R2b의 제어가 붙었다: 호스트마다 `새 세션`
 * 폼 하나, 세션마다 `종료`와 `터미널`, 그리고 패널 맨 아래에 **한 번에 하나뿐인**
 * 내장 터미널. 최상위 호스트 탭·평행 상태 트리는 여전히 R3의 몫이라 여기에는
 * 없다 — 이 파일은 사이드바 패널 하나를 넘지 않는다.
 *
 * 판단은 전부 `state/remoteHosts.ts`의 순수 함수에 있다(버튼이 눌려도 되는지,
 * 크기를 언제 원격까지 보내는지, 끝난 이유를 뭐라고 말하는지). 여기 남은 것은
 * 배선이고, 그래서 이 단계의 규칙("아무것도 조용히 잃지 않는다")은 실패마다
 * 화면에 줄이 하나 뜨는 것으로 지켜진다.
 *
 * 새 UI 어휘를 만들지 않았다: 알림 줄은 정리 패널·시드 배너와 같은
 * `claudeterm-refine-note`, 행·배지는 사이드바 패널들이 쓰는 클래스를 쓴다.
 * 내장 터미널의 배선(구독 → 스냅샷 → drain, 테마·폰트, FitAddon)은
 * `TerminalPanel`이 하는 그대로다.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import {
  accountChoices,
  attachGate,
  countsLabel,
  defaultAccountId,
  endedReason,
  killGate,
  killLabel,
  noticeBadge,
  parseAccounts,
  phaseLabel,
  pickTimeline,
  resumeLabel,
  seenKey,
  seenSeqOf,
  nextRemoteResize,
  shouldAutoFetchBody,
  shouldFetchBody,
  spawnRequest,
  staleSeenKeys,
  useRemoteHosts,
  KILL_SIGNAL,
  REMOTE_RESIZE_DEBOUNCE_MS,
  SPAWN_AGENTS,
  type ControlGate,
  type RemoteAccount,
  type RemoteHostSnapshot,
  type RemoteLiveTimeline,
  type RemoteSessionMeta,
  type RemoteTerminalEnded,
  type TermSize,
} from "../state/remoteHosts";
import {
  dirCutNote,
  dirHasMore,
  logCutNote,
  logHasMore,
  parentPath,
  relPath,
  rootsCutNote,
  staleNote,
  useRemoteHostData,
  GIT_ROOTS_CAVEAT,
  type Loadable,
  type RemoteDataTab,
  type RemoteHostDataView,
} from "../state/remoteHostData";
import { decodePtyData, ptyEventName, pushPendingCapped } from "./pty";
import { errText } from "../utils/error";
import { xtermTheme } from "./xtermTheme";
import type { SnapshotResult, TerminalOutputEvent } from "../types";
import { AGENT_BADGE, KIND_LABEL } from "./TimelineView";

/** 한 세션 아래에 한 번에 그리는 최근 아이템 수 — 사이드바 폭에 맞춘 상한. */
const ITEM_ROWS = 12;

function ts(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

/** "마지막 프레임 N초 전" — 화면이 얼마나 낡았는지. */
function ageLabel(atMs: number | null): string | null {
  if (!atMs) return null;
  const secs = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (secs < 60) return `마지막 프레임 ${secs}초 전`;
  return `마지막 프레임 ${Math.round(secs / 60)}분 전`;
}

/** 지금 아래에 떠 있는 터미널 하나 — 원격 세션과 그것을 나르는 로컬 세션. */
interface AttachedTerm {
  hostId: string;
  /** 원격 세션 id (`remote_resize` 가 쓰는 것). */
  remoteId: number;
  /** `remote_attach` 가 돌려준 **로컬** 세션 id (`terminal_*` 가 쓰는 것). */
  localId: number;
  sessionKey: string;
}

export function RemoteHostPanel() {
  const connections = useAppStore((s) => s.savedConnections);
  const {
    hosts,
    live,
    fetched,
    fetching,
    attempted,
    fetchError,
    hostsError,
    hostsAt,
    streamError,
    seedError,
    fetchBody,
    retryStream,
    refresh,
  } = useRemoteHosts();
  const [connecting, setConnecting] = useState(false);
  const [pick, setPick] = useState<string>("");
  const [cwcd, setCwcd] = useState("");
  const [socket, setSocket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});
  /** 세션별 요청 진행 중 표시 — 같은 버튼이 두 번 눌리지 않게. */
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  /** 세션별 결과 한 줄(전달된 신호·실패 사유). 실패는 전부 여기로 나온다. */
  const [note, setNote] = useState<Record<number, string>>({});
  const [term, setTerm] = useState<AttachedTerm | null>(null);

  // 열려 있는 터미널을 이벤트 밖(언마운트·교체)에서도 닫을 수 있게 들고 있는다.
  const termRef = useRef<AttachedTerm | null>(null);
  /**
   * 세우는 순간 ref 도 같이 — effect 로 미루면 안 된다.
   *
   * `attach` 는 `await` 뒤에 "직전 터미널"을 ref 에서 읽어 닫는데, ref 를 렌더
   * 뒤 effect 에서 맞추면 그 시점의 값은 아직 옛것(대개 null)이다. 두 세션의
   * `터미널` 을 잇달아 누르면 둘 다 null 을 보고 아무도 닫지 않아, 앞의 SSH
   * 연결과 그 원격 attach 가 세션이 끝날 때까지 남는다(데몬 쪽 MAX_CONNS 슬롯도
   * 같이).
   */
  const putTerm = useCallback((t: AttachedTerm | null) => {
    termRef.current = t;
    setTerm(t);
  }, []);
  /** attach 세대 — 왕복 중에 다른 attach 나 닫기가 끼어들었는지. */
  const attachSeq = useRef(0);

  /**
   * 로컬 세션 id → 그 원격 터미널이 멈춘 이유. **패널이** 들고 있다.
   *
   * 터미널 컴포넌트가 마운트한 뒤에 구독하면 늦는다: connect/auth/exec 이 빨리
   * 실패하면 `remote-terminal-ended` 는 `remote_attach` 가 **돌아오기 전에**
   * 발행되고, Tauri 이벤트에는 replay 가 없어 사유가 영구 유실된다 — 화면에는 빈
   * 터미널만 남는다. 그래서 구독을 패널 마운트로 끌어올리고(그래서 어떤 attach
   * 보다도 먼저다), `attach` 는 이 구독이 실제로 걸린 뒤에야 요청을 보낸다.
   * 늦게 마운트한 터미널 뷰는 여기 적힌 값을 읽는다(= 늦게 붙어도 사유를 얻는다).
   */
  const [endedById, setEndedById] = useState<Record<number, string>>({});
  const [endedError, setEndedError] = useState<string | null>(null);
  /** 구독이 걸렸다는 사실 자체 — `attach` 가 이것을 기다린다. */
  const endedReady = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let disposed = false;
    let un: UnlistenFn | undefined;
    endedReady.current = (async () => {
      try {
        un = await listen<RemoteTerminalEnded>("remote-terminal-ended", (e) => {
          // **첫 사유가 진짜다.** 한 터미널이 두 번 말할 수 있다: 호스트를 떼면
          // 백엔드가 "떼어져 닫았습니다"를 먼저 내고, 그 때문에 세션이 사라지면
          // SSH 상태 릴레이가 뒤이어 "연결이 끊어졌습니다"를 낸다. 나중 것으로
          // 덮으면 화면은 원인이 아니라 결과를 말하게 된다 — 백엔드가 한 attach
          // 안에서 `said` 플래그로 지키는 규칙과 같은 규칙이다.
          setEndedById((m) => (e.payload.id in m ? m : { ...m, [e.payload.id]: endedReason(e.payload) }));
        });
        if (disposed) {
          un?.();
          un = undefined;
        }
      } catch (e) {
        // 구독 실패를 잡지 않으면 unhandled rejection 하나와 조용한 검은 상자만
        // 남는다 — 이 이벤트가 애초에 없애려던 바로 그 화면이다(R18).
        setEndedError(errText(e, "원격 터미널 종료 사유를 구독하지 못했습니다."));
      }
    })();
    return () => {
      disposed = true;
      un?.();
    };
  }, []);
  // 패널이 사라질 때 SSH exec 채널을 남기지 않는다. **원격 세션은 죽지 않는다** —
  // 닫는 것은 이 관찰 창(로컬 세션)뿐이고, 에이전트는 데몬이 계속 소유한다.
  useEffect(
    () => () => {
      const t = termRef.current;
      if (t) invoke("terminal_close", { id: t.localId }).catch(() => {});
    },
    [],
  );

  const setNoteFor = useCallback((id: number, msg: string) => {
    setNote((n) => ({ ...n, [id]: msg }));
  }, []);

  const closeTerm = useCallback(() => {
    // 세대를 올려, 왕복 중인 attach 가 돌아와 방금 닫은 창을 되살리지 않게.
    attachSeq.current += 1;
    const t = termRef.current;
    if (t) {
      invoke("terminal_close", { id: t.localId }).catch(() => {});
      // 사용자가 읽고 닫은 사유는 여기서 치운다(로컬 id 는 재사용되지 않으므로
      // 다음 터미널과 겹칠 일이 없다 — 남겨 두면 쌓이기만 한다).
      setEndedById((m) => {
        if (!(t.localId in m)) return m;
        const next = { ...m };
        delete next[t.localId];
        return next;
      });
    }
    putTerm(null);
  }, [putTerm]);

  /** 이 세션의 화면을 아래에 연다. 한 번에 하나 — 앞의 것은 닫는다. */
  const attach = useCallback(
    async (hostId: string, s: RemoteSessionMeta) => {
      setBusy((b) => ({ ...b, [s.id]: true }));
      setNoteFor(s.id, "");
      // `busy` 는 **세션별**이라 서로 다른 두 세션의 `터미널` 은 동시에 눌린다.
      // 늦게 시작한 쪽이 이긴다는 규칙을 세대로 못박고, 진 쪽은 자기가 연 것을
      // 반드시 닫는다 — 안 닫으면 SSH 연결·원격 attach·데몬 연결 슬롯이 세션이
      // 끝날 때까지 남는다.
      const mine = ++attachSeq.current;
      try {
        // 종료 사유 구독이 **걸린 뒤에** 요청한다. 빠른 실패는 attach 응답보다
        // 먼저 이벤트를 내고, Tauri 이벤트는 replay 되지 않는다.
        await endedReady.current;
        // 처음 크기는 짐작이고, 첫 정착 크기가 곧바로 로컬·원격 양쪽을 고친다.
        const localId = await invoke<number>("remote_attach", {
          hostId,
          id: s.id,
          cols: 80,
          rows: 24,
        });
        if (mine !== attachSeq.current) {
          invoke("terminal_close", { id: localId }).catch(() => {});
          return;
        }
        const prev = termRef.current;
        if (prev) invoke("terminal_close", { id: prev.localId }).catch(() => {});
        putTerm({ hostId, remoteId: s.id, localId, sessionKey: s.key });
      } catch (e) {
        setNoteFor(s.id, errText(e, "터미널을 열지 못했습니다."));
      } finally {
        setBusy((b) => ({ ...b, [s.id]: false }));
      }
    },
    [putTerm, setNoteFor],
  );

  /** 종료 요청. 화면에 적는 것은 **전달된** 신호다(요청한 것이 아니라). */
  const kill = useCallback(
    async (hostId: string, s: RemoteSessionMeta) => {
      setBusy((b) => ({ ...b, [s.id]: true }));
      setNoteFor(s.id, "");
      try {
        const delivered = await invoke<number>("remote_kill", {
          hostId,
          id: s.id,
          signal: KILL_SIGNAL,
        });
        setNoteFor(s.id, killLabel(KILL_SIGNAL, delivered));
        refresh();
      } catch (e) {
        setNoteFor(s.id, errText(e, "종료 요청이 실패했습니다."));
      } finally {
        setBusy((b) => ({ ...b, [s.id]: false }));
      }
    },
    [refresh, setNoteFor],
  );

  const attached = useMemo(() => new Set(hosts.map((h) => h.host_id)), [hosts]);
  const candidates = connections.filter((c) => !attached.has(c.id));

  // "여기까지 봤다"는 **그 연결의 것**이다(`seenKey`). 다시 붙은 호스트는 알림
  // seq 가 1부터 다시 시작하므로 옛 연결의 표시를 그대로 적용하면 새 연결의
  // 알림이 걸러져 **알림 채널이 통째로 죽는다** — 갭도 데몬 재시작도 안 보인다.
  // 키가 다르니 그 일은 애초에 일어나지 않고, 여기서는 안 쓰이게 된 칸만 치운다.
  useEffect(() => {
    const stale = staleSeenKeys(hosts, seen);
    if (stale.length === 0) return;
    setSeen((s) => {
      const next = { ...s };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [hosts, seen]);

  async function connect() {
    const conn = connections.find((c) => c.id === pick);
    if (!conn) {
      setError("연결할 SSH 연결을 고르세요.");
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      await invoke<string>("remote_connect", {
        hostId: conn.id,
        label: conn.label || `${conn.username}@${conn.host}`,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        authKind: conn.auth_kind,
        keyPath: conn.key_path ?? null,
        connectionId: conn.id,
        cwcd: cwcd.trim() || null,
        socket: socket.trim() || null,
      });
      refresh();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(hostId: string) {
    try {
      await invoke<boolean>("remote_disconnect", { hostId });
    } catch {
      /* 이미 떨어져 있으면 그것으로 충분하다 */
    }
    refresh();
  }

  return (
    <div className="remote-panel">
      <div className="remote-panel-list">
        <div className="remote-connect">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-label="원격 호스트로 붙일 SSH 연결"
          >
            <option value="">SSH 연결 선택…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || `${c.username}@${c.host}`}
              </option>
            ))}
          </select>
          <input
            value={cwcd}
            onChange={(e) => setCwcd(e.target.value)}
            placeholder="cwcd 경로 (비우면 PATH)"
            aria-label="원격 데몬 바이너리 경로"
          />
          <input
            value={socket}
            onChange={(e) => setSocket(e.target.value)}
            placeholder="소켓 경로 (비우면 기본)"
            aria-label="원격 데몬 소켓 경로"
          />
          <button type="button" onClick={() => void connect()} disabled={connecting || !pick}>
            {connecting ? "붙는 중…" : "호스트로 연결"}
          </button>
        </div>
        {error ? (
          <div className="claudeterm-refine-note" role="alert">
            {error}
            <button
              type="button"
              className="claudeterm-refine-note-x"
              onClick={() => setError(null)}
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        ) : null}
        {hostsError ? (
          <div className="claudeterm-refine-note" role="alert">
            호스트 목록을 읽지 못했습니다 — {hostsError}
            {hostsAt ? ` (마지막으로 읽은 시각 ${ts(hostsAt)} — 아래 내용은 그때 것입니다)` : ""}
            <button type="button" className="remote-fetch" onClick={refresh}>
              다시 시도
            </button>
          </div>
        ) : null}
        {streamError ? (
          <div className="claudeterm-refine-note" role="alert">
            원격 이벤트를 받지 못하고 있습니다 — {streamError}
            <button type="button" className="remote-fetch" onClick={retryStream}>
              다시 시도
            </button>
          </div>
        ) : null}
        {seedError ? (
          <div className="claudeterm-refine-note" role="alert">
            지금 상태를 받아오지 못했습니다 — {seedError} (끝난 세션은 이벤트를 내지 않으므로 이대로면
            빈 화면입니다)
            <button type="button" className="remote-fetch" onClick={retryStream}>
              다시 시도
            </button>
          </div>
        ) : null}
        {endedError ? (
          <div className="claudeterm-refine-note" role="alert">
            원격 터미널 종료 사유를 구독하지 못했습니다 — {endedError}
          </div>
        ) : null}
        {connections.length === 0 ? (
          <p className="remote-empty">
            저장된 SSH 연결이 없습니다. 터미널 ＋ 메뉴에서 SSH로 한 번 접속해 두면 여기에 나옵니다
            (호스트 키도 그때 확인됩니다).
          </p>
        ) : null}

        {hosts.length === 0 ? (
          <p className="remote-empty">연결된 원격 호스트가 없습니다.</p>
        ) : null}

        {hosts.map((h) => (
          <HostCard
            key={h.host_id}
            host={h}
            live={live}
            fetched={fetched}
            fetching={fetching}
            attempted={attempted}
            fetchError={fetchError}
            onFetch={(id) => fetchBody(h.host_id, id)}
            seenSeq={seenSeqOf(h, seen)}
            onSeen={() =>
              setSeen((s) => ({
                ...s,
                [seenKey(h)]: h.notices.length ? h.notices[h.notices.length - 1].seq : 0,
              }))
            }
            openIds={open}
            onToggle={(id) => setOpen((o) => ({ ...o, [id]: !o[id] }))}
            onDisconnect={() => void disconnect(h.host_id)}
            busy={busy}
            note={note}
            shownId={term && term.hostId === h.host_id ? term.remoteId : null}
            onKill={(s) => void kill(h.host_id, s)}
            onAttach={(s) => void attach(h.host_id, s)}
            onSpawned={refresh}
          />
        ))}
      </div>
      {term ? (
        <RemoteTerminalView
          key={term.localId}
          hostId={term.hostId}
          remoteId={term.remoteId}
          localId={term.localId}
          sessionKey={term.sessionKey}
          ended={endedById[term.localId] ?? null}
          onClose={closeTerm}
        />
      ) : null}
    </div>
  );
}

function HostCard({
  host,
  live,
  fetched,
  fetching,
  attempted,
  fetchError,
  onFetch,
  seenSeq,
  onSeen,
  openIds,
  onToggle,
  onDisconnect,
  busy,
  note,
  shownId,
  onKill,
  onAttach,
  onSpawned,
}: {
  host: RemoteHostSnapshot;
  live: Map<number, RemoteLiveTimeline>;
  fetched: Map<number, RemoteLiveTimeline>;
  fetching: ReadonlySet<number>;
  attempted: ReadonlySet<number>;
  fetchError: Record<number, string>;
  onFetch: (id: number) => void;
  seenSeq: number;
  onSeen: () => void;
  openIds: Record<number, boolean>;
  onToggle: (id: number) => void;
  onDisconnect: () => void;
  busy: Record<number, boolean>;
  note: Record<number, string>;
  /** 지금 아래 터미널에 떠 있는 이 호스트의 세션 (없으면 null). */
  shownId: number | null;
  onKill: (s: RemoteSessionMeta) => void;
  onAttach: (s: RemoteSessionMeta) => void;
  onSpawned: () => void;
}) {
  const badge = noticeBadge(host.notices, seenSeq);
  const resume = resumeLabel(host.resume);
  const age = ageLabel(host.last_frame_at_ms);
  const [spawning, setSpawning] = useState(false);
  const [showData, setShowData] = useState(false);
  return (
    <section className="remote-host">
      <header className="remote-host-head">
        <span className={`remote-dot remote-dot-${host.phase}`} aria-hidden />
        <strong>{host.label}</strong>
        <span className="remote-phase">{phaseLabel(host.phase)}</span>
        {badge ? (
          <span className={`remote-badge remote-badge-${badge.level}`}>{badge.count}</span>
        ) : null}
        <button
          type="button"
          className="remote-new"
          onClick={() => setShowData((v) => !v)}
          title="이 호스트의 프로젝트·파일트리·Git·워크트리를 봅니다 (읽기 전용)"
          aria-expanded={showData}
        >
          {showData ? "데이터 접기" : "데이터"}
        </button>
        <button
          type="button"
          className="remote-new"
          onClick={() => setSpawning((v) => !v)}
          title="이 호스트에서 에이전트를 새로 띄웁니다"
          aria-expanded={spawning}
        >
          {spawning ? "새 세션 접기" : "새 세션"}
        </button>
        <button type="button" onClick={onDisconnect} title="이 호스트에서 떼기">
          떼기
        </button>
      </header>

      {spawning ? <NewSessionForm hostId={host.host_id} onSpawned={onSpawned} /> : null}
      {showData ? <RemoteDataPanel hostId={host.host_id} /> : null}

      <div className="remote-host-meta">
        {host.daemon ? (
          <span>
            {host.daemon.user}@{host.daemon.hostname} · cwcd {host.daemon.version} · epoch{" "}
            <code>{host.daemon.epoch}</code>
          </span>
        ) : (
          <span>데몬 정보 없음</span>
        )}
        {resume ? <span>{resume}</span> : null}
        {host.cursor ? (
          <span>
            커서 <code>{host.cursor}</code>
          </span>
        ) : null}
        {age ? <span className="remote-age">{age}</span> : null}
        {host.running != null ? <span>실행 중 {host.running}</span> : null}
        {host.attempts > 1 ? <span>접속 시도 {host.attempts}회</span> : null}
      </div>

      {host.last_error && host.phase !== "live" ? (
        <div className="claudeterm-refine-note" role="alert">
          {host.last_error}
        </div>
      ) : null}

      {badge ? (
        <div className="remote-notices">
          {host.notices
            .filter((n) => n.seq > seenSeq)
            .slice(-6)
            .map((n) => (
              <div key={n.seq} className={`remote-notice remote-notice-${n.level}`}>
                <span className="remote-notice-time">{ts(n.at_ms)}</span>
                {n.message}
              </div>
            ))}
          <button type="button" onClick={onSeen}>
            알림 지우기
          </button>
        </div>
      ) : null}

      <ul className="remote-sessions">
        {host.sessions.length === 0 ? (
          <li className="remote-empty">이 호스트에 세션이 없습니다.</li>
        ) : null}
        {host.sessions.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            live={live.get(s.id)}
            fetched={fetched.get(s.id)}
            fetching={fetching.has(s.id)}
            attempted={attempted.has(s.id)}
            fetchError={fetchError[s.id]}
            onFetch={() => onFetch(s.id)}
            open={!!openIds[s.id]}
            onToggle={() => onToggle(s.id)}
            busy={!!busy[s.id]}
            note={note[s.id]}
            termOpen={shownId === s.id}
            onKill={() => onKill(s)}
            onAttach={() => onAttach(s)}
          />
        ))}
      </ul>
    </section>
  );
}

function SessionRow({
  s,
  live,
  fetched,
  fetching,
  attempted,
  fetchError,
  onFetch,
  open,
  onToggle,
  busy,
  note,
  termOpen,
  onKill,
  onAttach,
}: {
  s: RemoteSessionMeta;
  live: RemoteLiveTimeline | undefined;
  fetched: RemoteLiveTimeline | undefined;
  fetching: boolean;
  /** 이 세션에 대해 회수를 **시도한 적이 있나** — 자동 회수는 한 번뿐이다(R1). */
  attempted: boolean;
  fetchError: string | undefined;
  onFetch: () => void;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  note: string | undefined;
  /** 이 세션이 지금 아래 터미널에 떠 있나. */
  termOpen: boolean;
  onKill: () => void;
  onAttach: () => void;
}) {
  const shown = pickTimeline(live, fetched);
  const items = shown?.items ?? [];
  const turns = shown?.turns ?? [];
  // 턴 → 답변. 데몬은 R2b 부터 이것을 실어 보내는데 화면이 버리고 있었다 —
  // 그래서 "로컬과 같은 내용"이라던 원격 타임라인에 질문만 있었다.
  const answers = new Map(shown?.answers ?? []);
  const model = shown?.model ?? s.model;
  const ctx = shown?.ctxTokens ?? s.ctx_tokens;
  const recoverable = shouldFetchBody(s, shown);
  // 자동 회수는 **세션당 한 번**이다. 회수가 성공했는데 본문이 비면(끝났지만
  // 아무것도 하지 않은 세션) `recoverable` 은 계속 true 라, "내용이 비었나"로
  // 재시도를 정하면 effect 가 무한히 재발화하며 매 회차가 새 SSH 연결이 된다.
  // 판정의 축은 내용이 아니라 **시도**다(R1).
  const autoFetch = shouldAutoFetchBody(s, shown, {
    attempted,
    fetching,
    failed: fetchError !== undefined,
  });

  // 펼치면 한 번 가져온다. 데몬은 끝난 세션의 본문을 스냅샷에 싣지 않고
  // (`items_omitted`) 앞으로도 이벤트를 내지 않으므로, 자동 조회가 없으면
  // 사용자는 "따로 가져올 수 있습니다"라는 문장만 읽고 아무것도 못 본다.
  // 보관 기간이 지나면 데몬이 NotFound 로 답하고, 그 사유가 화면에 뜬다.
  // 그 뒤의 재시도는 아래 버튼 — 사용자가 누를 때만 나간다.
  useEffect(() => {
    if (open && autoFetch) onFetch();
    // onFetch 는 호출마다 새 클로저라 의존성에서 뺀다(넣으면 매 렌더 재조회).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoFetch]);

  return (
    <li className={`remote-session${s.closed ? " remote-session-closed" : ""}`}>
      <button type="button" className="remote-session-head" onClick={onToggle}>
        <span className="remote-caret">{open ? "▾" : "▸"}</span>
        <span className="remote-agent">{s.agent}</span>
        <span className="remote-session-name">{s.label || s.session_id.slice(0, 8)}</span>
        <span className={`remote-state remote-state-${s.state}`}>{s.state}</span>
        <span className="remote-counts">{countsLabel(s, shown)}</span>
      </button>
      <div className="remote-session-sub">
        <code title={s.cwd}>{s.cwd}</code>
        {model ? <span>{model}</span> : null}
        {ctx > 0 ? <span>ctx {ctx.toLocaleString()}</span> : null}
        {s.adopted ? <span className="remote-adopted">인수됨: {s.adopted}</span> : null}
        {s.last_hook ? <span>hook {s.last_hook}</span> : null}
        {s.exit_code != null ? <span>exit {s.exit_code}</span> : null}
        {s.signal ? <span>signal {s.signal}</span> : null}
      </div>
      <div className="remote-session-acts">
        <GateButton gate={attachGate(s, busy, termOpen)} onClick={onAttach}>
          터미널
        </GateButton>
        <GateButton gate={killGate(s, busy)} onClick={onKill}>
          종료
        </GateButton>
      </div>
      {note ? <div className="remote-session-note">{note}</div> : null}
      {open ? (
        <div className="remote-timeline">
          {fetching ? <p className="remote-empty">원격에서 본문을 가져오는 중…</p> : null}
          {fetchError ? (
            <p className="remote-empty">
              본문을 가져오지 못했습니다 — {fetchError}
              <button type="button" className="remote-fetch" onClick={onFetch}>
                다시 시도
              </button>
            </p>
          ) : null}
          {recoverable && !fetching && !fetchError ? (
            <p className="remote-empty">
              끝난 세션이라 본문이 스냅샷에 실리지 않았습니다({s.timeline_len}개).
              <button type="button" className="remote-fetch" onClick={onFetch}>
                원격에서 가져오기
              </button>
            </p>
          ) : null}
          {turns.map(([n, text]) => (
            <Fragment key={`t${n}`}>
              <p className="remote-turn">
                <span className="remote-turn-no">Q{n}</span>
                {text}
              </p>
              {answers.has(n) ? (
                <p className="remote-answer">
                  <span className="remote-turn-no">A{n}</span>
                  {answers.get(n)}
                </p>
              ) : null}
            </Fragment>
          ))}
          {items.slice(-ITEM_ROWS).map((it) => (
            <p key={it.tool_call_id} className="remote-item">
              <span className="remote-kind">{KIND_LABEL[it.kind] ?? "·"}</span>
              <span className="remote-item-title">{it.title}</span>
              <span className="remote-item-status">{AGENT_BADGE[it.agent_status] ?? ""}</span>
            </p>
          ))}
          {items.length === 0 && turns.length === 0 && !recoverable && !fetching ? (
            <p className="remote-empty">아직 받은 타임라인이 없습니다.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * 조회 하나의 실패·낡음을 말하는 줄. 값은 남기고 사유를 얹는다.
 *
 * 앞 슬라이스가 `hostsError`/`hostsAt` 으로 세운 결 그대로다: 실패를 빈 값으로
 * 축소하면 화면은 "없음"을 정직한 답으로 보이고, 아무도 계약이 깨진 줄 모른다.
 */
function LoadNote({ of, onRetry }: { of: Loadable<unknown>; onRetry: () => void }) {
  if (!of.error) return null;
  const stale = staleNote(of);
  return (
    <div className="claudeterm-refine-note" role="alert">
      원격에서 읽지 못했습니다 — {of.error}
      {stale ? ` (${stale})` : ""}
      <button type="button" className="remote-fetch" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}

/** 잘림 한 줄 — 있으면 반드시 보인다. 없으면 아무 자리도 차지하지 않는다. */
function CutNote({ note, onMore }: { note: string | null; onMore?: () => void }) {
  if (!note) return null;
  return (
    <p className="remote-cut" role="status">
      {note}
      {onMore ? (
        <button type="button" className="remote-fetch" onClick={onMore}>
          더 보기
        </button>
      ) : null}
    </p>
  );
}

/**
 * 한 호스트의 **데이터** — 프로젝트·파일트리·Git·워크트리 (R2, 읽기 전용).
 *
 * 로컬 트리·GitPanel·WorktreePanel 을 재사용하지 않는다(명세 ④). 저 셋은 로컬
 * 정본이고 원격 차원을 끼워 넣는 회귀 위험이 얻는 것보다 크다 — 같은 정보를
 * 보이되 뷰 모델을 따로 둔다. 최상위 호스트 탭·표면 트리의 host 차원은 여전히
 * R3 의 몫이라, 이 뷰는 **원격 패널 안**을 넘지 않는다.
 *
 * 폴링하지 않는다. 한 번의 조회가 SSH 왕복 한 번이고, 자동 반복에는 상한이
 * 있어야 한다(R1 이 남긴 규칙) — 갈래를 열 때 한 번 읽고 그 뒤는 새로고침이다.
 */
function RemoteDataPanel({ hostId }: { hostId: string }) {
  const d = useRemoteHostData(hostId);
  const [tab, setTab] = useState<RemoteDataTab>("tree");
  const { root, openDir, reloadStatus, reloadLog, reloadWorktrees, reloadRoots } = d;

  // 갈래를 처음 열면 한 번 읽는다. 판정의 축은 **내용이 아니라 시도**다(R1):
  // "값이 비었으면 다시 읽는다" 로 쓰면 빈 응답이 정상적으로 오는 순간 판정이
  // true 로 돌아와 effect 가 무한히 재발화하고, 그 한 바퀴가 새 SSH 연결 1회다.
  // 이 화면에서도 실제로 재현됐다(빈 폴더 하나 → 무한 재조회). 그 뒤의 재시도는
  // 사용자가 누르는 버튼에만 남는다 — 화면에 계속 떠 있으므로 잃는 것은 없다.
  useEffect(() => {
    if (!root) return;
    if (tab === "tree" && !d.dir.attempted) openDir("");
    if (tab === "git") {
      if (!d.status.attempted) reloadStatus();
      if (!d.log.attempted) reloadLog();
    }
    if (tab === "worktrees") {
      if (!d.worktrees.attempted) reloadWorktrees();
      if (!d.roots.attempted) reloadRoots();
    }
    // 조회 함수는 호출마다 새 클로저라 의존성에서 뺀다(넣으면 매 렌더 재조회).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    root,
    tab,
    d.dir.attempted,
    d.status.attempted,
    d.log.attempted,
    d.worktrees.attempted,
    d.roots.attempted,
  ]);

  const projects = d.projects.value;
  return (
    <div className="remote-data">
      <div className="remote-data-head">
        <select
          value={root}
          onChange={(e) => d.setRoot(e.target.value)}
          aria-label="원격 프로젝트"
          disabled={d.projects.loading && !projects}
        >
          <option value="">
            {d.projects.loading && !projects
              ? "프로젝트 읽는 중…"
              : projects && projects.projects.length === 0
                ? "이 호스트가 발행한 프로젝트가 없습니다"
                : "프로젝트 선택…"}
          </option>
          {(projects?.projects ?? []).map((p) => (
            <option key={p.path} value={p.path} title={p.path}>
              {p.name}
              {p.branch ? ` (${p.branch})` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="remote-fetch"
          onClick={() => d.reloadProjects(true)}
          title="호스트의 프로젝트 목록을 캐시 없이 다시 읽습니다"
        >
          목록 새로고침
        </button>
      </div>
      <LoadNote of={d.projects} onRetry={() => d.reloadProjects(true)} />
      {/* 프로젝트가 0개인 것은 정상적인 답이고 설정을 못 읽은 것은 아니다 —
          데몬이 그 차이를 `notes` 로 말해 주므로 그대로 보인다. */}
      {(projects?.notes ?? []).map((n) => (
        <p key={n} className="remote-cut" role="status">
          호스트 메모: {n}
        </p>
      ))}

      {!root ? (
        <p className="remote-empty">프로젝트를 고르면 그 트리·Git·워크트리를 봅니다.</p>
      ) : (
        <>
          <div className="remote-data-tabs">
            {(
              [
                ["tree", "파일"],
                ["git", "Git"],
                ["worktrees", "워크트리"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`remote-data-tab${tab === id ? " remote-data-tab-on" : ""}`}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "tree" ? <RemoteTreeView d={d} /> : null}
          {tab === "git" ? <RemoteGitView d={d} /> : null}
          {tab === "worktrees" ? <RemoteWorktreeView d={d} /> : null}
        </>
      )}
    </div>
  );
}

/** 폴더 하나씩 — 로컬 트리를 흉내 내지 않고, 페이지가 폴더 전체인 척하지도 않는다. */
function RemoteTreeView({ d }: { d: RemoteHostDataView }) {
  const dir = d.dir.value;
  const up = parentPath(d.root, d.path);
  return (
    <div className="remote-data-body">
      <div className="remote-crumb">
        <button
          type="button"
          className="remote-fetch"
          disabled={up === null}
          onClick={() => (up === null ? undefined : d.openDir(up))}
          title={up === null ? "여기가 프로젝트 루트입니다." : "한 단계 위로"}
        >
          위로
        </button>
        <code title={d.path || d.root}>{relPath(d.root, d.path) || "/"}</code>
        <button type="button" className="remote-fetch" onClick={d.reloadDir}>
          새로고침
        </button>
      </div>
      <LoadNote of={d.dir} onRetry={d.reloadDir} />
      {d.dir.loading && !dir ? <p className="remote-empty">읽는 중…</p> : null}
      {dir ? (
        <>
          <ul className="remote-tree">
            {dir.entries.map((e) => (
              <li
                key={e.path}
                className={`remote-tree-row${e.is_ignored ? " remote-tree-ignored" : ""}`}
              >
                {e.is_dir ? (
                  <button type="button" className="remote-tree-dir" onClick={() => d.openDir(e.path)}>
                    📁 {e.name}
                  </button>
                ) : (
                  <span className="remote-tree-file">📄 {e.name}</span>
                )}
              </li>
            ))}
          </ul>
          {dir.entries.length === 0 ? <p className="remote-empty">빈 폴더입니다.</p> : null}
          {/* 더 있는데 안 보여주면 화면이 그것을 말한다 — 페이지가 폴더 전체처럼
              보이는 것이 이 경로의 무음 유실이다. */}
          <CutNote note={dirCutNote(dir)} onMore={dirHasMore(dir) ? d.moreDir : undefined} />
        </>
      ) : null}
    </div>
  );
}

/** 상태 + 히스토리. 로컬 GitPanel 은 건드리지 않는다 — 여기 있는 것은 읽기뿐이다. */
function RemoteGitView({ d }: { d: RemoteHostDataView }) {
  const s = d.status.value;
  const log = d.log.value;
  return (
    <div className="remote-data-body">
      <LoadNote of={d.status} onRetry={d.reloadStatus} />
      {s ? (
        s.is_repo ? (
          <div className="remote-git-head">
            <strong>{s.branch}</strong>
            {s.upstream ? <span>↑{s.ahead} ↓{s.behind} · {s.upstream}</span> : <span>업스트림 없음</span>}
            {s.merging ? <span className="remote-git-flag">머지 중</span> : null}
            {s.reverting ? <span className="remote-git-flag">리버트 중</span> : null}
            <button type="button" className="remote-fetch" onClick={d.reloadStatus}>
              새로고침
            </button>
          </div>
        ) : (
          <p className="remote-empty">이 프로젝트는 git 저장소가 아닙니다.</p>
        )
      ) : null}
      {s?.is_repo ? (
        <ul className="remote-changes">
          {s.changes.length === 0 ? <li className="remote-empty">변경 없음</li> : null}
          {s.changes.map((c) => (
            <li
              key={`${c.staged ? "s" : "w"}:${c.path}`}
              className={`remote-change${c.conflicted ? " remote-change-conflict" : ""}`}
            >
              <span className="remote-change-code">{c.code}</span>
              <span className="remote-change-path" title={c.path}>
                {c.path}
              </span>
              {c.staged ? <span className="remote-change-staged">staged</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <LoadNote of={d.log} onRetry={d.reloadLog} />
      {log ? (
        <>
          <ul className="remote-commits">
            {log.commits.length === 0 ? <li className="remote-empty">커밋이 없습니다.</li> : null}
            {log.commits.map((c) => (
              <li key={c.hash} className="remote-commit">
                <code>{c.short}</code>
                <span className="remote-commit-subject" title={c.subject}>
                  {c.subject}
                </span>
                <span className="remote-commit-meta">
                  {c.author} · {c.date}
                </span>
              </li>
            ))}
          </ul>
          {/* 주소가 있는 잘림에만 버튼이 붙는다. 주소 없는 잘림(데몬 페이징 상한)은
              누를 것이 없다는 사실까지 문장이 말한다. */}
          <CutNote note={logCutNote(log)} onMore={logHasMore(log) ? d.moreLog : undefined} />
        </>
      ) : null}
    </div>
  );
}

/** 워크트리 + 하위 저장소. 여기가 이 화면에서 잘림이 가장 조용한 자리다. */
function RemoteWorktreeView({ d }: { d: RemoteHostDataView }) {
  const w = d.worktrees.value;
  const r = d.roots.value;
  return (
    <div className="remote-data-body">
      <LoadNote of={d.worktrees} onRetry={d.reloadWorktrees} />
      {w ? (
        <ul className="remote-worktrees">
          {w.worktrees.length === 0 ? <li className="remote-empty">워크트리가 없습니다.</li> : null}
          {w.worktrees.map((t) => (
            <li key={t.path} className="remote-worktree">
              <span className="remote-worktree-branch">{t.branch}</span>
              {t.is_main ? <span className="remote-worktree-main">main</span> : null}
              <code title={t.path}>{t.path}</code>
              <span className="remote-commit-meta">{t.head.slice(0, 7)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="remote-crumb">
        <span>하위 저장소</span>
        <button type="button" className="remote-fetch" onClick={d.reloadRoots}>
          다시 스캔
        </button>
      </div>
      <LoadNote of={d.roots} onRetry={d.reloadRoots} />
      {r ? (
        <>
          <ul className="remote-worktrees">
            {r.roots.length === 0 ? <li className="remote-empty">하위 저장소가 없습니다.</li> : null}
            {r.roots.map((g) => (
              <li key={g.path} className="remote-worktree">
                <span className="remote-worktree-branch">{g.branch}</span>
                <code title={g.path}>{g.path}</code>
              </li>
            ))}
          </ul>
          {/* 이어받을 주소가 **없는** 잘림 — 그래서 "더 보기"가 아니라 사실만 적는다. */}
          <CutNote note={rootsCutNote(r)} />
          {/* …그리고 응답으로는 알 수 없는 절단(2만 디렉터리)은 늘 말한다. 이
              프로젝트에 등재된 무음 유실이 바로 그것이다. */}
          <p className="remote-cut" role="status">
            {GIT_ROOTS_CAVEAT}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** 판정({@link ControlGate})을 그대로 입는 버튼 — 못 누르는 이유가 곧 title 이다. */
function GateButton({
  gate,
  onClick,
  children,
}: {
  gate: ControlGate;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="remote-act"
      disabled={!gate.enabled}
      title={gate.hint}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * 호스트 하나에 새 에이전트를 띄우는 폼.
 *
 * 계정은 **목록에서 고른다**. 홈 경로를 적는 칸이 없는 것은 빠뜨린 게 아니라
 * 데몬의 규칙이다(R1b에서 경로 필드가 선에서 제거됐다) — 여기서 텍스트로
 * 되살리면 계정 목록이 장식이 된다. 목록을 못 읽었으면 그 사실을 말하고, 그때는
 * 데몬 기본 계정으로만 띄울 수 있다.
 */
function NewSessionForm({ hostId, onSpawned }: { hostId: string; onSpawned: () => void }) {
  const [agent, setAgent] = useState<string>(SPAWN_AGENTS[0]);
  const [cwd, setCwd] = useState("");
  const [account, setAccount] = useState("");
  const [label, setLabel] = useState("");
  const [accounts, setAccounts] = useState<RemoteAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [accError, setAccError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const loadAccounts = useCallback(() => {
    setLoading(true);
    setAccError(null);
    invoke<unknown>("remote_accounts", { hostId })
      .then((v) => setAccounts(parseAccounts(v)))
      .catch((e) => setAccError(errText(e, "계정 목록을 읽지 못했습니다.")))
      .finally(() => setLoading(false));
  }, [hostId]);

  useEffect(() => loadAccounts(), [loadAccounts]);

  const choices = useMemo(() => accountChoices(accounts, agent), [accounts, agent]);
  // 목록이 바뀌거나(로드·에이전트 전환) 고른 계정이 그 목록에 없으면 기본값으로
  // 되돌린다 — 화면에 없는 id 가 그대로 스폰에 실려 가지 않게.
  useEffect(() => {
    setAccount((a) => (a && choices.some((c) => c.id === a) ? a : defaultAccountId(accounts, agent)));
  }, [choices, accounts, agent]);

  function submit() {
    const req = spawnRequest(hostId, { agent, cwd, account, label }, choices.map((c) => c.id));
    if (!req.ok) {
      setError(req.error);
      setDone(null);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    invoke<string>("remote_spawn", { ...req.args })
      .then((key) => {
        // 목록은 폴링이 곧 물어 오지만, 한 번 밀어 두면 방금 만든 것이 바로 뜬다.
        setDone(`새 세션을 시작했습니다 — ${key}`);
        setCwd("");
        setLabel("");
        onSpawned();
      })
      .catch((e) => setError(errText(e, "세션을 시작하지 못했습니다.")))
      .finally(() => setBusy(false));
  }

  return (
    <div className="remote-spawn">
      <div className="remote-spawn-row">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="에이전트">
          {SPAWN_AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          aria-label="원격 계정"
          disabled={loading || choices.length === 0}
        >
          <option value="">
            {loading ? "계정 읽는 중…" : choices.length === 0 ? "계정 없음 — 기본" : "기본 계정"}
          </option>
          {choices.map((a) => (
            <option key={a.id} value={a.id} title={a.home ?? undefined}>
              {a.displayName}
              {a.isDefault ? " (기본)" : ""}
            </option>
          ))}
        </select>
      </div>
      <input
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="원격 작업 디렉터리 (절대 경로)"
        aria-label="원격 작업 디렉터리"
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="라벨 (선택)"
        aria-label="세션 라벨"
      />
      <div className="remote-spawn-row">
        <button type="button" onClick={submit} disabled={busy}>
          {busy ? "띄우는 중…" : "띄우기"}
        </button>
        {accError ? (
          <button type="button" onClick={loadAccounts} disabled={loading}>
            계정 다시 읽기
          </button>
        ) : null}
      </div>
      {accError ? (
        <div className="claudeterm-refine-note" role="alert">
          계정 목록을 읽지 못했습니다 — {accError} (기본 계정으로만 띄울 수 있습니다)
        </div>
      ) : null}
      {error ? (
        <div className="claudeterm-refine-note" role="alert">
          {error}
        </div>
      ) : null}
      {done ? <div className="remote-spawn-done">{done}</div> : null}
    </div>
  );
}

/**
 * 패널 아래에 붙는 **한 개뿐인** 원격 터미널.
 *
 * `remote_attach` 가 돌려준 id 는 평범한 로컬 세션 id 라, 여기서 하는 일은
 * `TerminalPanel` 이 늘 하던 것과 같다: 구독을 **먼저** 걸고(그 사이 청크는
 * 버퍼에 쌓인다), 스냅샷으로 화면을 세우고, `seq` 게이트로 흘려보낸다.
 *
 * 다른 것은 두 가지다. 크기는 두 곳으로 간다 — `terminal_resize` 는 로컬 장부,
 * 실제 pty 는 데몬이 들고 있어 `remote_resize` 가 SSH 왕복 한 번으로 바꾼다(그래서
 * 멎은 크기만 보낸다). 그리고 끝났을 때는 `remote-terminal-ended` 가 사유를 주므로
 * 그것을 화면에 찍는다 — 이 이벤트가 따로 있는 이유가 조용한 검은 상자를 없애는
 * 것이다.
 */
function RemoteTerminalView({
  hostId,
  remoteId,
  localId,
  sessionKey,
  ended,
  onClose,
}: {
  hostId: string;
  remoteId: number;
  localId: number;
  sessionKey: string;
  /** 이 터미널이 멈춘 이유 — 패널이 구독해 둔 것(늦게 마운트해도 읽는다). */
  ended: string | null;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 같은 사유를 두 번 찍지 않는다(리렌더마다 한 줄씩 늘지 않게). */
  const saidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ended || saidRef.current === ended) return;
    saidRef.current = ended;
    termRef.current?.write(`\r\n\x1b[2m[${ended}]\x1b[0m\r\n`);
  }, [ended]);

  const theme = useAppStore((s) => s.theme);
  const termColors = useAppStore((s) => s.termColors);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, termColors);
  }, [theme, termColors]);

  const fontSize = useAppStore((s) => s.fontSize);
  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
  }, [fontSize]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const st = useAppStore.getState();
    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: st.fontSize,
      theme: xtermTheme(st.theme, st.termColors),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* 아직 배치 전 — ResizeObserver 가 곧 맞춘다 */
    }
    // `터미널` 을 누른 직후에만 뜨는 창이라 포커스를 가져온다 — 안 그러면 첫
    // 키 입력이 사이드바로 가고 사용자는 터미널이 죽은 줄 안다.
    term.focus();

    let disposed = false;
    let unOutput: UnlistenFn | undefined;
    let ready = false;
    let lastApplied = 0;
    let pendingTotal = 0;
    let pendingDropped = false;
    const pending: TerminalOutputEvent[] = [];
    const applyLive = (ev: TerminalOutputEvent) => {
      if (ev.session_id === localId && ev.seq > lastApplied) {
        term.write(decodePtyData(ev.data));
        lastApplied = ev.seq;
      }
    };

    void (async () => {
      // 구독 **먼저** — 스냅샷 왕복 동안 나온 바이트는 이벤트로만 오고, 스냅샷에는
      // 없다(로컬 터미널과 같은 계약).
      //
      // 종료 사유(`remote-terminal-ended`)는 여기서 구독하지 않는다: 이 컴포넌트는
      // `remote_attach` 가 **돌아온 뒤에야** 마운트되므로, 빠른 실패의 사유는 이미
      // 지나갔다(R3). 패널이 마운트 때 구독해 두고 `ended` 로 내려 준다.
      try {
        unOutput = await listen<TerminalOutputEvent>(ptyEventName(localId), (e) => {
          if (!ready) {
            const r = pushPendingCapped(pending, e.payload, pendingTotal);
            pendingTotal = r.total;
            pendingDropped ||= r.dropped;
          } else applyLive(e.payload);
        });
      } catch (e) {
        // 구독이 실패하면 스냅샷 단계까지 가더라도 이후 출력이 한 바이트도 오지
        // 않는다 — 멈춘 화면을 살아 있는 것으로 보이게 두지 않는다(R18).
        if (!disposed) setError(errText(e, "터미널 출력을 구독하지 못했습니다."));
        return;
      }
      if (disposed) {
        unOutput?.();
        return;
      }
      try {
        const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: localId });
        if (disposed) return;
        term.write(decodePtyData(snap.data));
        lastApplied = snap.last_seq;
      } catch (e) {
        // 스냅샷 실패 = 이 세션이 없다는 뜻이다. 빈 검은 화면으로 두지 않는다.
        if (!disposed) setError(errText(e, "터미널 화면을 읽지 못했습니다."));
      }
      if (disposed) return;
      // 스냅샷 왕복 동안 버퍼가 넘쳤으면 그 갭은 이어 붙일 수 없다 — 그대로
      // 흘리면 ESC 시퀀스가 중간에서 잘린 화면이 남는다. 버린 뒤 지금 화면을
      // 다시 뜬다(로컬 터미널의 같은 처방, 여기서는 1회).
      if (pendingDropped) {
        pending.length = 0;
        pendingTotal = 0;
        try {
          const again = await invoke<SnapshotResult>("terminal_snapshot", { id: localId });
          if (disposed) return;
          term.write(new TextEncoder().encode("\x1bc")); // RIS — write 큐 순서로 초기화
          term.write(decodePtyData(again.data));
          lastApplied = again.last_seq;
        } catch (e) {
          if (!disposed) setError(errText(e, "출력을 따라잡지 못했습니다."));
        }
      }
      if (disposed) return;
      ready = true;
      for (const ev of pending) applyLive(ev);
      pending.length = 0;
      pendingTotal = 0;
    })();

    const onData = term.onData((d) => {
      invoke("terminal_write", {
        id: localId,
        data: Array.from(new TextEncoder().encode(d)),
      }).catch((e) => setError(errText(e, "입력을 보내지 못했습니다.")));
    });

    // 크기는 두 곳으로. 로컬은 매번(장부일 뿐이라 싸다), 원격 pty 는 멎은 뒤 한 번.
    //
    // 기준선은 **데몬이 답한 크기**다(`nextRemoteResize`). 보낸 값을 곧바로
    // 기준으로 적으면 실패한 리사이즈가 그 크기를 봉인하고, 늦게 도착한 옛 답이
    // 새 답을 덮는다 — `seq` 가 그 두 번째를 막는다.
    const resize: { acked: TermSize | null; inFlight: TermSize | null } = {
      acked: null,
      inFlight: null,
    };
    let resizeSeq = 0;
    let settle: number | undefined;
    const onResize = term.onResize(() => {
      const size = { cols: term.cols, rows: term.rows };
      invoke("terminal_resize", { id: localId, cols: size.cols, rows: size.rows }).catch(() => {});
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (disposed || !nextRemoteResize(resize, size)) return;
        const mine = ++resizeSeq;
        resize.inFlight = size;
        invoke<TermSize>("remote_resize", {
          hostId,
          id: remoteId,
          cols: size.cols,
          rows: size.rows,
        })
          .then((got) => {
            if (mine !== resizeSeq) return; // 더 새 요청이 떠 있다 — 그 답이 정본
            resize.inFlight = null;
            // 요청이 아니라 **답**. 데몬이 조정했다면 화면은 그 값을 기준으로
            // 다음을 판단해야 한다.
            resize.acked = got;
          })
          .catch((e) => {
            if (mine === resizeSeq) resize.inFlight = null;
            if (!disposed) setError(errText(e, "원격 화면 크기를 바꾸지 못했습니다."));
          });
      }, REMOTE_RESIZE_DEBOUNCE_MS);
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* 일시적인 배치 오류 */
      }
    });
    ro.observe(el);

    return () => {
      disposed = true;
      window.clearTimeout(settle);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      unOutput?.();
      term.dispose();
      termRef.current = null;
    };
    // 세션이 바뀌면 key 로 통째로 다시 마운트된다(위 호출부).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className={`remote-term${ended ? " remote-term-ended" : ""}`}>
      <header className="remote-term-head">
        <code className="remote-term-key" title={sessionKey}>
          {sessionKey}
        </code>
        {ended ? <span className="remote-term-why">{ended}</span> : null}
        <button type="button" onClick={onClose} title="이 터미널만 닫습니다 — 원격 세션은 계속 돕니다">
          닫기
        </button>
      </header>
      {error ? (
        <div className="claudeterm-refine-note" role="alert">
          {error}
        </div>
      ) : null}
      <div className="remote-term-host" ref={hostRef} />
    </section>
  );
}
