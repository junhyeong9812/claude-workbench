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
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import {
  noticeBadge,
  phaseLabel,
  resumeLabel,
  useRemoteHosts,
  type RemoteHostSnapshot,
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

export function RemoteHostPanel() {
  const connections = useAppStore((s) => s.savedConnections);
  const { hosts, live, refresh } = useRemoteHosts();
  const [connecting, setConnecting] = useState(false);
  const [pick, setPick] = useState<string>("");
  const [cwcd, setCwcd] = useState("");
  const [socket, setSocket] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const attached = useMemo(() => new Set(hosts.map((h) => h.host_id)), [hosts]);
  const candidates = connections.filter((c) => !attached.has(c.id));

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
          seenSeq={seen[h.host_id] ?? 0}
          onSeen={() =>
            setSeen((s) => ({
              ...s,
              [h.host_id]: h.notices.length ? h.notices[h.notices.length - 1].seq : 0,
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
  seenSeq,
  onSeen,
  openIds,
  onToggle,
  onDisconnect,
}: {
  host: RemoteHostSnapshot;
  live: Map<number, import("../state/remoteHosts").RemoteLiveTimeline>;
  seenSeq: number;
  onSeen: () => void;
  openIds: Record<number, boolean>;
  onToggle: (id: number) => void;
  onDisconnect: () => void;
}) {
  const badge = noticeBadge(host.notices, seenSeq);
  const resume = resumeLabel(host.resume);
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
  open,
  onToggle,
}: {
  s: RemoteSessionMeta;
  live: import("../state/remoteHosts").RemoteLiveTimeline | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const items = live?.items ?? [];
  const turns = live?.turns ?? [];
  const model = live?.model ?? s.model;
  const ctx = live?.ctxTokens ?? s.ctx_tokens;
  return (
    <li className={`remote-session${s.closed ? " remote-session-closed" : ""}`}>
      <button type="button" className="remote-session-head" onClick={onToggle}>
        <span className="remote-caret">{open ? "▾" : "▸"}</span>
        <span className="remote-agent">{s.agent}</span>
        <span className="remote-session-name">{s.label || s.session_id.slice(0, 8)}</span>
        <span className={`remote-state remote-state-${s.state}`}>{s.state}</span>
        <span className="remote-counts">
          턴 {Math.max(s.turns, turns.length)} · 항목 {Math.max(s.items, items.length)}
        </span>
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
          {s.body_omitted && items.length === 0 ? (
            <p className="remote-empty">
              끝난 세션이라 본문이 스냅샷에 실리지 않았습니다 — 데몬이 아직 갖고 있으면 원격에서
              따로 가져올 수 있습니다.
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
          {items.length === 0 && turns.length === 0 && !s.body_omitted ? (
            <p className="remote-empty">아직 받은 타임라인이 없습니다.</p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
