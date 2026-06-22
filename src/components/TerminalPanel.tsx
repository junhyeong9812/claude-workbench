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
 * dockview layout so a remount (tab/project switch) re-attaches the same PTY.
 *
 * SSH panels carry **non-secret** connection metadata only (host/port/user/auth
 * method/key path/connection id) — never a password or passphrase. After a
 * restart the live session is gone; the panel recreates it via `ssh_create`,
 * and the secret comes from the OS keychain (by `connectionId`), not from here
 * (review F8). An unsaved ad-hoc connection has no `connectionId`, so it cannot
 * auto-reconnect after restart (expected). */
export interface TerminalParams {
  kind?: "terminal" | "editor" | "ssh";
  title?: string;
  sessionId?: number;
  // SSH-only (non-secret):
  host?: string;
  port?: number;
  username?: string;
  authKind?: "password" | "publickey" | "agent";
  keyPath?: string | null;
  connectionId?: string;
}

interface SshStatusEvent {
  id: number;
  phase: "connecting" | "ready" | "failed" | "closed";
  reason?: string | null;
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
    let unlistenSsh: UnlistenFn | undefined;
    let sessionId: number | null = null;
    let lastApplied = 0;
    let ready = false;
    const pending: TerminalOutputEvent[] = [];
    const isSsh = props.params.kind === "ssh";

    const write = (bytes: number[]) => {
      if (!disposed) term.write(new Uint8Array(bytes));
    };
    const writeText = (s: string) => {
      if (!disposed) term.write(s);
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
      // SSH status: show a "closed" line in-terminal. Connect/auth **failures**
      // are surfaced by MainArea's global listener (it can't be missed by a
      // not-yet-mounted panel — review P3-R1), so we don't duplicate them here.
      if (isSsh) {
        unlistenSsh = await listen<SshStatusEvent>("ssh-status", (e) => {
          if (e.payload.id !== sessionId) return;
          if (e.payload.phase === "closed") {
            writeText(`\r\n\x1b[2m[SSH 연결 종료]\x1b[0m\r\n`);
          }
        });
      }
      // If the panel was disposed while the listeners were being registered,
      // unlisten them now (the cleanup ran before they were assigned) — no leak
      // (review P3-R5).
      if (disposed) {
        if (unlisten) unlisten();
        if (unlistenSsh) unlistenSsh();
        return;
      }

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
        if (isSsh) {
          // Recreate after restart: no secret here — the backend reads it from
          // the keychain via connectionId. An ad-hoc (unsaved) connection has no
          // connectionId, so auth will fail and ssh-status surfaces the reason.
          const p = props.params;
          writeText(`\x1b[2m[${p.username}@${p.host}:${p.port ?? 22} 재접속 중...]\x1b[0m\r\n`);
          sessionId = await invoke<number>("ssh_create", {
            host: p.host,
            port: p.port ?? 22,
            username: p.username,
            authKind: p.authKind ?? "password",
            password: null,
            keyPath: p.keyPath ?? null,
            passphrase: null,
            connectionId: p.connectionId ?? null,
            cols: term.cols,
            rows: term.rows,
          });
        } else {
          const cwd = useAppStore.getState().activeProject ?? null;
          sessionId = await invoke<number>("terminal_create", {
            cmd: null,
            cwd,
            cols: term.cols,
            rows: term.rows,
          });
        }
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
      if (unlistenSsh) unlistenSsh();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
