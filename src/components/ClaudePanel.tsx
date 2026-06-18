import { useEffect, useRef, useState } from "react";
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

interface AuthMethod {
  id: string;
  name: string;
}

/** Mirror of `core_acp::AcpEvent` (serde tag = "type", snake_case) plus the
 * relay's `id`. */
type AcpEvent =
  | { id: number; type: "connected"; session_id: string }
  | { id: number; type: "agent_message_chunk"; text: string }
  | { id: number; type: "auth_required"; methods: AuthMethod[] }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "disconnected" };

type Status = "starting" | "auth" | "ready" | "error" | "closed";

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
 * Event contract: we register the `acp-event` listener (filtered by our panel
 * id via a ref) *before* awaiting `acp_start`, so no early event is missed. S1
 * renders streamed agent text and surfaces auth/errors; tool-call timeline
 * events come in S2/S3.
 */
export function ClaudePanel(props: IDockviewPanelProps<ClaudeParams>) {
  // Re-attaching to a persisted session (tab/project switch): the live
  // `Connected` event already fired on first mount and won't repeat, so start
  // optimistically `ready` (a dead session surfaces via a prompt error).
  const [status, setStatus] = useState<Status>(
    props.params.acpId != null ? "ready" : "starting",
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [input, setInput] = useState("");

  // The panel's ACP id; a ref so the listener (registered before `acp_start`
  // resolves) can filter without re-subscribing.
  const acpIdRef = useRef<number | null>(props.params.acpId ?? null);
  const logRef = useRef<HTMLDivElement | null>(null);

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
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const handle = (ev: AcpEvent) => {
      if (ev.id !== acpIdRef.current) return;
      switch (ev.type) {
        case "connected":
          setStatus("ready");
          setAuthMethods([]);
          break;
        case "agent_message_chunk":
          appendChunk(ev.text);
          break;
        case "auth_required":
          setStatus("auth");
          setAuthMethods(ev.methods);
          break;
        case "error":
          setErrorMsg(ev.message);
          setStatus("error");
          break;
        case "disconnected":
          setStatus((s) => (s === "error" ? s : "closed"));
          break;
      }
    };

    (async () => {
      // 1) Listener first (filtered by our id) so nothing is missed.
      unlisten = await listen<AcpEvent>("acp-event", (e) => handle(e.payload));
      if (disposed) return;

      // 2) Re-attach to a persisted session, else start a fresh one.
      if (acpIdRef.current == null) {
        const cwd = useAppStore.getState().activeProject ?? null;
        try {
          const id = await invoke<number>("acp_start", { cwd });
          if (disposed) {
            invoke("acp_close", { id }).catch(() => {});
            return;
          }
          acpIdRef.current = id;
          props.api.updateParameters({ ...props.params, acpId: id });
        } catch (err) {
          setErrorMsg(String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      // Detach only — the session lives on for re-attach (closed on panel
      // removal by MainArea).
      disposed = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the log pinned to the latest message.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = input.trim();
    const id = acpIdRef.current;
    if (!text || id == null || status !== "ready") return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    invoke("acp_prompt", { id, text }).catch((err) => {
      setErrorMsg(String(err));
    });
  };

  const authenticate = (methodId: string) => {
    const id = acpIdRef.current;
    if (id == null) return;
    setStatus("starting");
    invoke("acp_authenticate", { id, methodId }).catch((err) => {
      setErrorMsg(String(err));
      setStatus("error");
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
          <p>This agent requires authentication:</p>
          {authMethods.map((m) => (
            <button key={m.id} className="toolbar-btn" onClick={() => authenticate(m.id)}>
              {m.name}
            </button>
          ))}
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
      </div>

      <div className="claude-input">
        <textarea
          value={input}
          placeholder={status === "ready" ? "Message Claude…" : "Waiting for connection…"}
          disabled={status !== "ready"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
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
