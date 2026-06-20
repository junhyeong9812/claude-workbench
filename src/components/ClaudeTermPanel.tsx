import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import { TimelineView, ItemDetail, type TimelineItem } from "./TimelineView";

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
interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}
/** Full timeline snapshot for this session (the backend re-sends the whole
 * modest state on any change), so plain Q&A turns show too, not just tools. */
interface ClaudeTimelineEvent {
  id: number;
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
  dates: [number, string][];
  tokens: [number, TokenUsage][];
  /** [agentId, parentToolCallId|null, turn, items] per subagent — nested under
   * its spawning Agent item (parent), or its turn when there's no known parent. */
  subagents: [string, string | null, number, TimelineItem[]][];
}

/** Compact token count: 1234 → "1.2k". */
const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function ClaudeTermPanel(props: IDockviewPanelProps<ClaudeTermParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [turns, setTurns] = useState<Map<number, string>>(new Map());
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());
  const [dates, setDates] = useState<Map<number, string>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-subagent change lists [agentId, parentToolCallId|null, turn, items] (B1).
  const [subagents, setSubagents] = useState<[string, string | null, number, TimelineItem[]][]>(
    [],
  );
  // Session token totals (B1): ↑ = new context processed (input + cache write),
  // ↓ = generated output. Summed across turns.
  const [tokenTotal, setTokenTotal] = useState<{ input: number; output: number }>({
    input: 0,
    output: 0,
  });
  // Width (px) of the detail viewer pane; drag the splitter to resize.
  const [viewerWidth, setViewerWidth] = useState(480);

  // Ctrl+←/→ moves focus between the panes: terminal → (viewer) → timeline.
  // The current pane is derived from `document.activeElement` (not a counter) so
  // it stays correct after the user clicks into a pane directly.
  const navPane = (dir: number) => {
    const panes: { el: HTMLElement | null; focus: () => void }[] = [
      { el: hostRef.current, focus: () => termRef.current?.focus() },
      ...(viewerRef.current
        ? [{ el: viewerRef.current, focus: () => viewerRef.current?.focus() }]
        : []),
      {
        el: timelineRef.current,
        focus: () =>
          (timelineRef.current?.querySelector(".timeline-list") as HTMLElement | null)?.focus(),
      },
    ];
    const active = document.activeElement;
    let cur = panes.findIndex((p) => p.el && active && p.el.contains(active));
    if (cur === -1) cur = 0;
    const next = (cur + dir + panes.length) % panes.length;
    panes[next].focus();
  };
  const onContainerKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      navPane(e.key === "ArrowRight" ? 1 : -1);
    }
  };
  // Drag the terminal|viewer splitter to resize the viewer (timeline stays 360px).
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const TIMELINE_W = 360;
    const onMove = (ev: MouseEvent) => {
      const w = rect.right - TIMELINE_W - ev.clientX;
      setViewerWidth(Math.max(240, Math.min(rect.width - TIMELINE_W - 240, w)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      // A CJK-capable monospace stack so Hangul in Claude's TUI renders cleanly,
      // falling back through common Linux fonts.
      fontFamily:
        "'JetBrains Mono', 'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', 'Noto Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      // Catppuccin Mocha — a clean dark palette (Terminus-grade).
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        cursorAccent: "#1e1e2e",
        selectionBackground: "#585b70",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — ResizeObserver fits shortly */
    }

    // Intercept Ctrl+←/→ before xterm consumes them, so they move focus between
    // panes instead of being sent to the PTY as word-motion.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        navPane(e.key === "ArrowRight" ? 1 : -1);
        return false;
      }
      return true;
    });

    // Korean/CJK IME fix (attempt 2): in WebKitGTK, xterm's `onData` fires for
    // the in-progress composition (preedit), so each partial syllable is sent
    // and the composed text duplicates ("프로젝트" -> "프로로젝로젝"). We track
    // the composition on xterm's hidden textarea and **drop onData while
    // composing**; the `compositionend` listener is registered in the CAPTURE
    // phase so `composing` is cleared *before* xterm's own (bubble-phase) handler
    // emits the final composed text via onData — so the final lands exactly once.
    // Korean/CJK IME fix (measured WebKitGTK flow): Hangul fires a *separate*
    // `compositionend` per syllable, and `composing` is already false by the time
    // onData runs — so "skip while composing" never helps. Worse, after each
    // compositionend xterm emits the syllable via onData AND a redundant
    // cumulative chunk ("로", then "로젝", then "로젝트"), duplicating input.
    //
    // Since `compositionend.data` is the exact syllable, we send it ourselves
    // once and then drop the onData burst it triggers (`justComposed`, cleared on
    // the next macrotask). Non-composed input (English, control keys, escape
    // sequences) has no compositionend, so it flows through onData untouched.
    // Korean/CJK IME fix (measured WebKitGTK flow): the webview fires a separate
    // `compositionend` per composed syllable whose `.data` is exactly correct,
    // but ALSO emits bursts of duplicate/cumulative `onData` for the same text
    // ("로", then "로젝", then "로젝트") — which duplicate the input. So we send
    // the composed text once here on `compositionend`, and in `onData` (below) we
    // drop any multi-byte (non-ASCII) data: terminal keyboard input is
    // ASCII/control only, so any CJK in onData is an IME duplicate we already
    // handled. English, arrows, space, enter, and escape sequences are ASCII and
    // pass through untouched.
    const ta = term.textarea;
    if (ta) {
      ta.addEventListener("compositionend", (e) => {
        const text = (e as CompositionEvent).data;
        if (text && sessionId != null) {
          invoke("terminal_write", {
            id: sessionId,
            data: Array.from(new TextEncoder().encode(text)),
          }).catch(() => {});
        }
      });
    }

    let disposed = false;
    let unlistenTerm: UnlistenFn | undefined;
    let unlistenTl: UnlistenFn | undefined;
    let sessionId: number | null = null;
    let lastApplied = 0;
    let ready = false;
    // Set once a live timeline event arrives, so a slower snapshot-seed (reopen /
    // re-attach restore) doesn't overwrite newer live state.
    let gotLive = false;
    const pending: TerminalOutputEvent[] = [];

    const applySnapshot = (s: {
      items: TimelineItem[];
      turns: [number, string][];
      answers: [number, string][];
      dates: [number, string][];
      tokens?: [number, TokenUsage][];
    }) => {
      setItems([...s.items].sort((a, b) => a.seq - b.seq));
      setTurns(new Map(s.turns));
      setAnswers(new Map(s.answers));
      setDates(new Map(s.dates));
      const total = (s.tokens ?? []).reduce(
        (acc, [, u]) => ({
          input: acc.input + u.input + u.cache_creation,
          output: acc.output + u.output,
        }),
        { input: 0, output: 0 },
      );
      setTokenTotal(total);
    };

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
        gotLive = true;
        applySnapshot(e.payload);
        setSubagents(e.payload.subagents ?? []);
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
          name: (props.params.title as string) ?? null,
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

      // Seed the timeline from the saved snapshot (reopen or tab-switch
      // re-attach) so it isn't empty until the next live change — unless a live
      // event already arrived (which is newer).
      const seedUuid = props.params.sessionUuid ?? props.params.loadSessionId;
      const project = useAppStore.getState().activeProject ?? null;
      if (seedUuid && project) {
        invoke<{
          items: TimelineItem[];
          turns: [number, string][];
          answers: [number, string][];
          dates: [number, string][];
          tokens?: [number, TokenUsage][];
        } | null>("claude_session_snapshot", { project, uuid: seedUuid })
          .then((snap) => {
            if (snap && !gotLive && !disposed) applySnapshot(snap);
          })
          .catch(() => {});
      }
    })();

    const onData = term.onData((d) => {
      if (sessionId == null) return;
      // Drop IME composition output (multi-byte / non-ASCII) — Hangul only
      // arrives legitimately via `compositionend` (handled above); any CJK here
      // is a duplicate. Keyboard input through onData is ASCII/control only.
      for (const ch of d) {
        if ((ch.codePointAt(0) ?? 0) > 0x7f) return;
      }
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
      termRef.current = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedItem = selectedId
    ? ([items, ...subagents.map(([, , , its]) => its)]
        .flat()
        .find((it) => it.tool_call_id === selectedId) ?? null)
    : null;

  return (
    <div className="claudeterm" ref={containerRef} onKeyDown={onContainerKey}>
      <div className="claudeterm-pane claudeterm-term-pane">
        <div className="claudeterm-pane-head">
          <span className="claudeterm-pane-head-title">
            Claude — {(props.params.title as string) ?? "터미널"}
          </span>
          {(tokenTotal.input > 0 || tokenTotal.output > 0) && (
            <span className="claudeterm-tokens" title="입력(컨텍스트) / 출력 토큰">
              ↑{kfmt(tokenTotal.input)} ↓{kfmt(tokenTotal.output)}
            </span>
          )}
        </div>
        <div className="claudeterm-term" ref={hostRef} />
      </div>

      {selectedItem && (
        <>
          <div
            className="claudeterm-splitter"
            title="드래그로 크기 조절"
            onMouseDown={startDrag}
          />
          <div
            className="claudeterm-pane claudeterm-viewer-pane"
            ref={viewerRef}
            tabIndex={0}
            style={{ flex: `0 0 ${viewerWidth}px` }}
            onKeyDown={(e) => {
              if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
                const body = viewerRef.current?.querySelector(
                  ".claudeterm-viewer-body",
                ) as HTMLElement | null;
                if (body) {
                  e.preventDefault();
                  const step = e.key.startsWith("Page") ? body.clientHeight * 0.9 : 48;
                  body.scrollTop += e.key === "ArrowDown" || e.key === "PageDown" ? step : -step;
                }
              }
            }}
          >
            <div className="claudeterm-pane-head">
              <span className="claudeterm-pane-head-title">
                변경 상세 — {selectedItem.title || selectedItem.kind}
              </span>
              <span
                className="claudeterm-viewer-x"
                title="닫기"
                onClick={() => setSelectedId(null)}
              >
                ×
              </span>
            </div>
            <div className="claudeterm-viewer-body">
              <ItemDetail item={selectedItem} />
            </div>
          </div>
        </>
      )}

      <div className="claudeterm-pane claudeterm-timeline-pane" ref={timelineRef}>
        <div className="claudeterm-pane-head">타임라인</div>
        <div className="claudeterm-timeline">
          <TimelineView
            items={items}
            turns={turns}
            answers={answers}
            dates={dates}
            subagents={subagents}
            selectedId={selectedId}
            onSelect={(it) => setSelectedId(it.tool_call_id)}
          />
        </div>
      </div>
    </div>
  );
}
