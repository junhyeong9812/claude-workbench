import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";

/** Params attached to a Claude panel. `acpId` is persisted into the dockview
 * layout so a remount (tab/project switch) re-attaches the same session. */
export interface ClaudeParams {
  kind?: string;
  title?: string;
  acpId?: number;
}

/** Mirror of `core_acp::AcpEvent` (serde tag = "type", snake_case) plus the
 * relay's `id`. */
type AcpEvent =
  | { id: number; type: "connected"; session_id: string }
  | { id: number; type: "agent_message_chunk"; text: string }
  | { id: number; type: "auth_required"; command: string }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "disconnected" };

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
  role: "user" | "assistant";
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
    props.params.acpId != null ? "ready" : "starting",
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [authCommand, setAuthCommand] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [input, setInput] = useState("");
  // True from sending a prompt until its first streamed token — drives the
  // "Claude is thinking…" indicator (the wait before tokens arrive).
  const [thinking, setThinking] = useState(false);

  // The panel's ACP id; a ref so the listener (registered before `acp_start`
  // resolves) can filter without re-subscribing.
  const acpIdRef = useRef<number | null>(props.params.acpId ?? null);
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
        case "error":
          setThinking(false);
          setErrorMsg(ev.message);
          setStatus("error");
          break;
        case "disconnected":
          setThinking(false);
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

      if (acpIdRef.current == null) {
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

  const statusLabel: Record<Status, string> = {
    starting: "Connecting…",
    auth: "Sign-in required",
    ready: "Ready",
    error: "Error",
    closed: "Disconnected",
  };

  return (
    <div className="claude-panel">
      <div className="claude-status">
        <span className={`claude-dot claude-dot-${status}`} />
        {statusLabel[status]}
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
        {messages.map((m, i) => (
          <div key={i} className={`claude-msg claude-msg-${m.role}`}>
            <span className="claude-role">{m.role === "user" ? "You" : "Claude"}</span>
            <pre className="claude-text">{m.text}</pre>
          </div>
        ))}
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
  );
}
