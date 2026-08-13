/**
 * 원격 호스트 패널(R2a) — 다른 PC의 `cwcd` 데몬에 붙었다 떼는 **최소** UI.
 *
 * 여기서 하는 일은 셋뿐이다: 저장된 SSH 연결 하나를 호스트로 붙이고, 연결
 * 상태와 데몬이 한 말을 보이고, 그 호스트에서 도는 세션들의 타임라인이 흐르는
 * 것을 보인다. 최상위 호스트 탭·평행 상태 트리는 R3의 몫이고, 스폰·종료·입력은
 * R2b의 몫이라 이 패널에는 없다 — 있는 버튼은 전부 읽기다.
 *
 * 새 UI 어휘를 만들지 않았다: 알림 줄은 정리 패널·시드 배너와 같은
 * `claudeterm-refine-note`, 행·배지는 사이드바 패널들이 쓰는 클래스를 쓴다.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import {
  countsLabel,
  noticeBadge,
  phaseLabel,
  pickTimeline,
  resumeLabel,
  seenKey,
  seenSeqOf,
  shouldFetchBody,
  staleSeenKeys,
  useRemoteHosts,
  type RemoteHostSnapshot,
  type RemoteLiveTimeline,
  type RemoteSessionMeta,
} from "../state/remoteHosts";
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

export function RemoteHostPanel() {
  const connections = useAppStore((s) => s.savedConnections);
  const { hosts, live, fetched, fetching, fetchError, fetchBody, refresh } = useRemoteHosts();
  const [connecting, setConnecting] = useState(false);
  const [pick, setPick] = useState<string>("");
  const [cwcd, setCwcd] = useState("");
  const [socket, setSocket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});

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
        />
      ))}
    </div>
  );
}

function HostCard({
  host,
  live,
  fetched,
  fetching,
  fetchError,
  onFetch,
  seenSeq,
  onSeen,
  openIds,
  onToggle,
  onDisconnect,
}: {
  host: RemoteHostSnapshot;
  live: Map<number, RemoteLiveTimeline>;
  fetched: Map<number, RemoteLiveTimeline>;
  fetching: ReadonlySet<number>;
  fetchError: Record<number, string>;
  onFetch: (id: number) => void;
  seenSeq: number;
  onSeen: () => void;
  openIds: Record<number, boolean>;
  onToggle: (id: number) => void;
  onDisconnect: () => void;
}) {
  const badge = noticeBadge(host.notices, seenSeq);
  const resume = resumeLabel(host.resume);
  const age = ageLabel(host.last_frame_at_ms);
  return (
    <section className="remote-host">
      <header className="remote-host-head">
        <span className={`remote-dot remote-dot-${host.phase}`} aria-hidden />
        <strong>{host.label}</strong>
        <span className="remote-phase">{phaseLabel(host.phase)}</span>
        {badge ? (
          <span className={`remote-badge remote-badge-${badge.level}`}>{badge.count}</span>
        ) : null}
        <button type="button" onClick={onDisconnect} title="이 호스트에서 떼기">
          떼기
        </button>
      </header>

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
            fetchError={fetchError[s.id]}
            onFetch={() => onFetch(s.id)}
            open={!!openIds[s.id]}
            onToggle={() => onToggle(s.id)}
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
  fetchError,
  onFetch,
  open,
  onToggle,
}: {
  s: RemoteSessionMeta;
  live: RemoteLiveTimeline | undefined;
  fetched: RemoteLiveTimeline | undefined;
  fetching: boolean;
  fetchError: string | undefined;
  onFetch: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const shown = pickTimeline(live, fetched);
  const items = shown?.items ?? [];
  const turns = shown?.turns ?? [];
  const model = shown?.model ?? s.model;
  const ctx = shown?.ctxTokens ?? s.ctx_tokens;
  const recoverable = shouldFetchBody(s, shown);

  // 펼치면 가져온다. 데몬은 끝난 세션의 본문을 스냅샷에 싣지 않고
  // (`items_omitted`) 앞으로도 이벤트를 내지 않으므로, 자동 조회가 없으면
  // 사용자는 "따로 가져올 수 있습니다"라는 문장만 읽고 아무것도 못 본다.
  // 보관 기간이 지나면 데몬이 NotFound 로 답하고, 그 사유가 화면에 뜬다.
  useEffect(() => {
    if (open && recoverable && !fetching && fetchError === undefined) onFetch();
    // onFetch 는 호출마다 새 클로저라 의존성에서 뺀다(넣으면 매 렌더 재조회).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recoverable, fetching, fetchError]);

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
            <p key={`t${n}`} className="remote-turn">
              <span className="remote-turn-no">Q{n}</span>
              {text}
            </p>
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
