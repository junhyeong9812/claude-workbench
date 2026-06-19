import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";
import { TimelineView, type TimelineItem } from "./TimelineView";

/** Params attached to a Claude panel. `acpId` is persisted into the dockview
 * layout so a remount (tab/project switch) re-attaches the same session. */
export interface ClaudeParams {
  kind?: string;
  title?: string;
  acpId?: number;
  /** If set, the panel opens a **saved** session read-only (S3c reopen): it
   * loads that session's persisted timeline instead of starting a live one. */
  loadSessionId?: string;
}

/** Mirror of `core_acp::AcpEvent` (serde tag = "type", snake_case) plus the
 * relay's `id`. */
interface PermOption {
  id: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}

type AcpEvent =
  | { id: number; type: "connected"; session_id: string }
  | { id: number; type: "agent_message_chunk"; text: string }
  | { id: number; type: "auth_required"; command: string }
  | {
      id: number;
      type: "permission_request";
      request_id: number;
      title: string;
      preview: string;
      locations: string[];
      options: PermOption[];
    }
  | ({ id: number; type: "timeline_item" } & TimelineItem)
  | { id: number; type: "turn_started"; turn: number; prompt: string; session_id: string }
  | { id: number; type: "turn_answer"; turn: number; text: string; session_id: string }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "disconnected" };

/** A persisted timeline record (from `acp_session_timeline`, S3c reopen). */
type TimelineRecord =
  | ({ type: "timeline_item" } & TimelineItem)
  | { type: "turn_started"; turn: number; prompt: string; session_id: string }
  | { type: "turn_answer"; turn: number; text: string; session_id: string };

/** A pending tool approval awaiting the user's decision (S2b-2). */
interface PermissionRequest {
  request_id: number;
  title: string;
  preview: string;
  locations: string[];
  options: PermOption[];
}

type Status = "starting" | "auth" | "ready" | "error" | "closed";

/** Tauri rejects commands with the serialized `AppError` (`{ message }`), so a
 * bare `String(err)` yields "[object Object]". Pull the message out. */
function errString(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * An ACP-backed Claude conversation panel (S1).
 *
 * Lifecycle mirrors the terminal: mount = start-or-attach a session; the
 * session lives in the Rust `AcpHost` across tab/project switches and is closed
 * on real panel removal by `MainArea`'s `onDidRemovePanel`.
 *
 * Auth: the fixed adapter does not implement the ACP `authenticate` RPC — login
 * is out-of-band (`claude /login` in a terminal). The host surfaces an
 * `auth_required` event (with the login command) only when the user is actually
 * not logged in; we show that command and a Reconnect button.
 */
export function ClaudePanel(props: IDockviewPanelProps<ClaudeParams>) {
  // Re-attaching to a persisted session (tab/project switch): the live
  // `Connected` event already fired on first mount and won't repeat, so start
  // optimistically `ready` (a dead session surfaces via a prompt error).
  const [status, setStatus] = useState<Status>(
    props.params.loadSessionId != null ? "closed" : props.params.acpId != null ? "ready" : "starting",
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [authCommand, setAuthCommand] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [input, setInput] = useState("");
  // True from sending a prompt until its first streamed token — drives the
  // "Claude is thinking…" indicator (the wait before tokens arrive).
  const [thinking, setThinking] = useState(false);
  // Pending tool approvals (S2b-2). Claude ran nothing until the user decides.
  const [pendingPerms, setPendingPerms] = useState<PermissionRequest[]>([]);
  // This session's change timeline (S3), shown in a toggleable side column.
  const [tlItems, setTlItems] = useState<Map<string, TimelineItem>>(new Map());
  const [tlTurns, setTlTurns] = useState<Map<number, string>>(new Map());
  const [tlAnswers, setTlAnswers] = useState<Map<number, string>>(new Map());
  const [showTimeline, setShowTimeline] = useState(true);

  // The panel's ACP id; a ref so the listener (registered before `acp_start`
  // resolves) can filter without re-subscribing.
  const acpIdRef = useRef<number | null>(props.params.acpId ?? null);
  // Latest params (updated every render) so writes never clobber fields set by
  // an earlier `updateParameters` captured in a stale closure.
  const paramsRef = useRef(props.params);
  paramsRef.current = props.params;
  // The adapter session id (for delete/persistence). Known up-front for a
  // reopened session; captured from the `connected` event for a live one.
  const sessionIdRef = useRef<string | null>(props.params.loadSessionId ?? null);
  const readOnly = props.params.loadSessionId != null;
  const mountedRef = useRef(true);
  const logRef = useRef<HTMLDivElement | null>(null);
  // True while an IME composition is in progress (Hangul/CJK). Enter must not
  // submit mid-composition — it's the key that commits the composing syllable.
  const composingRef = useRef(false);

  // Start a fresh adapter session and adopt its id. Used on first mount and on
  // Reconnect (after the user logs in out-of-band).
  const connect = useCallback(async () => {
    setMessages([]);
    setErrorMsg(null);
    setAuthCommand(null);
    setThinking(false);
    setPendingPerms([]);
    setTlItems(new Map());
    setTlTurns(new Map());
    setTlAnswers(new Map());
    setStatus("starting");
    const cwd = useAppStore.getState().activeProject ?? null;
    try {
      const id = await invoke<number>("acp_start", { cwd });
      if (!mountedRef.current) {
        invoke("acp_close", { id }).catch(() => {});
        return;
      }
      acpIdRef.current = id;
      props.api.updateParameters({ ...props.params, acpId: id });
    } catch (err) {
      setErrorMsg(errString(err));
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Append a streamed chunk: extend the in-flight assistant message, or start a
  // new one if the last turn was the user's.
  const appendChunk = (text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { role: "assistant", text }];
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    const handle = (ev: AcpEvent) => {
      if (ev.id !== acpIdRef.current) return;
      switch (ev.type) {
        case "connected":
          sessionIdRef.current = ev.session_id;
          // Publish the session id into params so the tab (×→삭제) and the
          // "+ Claude" open-filter can see it.
          props.api.updateParameters({ ...paramsRef.current, sessionId: ev.session_id });
          setStatus("ready");
          setAuthCommand(null);
          break;
        case "agent_message_chunk":
          setThinking(false); // first token arrived
          appendChunk(ev.text);
          break;
        case "auth_required":
          setThinking(false);
          setAuthCommand(ev.command);
          setStatus("auth");
          break;
        case "permission_request":
          // Claude is now blocked on our approval, not thinking.
          setThinking(false);
          setPendingPerms((prev) => [
            ...prev,
            {
              request_id: ev.request_id,
              title: ev.title,
              preview: ev.preview,
              locations: ev.locations,
              options: ev.options,
            },
          ]);
          break;
        case "turn_started":
          setTlTurns((prev) => new Map(prev).set(ev.turn, ev.prompt));
          break;
        case "turn_answer":
          setTlAnswers((prev) => new Map(prev).set(ev.turn, ev.text));
          break;
        case "timeline_item":
          setTlItems((prev) => new Map(prev).set(ev.tool_call_id, ev));
          break;
        case "error":
          setThinking(false);
          setErrorMsg(ev.message);
          setStatus("error");
          break;
        case "disconnected":
          setThinking(false);
          setPendingPerms([]); // host gone — approvals are moot
          // Auth/error states own the message; don't overwrite them.
          setStatus((s) => (s === "error" || s === "auth" ? s : "closed"));
          break;
      }
    };

    (async () => {
      const fn = await listen<AcpEvent>("acp-event", (e) => handle(e.payload));
      // If we were torn down while registering, unlisten immediately — a
      // StrictMode double-mount (dev) would otherwise leave two live listeners
      // that double every streamed chunk.
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;

      if (readOnly && props.params.loadSessionId) {
        // Reopen a saved session read-only: load its persisted timeline; no
        // live adapter connection (S3c).
        const project = useAppStore.getState().activeProject ?? null;
        const events = await invoke<TimelineRecord[]>("acp_session_timeline", {
          project,
          sessionId: props.params.loadSessionId,
        }).catch(() => [] as TimelineRecord[]);
        if (disposed) return;
        const tt = new Map<number, string>();
        const ta = new Map<number, string>();
        const ti = new Map<string, TimelineItem>();
        for (const ev of events) {
          if (ev.type === "turn_started") tt.set(ev.turn, ev.prompt);
          else if (ev.type === "turn_answer") ta.set(ev.turn, ev.text);
          else if (ev.type === "timeline_item") ti.set(ev.tool_call_id, ev);
        }
        setTlTurns(tt);
        setTlAnswers(ta);
        setTlItems(ti);
        setShowTimeline(true);
        setStatus("closed");
      } else if (acpIdRef.current == null) {
        // Fresh panel -> start a new session.
        await connect();
      } else {
        // Re-attach: the persisted id survives tab switches but not an app
        // restart (which empties the host map). Verify it's still live, and
        // start fresh if it's a stale id.
        const alive = await invoke<boolean>("acp_alive", { id: acpIdRef.current }).catch(
          () => false,
        );
        if (disposed) return;
        if (alive) setStatus("ready");
        else await connect();
      }
    })();

    return () => {
      // Detach only — the session lives on for re-attach (closed on panel
      // removal by MainArea).
      disposed = true;
      mountedRef.current = false;
      if (unlisten) unlisten();
    };
  }, [connect]);

  // Keep the log pinned to the latest message (and to the thinking indicator).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const send = () => {
    const text = input.trim();
    const id = acpIdRef.current;
    if (!text || id == null || status !== "ready") return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setThinking(true);
    invoke("acp_prompt", { id, text }).catch((err) => {
      setThinking(false);
      setErrorMsg(errString(err));
    });
  };

  const respondPerm = (requestId: number, optionId: string) => {
    const id = acpIdRef.current;
    const perm = pendingPerms.find((p) => p.request_id === requestId);
    const opt = perm?.options.find((o) => o.id === optionId);
    // Empty id = cancel; a reject_* option = decline. Either way the adapter
    // interrupts the turn (no agent message follows), so we note it locally.
    const isCancel = optionId === "";
    const isReject = !isCancel && (opt?.kind.startsWith("reject") ?? false);
    setPendingPerms((prev) => prev.filter((p) => p.request_id !== requestId));
    if (isCancel || isReject) {
      const label = perm?.title || "도구 실행";
      const verb = isCancel ? "취소됨" : "거부됨";
      setMessages((prev) => [...prev, { role: "system", text: `✖ ${verb}: ${label}` }]);
      setThinking(false);
    }
    if (id == null) return;
    invoke("acp_respond", { id, requestId, optionId }).catch((err) => {
      setErrorMsg(errString(err));
    });
  };

  const statusLabel: Record<Status, string> = {
    starting: "Connecting…",
    auth: "Sign-in required",
    ready: "Ready",
    error: "Error",
    closed: readOnly ? "저장된 세션 (읽기 전용)" : "Disconnected",
  };

  return (
    <div className="claude-panel">
      <div className="claude-main">
      <div className="claude-status">
        <span className={`claude-dot claude-dot-${status}`} />
        {statusLabel[status]}
        <button
          className="claude-tl-toggle"
          onClick={() => setShowTimeline((v) => !v)}
          title="이 세션의 변경 타임라인"
        >
          {showTimeline ? "타임라인 닫기" : `타임라인 열기${tlItems.size ? ` (${tlItems.size})` : ""}`}
        </button>
      </div>

      {status === "auth" && (
        <div className="claude-auth">
          <p>
            Claude Code 로그인이 필요합니다. 터미널에서 아래 명령을 실행한 뒤 Reconnect를
            누르세요:
          </p>
          <code className="claude-auth-cmd">{authCommand ?? "claude /login"}</code>
          <button className="toolbar-btn" onClick={() => connect()}>
            Reconnect
          </button>
        </div>
      )}

      {errorMsg && <div className="claude-error">{errorMsg}</div>}

      <div className="claude-log" ref={logRef}>
        {messages.map((m, i) =>
          m.role === "system" ? (
            <div key={i} className="claude-system">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`claude-msg claude-msg-${m.role}`}>
              <span className="claude-role">{m.role === "user" ? "You" : "Claude"}</span>
              <pre className="claude-text">{m.text}</pre>
            </div>
          ),
        )}
        {thinking && (
          <div className="claude-msg claude-msg-assistant">
            <span className="claude-role">Claude</span>
            <div className="claude-thinking" aria-label="Claude is thinking">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {pendingPerms.length > 0 && (
        <div className="claude-approvals">
          {pendingPerms.map((p) => (
            <div key={p.request_id} className="claude-approval">
              <div className="claude-approval-head">
                ✎ {p.title || "Claude가 도구를 실행하려 합니다"}
                {p.locations[0] && (
                  <>
                    {" — "}
                    <code>{p.locations[0]}</code>
                  </>
                )}
              </div>
              {p.preview && (
                <pre className="claude-approval-preview">
                  {p.preview.length > 4000 ? `${p.preview.slice(0, 4000)}\n…` : p.preview}
                </pre>
              )}
              <div className="claude-approval-actions">
                {p.options.map((o) => (
                  <button
                    key={o.id}
                    className={`toolbar-btn ${o.kind.startsWith("reject") ? "btn-reject" : ""}`}
                    onClick={() => respondPerm(p.request_id, o.id)}
                  >
                    {o.name}
                  </button>
                ))}
                <button className="toolbar-btn" onClick={() => respondPerm(p.request_id, "")}>
                  취소
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="claude-input">
        <textarea
          value={input}
          placeholder={status === "ready" ? "Message Claude…" : "Waiting for connection…"}
          disabled={status !== "ready"}
          onChange={(e) => {
            // During an IME composition, pushing state back into a controlled
            // textarea cancels WebKitGTK's preedit (Hangul never assembles).
            // Let the DOM own the text while composing; sync on compositionEnd.
            if (!composingRef.current) setInput(e.target.value);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            setInput(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            // `isComposing`/keyCode 229 cover the in-flight IME syllable; the ref
            // covers the gap between composition end and the keyup.
            if (e.key === "Enter" && !e.shiftKey) {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current) {
                return;
              }
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="toolbar-btn" disabled={status !== "ready"} onClick={send}>
          Send
        </button>
      </div>
      </div>

      {showTimeline && (
        <div className="claude-timeline-col">
          <div className="claude-timeline-head">변경 타임라인 · {tlItems.size}</div>
          <TimelineView items={[...tlItems.values()]} turns={tlTurns} answers={tlAnswers} />
        </div>
      )}
    </div>
  );
}
