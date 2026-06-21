import { useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import { xtermTheme } from "./xtermTheme";

/** Params attached to a terminal panel. `sessionId` is persisted into the
 * dockview layout so a remount (tab/project switch) re-attaches the same PTY. */
export interface TerminalParams {
  kind?: "terminal" | "editor";
  title?: string;
  sessionId?: number;
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

/**
 * A real PTY-backed terminal (xterm.js) living in a dockview panel.
 *
 * Lifecycle (spec P2b-1 §0.1): mount = create-or-attach a session; unmount =
 * **detach only** (the PTY survives in the Rust `SessionManager`); the session
 * is closed on real panel removal by `MainArea`'s `onDidRemovePanel`.
 *
 * Backfill/live contract (spec §0 ③): we register the output listener *before*
 * snapshotting, buffer chunks until the snapshot resolves, then replay the
 * snapshot and apply only chunks with `seq > last_seq` — no loss, no dup.
 */
export function TerminalPanel(props: IDockviewPanelProps<TerminalParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Live-update the xterm palette when the app theme or custom colors change.
  const theme = useAppStore((s) => s.theme);
  const termColors = useAppStore((s) => s.termColors);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, termColors);
  }, [theme, termColors]);

  // Live-update terminal font size (+ refit).
  const fontSize = useAppStore((s) => s.fontSize);
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
    }
  }, [fontSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: useAppStore.getState().fontSize,
      theme: xtermTheme(useAppStore.getState().theme, useAppStore.getState().termColors),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — ResizeObserver will fit shortly */
    }

    let disposed = false;
    let unlisten: UnlistenFn | undefined;
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
      // 1) Listener first (buffer until ready) so nothing is missed.
      unlisten = await listen<TerminalOutputEvent>("terminal-output", (e) => {
        if (sessionId == null || e.payload.session_id !== sessionId) return;
        if (!ready) pending.push(e.payload);
        else applyLive(e.payload);
      });
      if (disposed) return;

      // 2) Re-attach to a persisted session, else create a fresh one.
      const existing = props.params.sessionId;
      if (existing != null) {
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: existing });
          sessionId = existing;
          write(snap.data);
          lastApplied = snap.last_seq;
        } catch {
          sessionId = null; // session gone (e.g. after restart) -> recreate
        }
      }
      if (disposed) return;
      if (sessionId == null) {
        const cwd = useAppStore.getState().activeProject ?? null;
        sessionId = await invoke<number>("terminal_create", {
          cmd: null,
          cwd,
          cols: term.cols,
          rows: term.rows,
        });
        props.api.updateParameters({ ...props.params, sessionId });
      }

      // 3) Drain buffered chunks (skipping any already in the snapshot), go live.
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
      // Detach only — the session lives on for re-attach (spec §0.1).
      disposed = true;
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      if (unlisten) unlisten();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
