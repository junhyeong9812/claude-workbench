import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import { TimelineView, type TimelineItem } from "./TimelineView";

/**
 * Architecture A Claude panel: the **real** `claude` CLI in an xterm PTY (left)
 * + its live change timeline (right), built by tailing the session JSONL.
 *
 * The xterm half mirrors {@link TerminalPanel} (create-or-reattach a PTY via the
 * `terminal-output` relay) but uses `claude_start`, which also spawns the
 * timeline poll thread. Timeline items arrive on the `claude-timeline` event and
 * are upserted by `tool_call_id` (revisions merge in place).
 *
 * First cut: live only. The timeline rebuilds from new events on a remount (tab
 * switch) — a snapshot/persist path is the next increment.
 */
export interface ClaudeTermParams {
  kind?: "claudeterm";
  title?: string;
  /** PTY session id from `claude_start`, persisted so a remount re-attaches. */
  sessionId?: number;
  /** The Claude session UUID (the JSONL file name). */
  sessionUuid?: string;
  /** Resume an existing Claude session by its UUID (same file, append). */
  loadSessionId?: string;
}

interface TerminalOutputEvent {
  session_id: number;
  seq: number;
  data: number[];
}
interface SnapshotResult {
  data: number[];
  last_seq: number;
}
interface ClaudeStarted {
  id: number;
  session_uuid: string;
}
interface ClaudeTimelineEvent {
  id: number;
  item: TimelineItem;
}

/** Shared empty maps — first cut shows tool items grouped by turn number; the
 * prompt/answer text lives in the terminal, so these stay empty. */
const EMPTY_MAP = new Map<number, string>();

export function ClaudeTermPanel(props: IDockviewPanelProps<ClaudeTermParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemsRef = useRef<Map<string, TimelineItem>>(new Map());

  const upsert = (item: TimelineItem) => {
    itemsRef.current.set(item.tool_call_id, item);
    setItems([...itemsRef.current.values()].sort((a, b) => a.seq - b.seq));
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: 13,
      theme: { background: "#1e1e1e" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — ResizeObserver fits shortly */
    }

    let disposed = false;
    let unlistenTerm: UnlistenFn | undefined;
    let unlistenTl: UnlistenFn | undefined;
    let sessionId: number | null = null;
    let lastApplied = 0;
    let ready = false;
    const pending: TerminalOutputEvent[] = [];

    const write = (bytes: number[]) => {
      if (!disposed) term.write(new Uint8Array(bytes));
    };
    const applyLive = (ev: TerminalOutputEvent) => {
      if (ev.session_id === sessionId && ev.seq > lastApplied) {
        write(ev.data);
        lastApplied = ev.seq;
      }
    };

    (async () => {
      // Listeners first (buffer terminal output until ready), so nothing is missed.
      unlistenTerm = await listen<TerminalOutputEvent>("terminal-output", (e) => {
        if (sessionId == null || e.payload.session_id !== sessionId) return;
        if (!ready) pending.push(e.payload);
        else applyLive(e.payload);
      });
      unlistenTl = await listen<ClaudeTimelineEvent>("claude-timeline", (e) => {
        if (sessionId == null || e.payload.id !== sessionId) return;
        upsert(e.payload.item);
      });
      if (disposed) return;

      // Re-attach to a persisted PTY, else start a fresh Claude session.
      const existing = props.params.sessionId;
      if (existing != null) {
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: existing });
          sessionId = existing;
          write(snap.data);
          lastApplied = snap.last_seq;
        } catch {
          sessionId = null; // PTY gone (e.g. after restart) -> start fresh
        }
      }
      if (disposed) return;
      if (sessionId == null) {
        const cwd = useAppStore.getState().activeProject ?? null;
        const started = await invoke<ClaudeStarted>("claude_start", {
          cwd,
          resume: props.params.loadSessionId ?? null,
          cols: term.cols,
          rows: term.rows,
        });
        sessionId = started.id;
        props.api.updateParameters({
          ...props.params,
          sessionId: started.id,
          sessionUuid: started.session_uuid,
        });
      }

      ready = true;
      for (const ev of pending) applyLive(ev);
      pending.length = 0;
    })();

    const onData = term.onData((d) => {
      if (sessionId == null) return;
      const bytes = Array.from(new TextEncoder().encode(d));
      invoke("terminal_write", { id: sessionId, data: bytes }).catch(() => {});
    });
    const onResize = term.onResize(() => {
      if (sessionId == null) return;
      invoke("terminal_resize", { id: sessionId, cols: term.cols, rows: term.rows }).catch(
        () => {},
      );
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* ignore transient layout errors */
      }
    });
    ro.observe(host);

    return () => {
      // Detach only — the PTY + poll thread live on (closed by claude_close on
      // real panel removal in MainArea).
      disposed = true;
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      if (unlistenTerm) unlistenTerm();
      if (unlistenTl) unlistenTl();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="claudeterm">
      <div className="claudeterm-term" ref={hostRef} />
      <div className="claudeterm-timeline">
        <TimelineView
          items={items}
          turns={EMPTY_MAP}
          answers={EMPTY_MAP}
          dates={EMPTY_MAP}
          selectedId={selectedId}
          onSelect={(it) => setSelectedId(it.tool_call_id)}
        />
      </div>
    </div>
  );
}
