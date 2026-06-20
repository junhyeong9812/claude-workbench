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
/** A previous task in the handoff chain (a saved session snapshot), rendered
 * read-only below the live timeline so the chain reads as one continuous task
 * history across restarts. */
interface ChainTask {
  uuid: string;
  name: string;
  date: string;
  items: TimelineItem[];
  turns: [number, string][];
  answers: [number, string][];
  dates: [number, string][];
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

/** A short error string from an invoke rejection (AppError `{message}` or text). */
const errText = (e: unknown): string =>
  typeof e === "string" ? e : ((e as { message?: string })?.message ?? String(e));

/**
 * Review/edit step of a handoff: shows the generated summary in a textarea so the
 * user can curate it before the new session is seeded with it. Confirm starts the
 * restart; cancel aborts without touching the live session.
 */
function HandoffModal(props: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState(props.initial);
  return (
    <div className="claudeterm-modal-overlay" onMouseDown={props.onCancel}>
      <div className="claudeterm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="claudeterm-modal-head">핸드오프 요약 — 확인 후 이어가기</div>
        <textarea
          className="claudeterm-modal-body"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="claudeterm-modal-foot">
          <button onClick={props.onCancel} disabled={props.busy}>
            취소
          </button>
          <button onClick={() => props.onConfirm(text)} disabled={props.busy}>
            {props.busy ? "진행 중…" : "이어가기 (새 task)"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  // A plain text (e.g. a turn's full answer) shown in the detail viewer when the
  // timeline truncates it. Mutually exclusive with `selectedId`.
  const [textView, setTextView] = useState<{ title: string; text: string } | null>(null);
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
  // Width (px) of the detail viewer + timeline panes; drag splitters to resize.
  const [viewerWidth, setViewerWidth] = useState(480);
  const [timelineWidth, setTimelineWidth] = useState(360);

  // --- Task handoff state ---
  // Bumped to remount the terminal/timeline effect onto a new session (restart).
  const [gen, setGen] = useState(0);
  // Current live PTY session id, mirrored out of the effect so handoff (component
  // scope) can read/close it. The effect remains the sole writer.
  const sessionIdRef = useRef<number | null>(null);
  // Seed to inject into a freshly-started session once it looks ready (handoff).
  const pendingSeedRef = useRef<string | null>(null);
  // On a handoff remount, the exact session to attach to — so the effect doesn't
  // race dockview's param propagation (codex P3-impl 2). Consumed once by the effect.
  const pendingAttachRef = useRef<{ id: number; uuid: string } | null>(null);
  // While a handoff is generating/restarting (or its summary is under review),
  // block keystrokes to the PTY so the user can't send a prompt into a session
  // that's about to be replaced (which would error or land in the wrong session).
  // A ref so the mount-time input handlers read the live value.
  const inputLockedRef = useRef(false);
  // The last handoff seed, so the user can re-inject it if the auto-attempt missed
  // the prompt (codex P3 D3 — ready detection is best-effort).
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  // The generated summary awaiting review/edit (null = modal closed).
  const [summaryDraft, setSummaryDraft] = useState<{ cwd: string; oldUuid: string; text: string } | null>(
    null,
  );
  // Previous tasks in this session's handoff chain (read-only, newest-first),
  // rendered below the live timeline so the chain reads continuously (Phase 2).
  const [chainPrev, setChainPrev] = useState<ChainTask[]>([]);
  // Collapsed previous-task sections (by uuid) — click a task header to fold it.
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const toggleTask = (uuid: string) =>
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });

  /** Write the seed (+Enter) to the current session — submits it as a prompt. */
  const injectSeed = (text: string) => {
    const id = sessionIdRef.current;
    if (id == null) return;
    invoke("terminal_write", {
      id,
      data: Array.from(new TextEncoder().encode(text + "\n")),
    }).catch(() => {});
  };

  // Step 1 of "task 시작": summarize the current task and open it for review. Only
  // generates — the restart happens on confirm, so a failure here never tears
  // down the live session (codex P3 D1).
  const startHandoff = async () => {
    const cwd = useAppStore.getState().activeProject ?? null;
    const oldUuid = props.params.sessionUuid ?? null;
    if (!cwd || !oldUuid) {
      alert("현재 세션 정보를 찾을 수 없습니다.");
      return;
    }
    setHandoffBusy(true);
    try {
      const res = await invoke<{ path: string; text: string }>("generate_task_summary", {
        cwd,
        uuid: oldUuid,
      });
      setSummaryDraft({ cwd, oldUuid, text: res.text });
    } catch (e) {
      alert(`요약 생성 실패: ${errText(e)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

  // Step 2: persist the (edited) summary, start a fresh session, link the chain,
  // remount onto it, and seed it. Order per codex P3: start(new) → set_task_meta →
  // remount → close(old), so no step's failure orphans the live session.
  const confirmHandoff = async (edited: string) => {
    const draft = summaryDraft;
    if (!draft) return;
    setHandoffBusy(true);
    let newId: number | null = null;
    try {
      const path = await invoke<string>("save_task_summary", {
        cwd: draft.cwd,
        uuid: draft.oldUuid,
        text: edited,
      });
      const started = await invoke<ClaudeStarted>("claude_start", {
        cwd: draft.cwd,
        resume: null,
        name: (props.params.title as string) ?? null,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
      });
      newId = started.id;
      // Record the chain link before any seed write, so a seed failure stays
      // recoverable via summary_path (codex P3 D2).
      await invoke("claude_set_task_meta", {
        cwd: draft.cwd,
        uuid: started.session_uuid,
        prevUuid: draft.oldUuid,
      });
      const oldId = sessionIdRef.current;
      // Hand the effect the exact session to attach to (codex P3-impl 2).
      pendingAttachRef.current = { id: started.id, uuid: started.session_uuid };
      props.api.updateParameters({
        ...props.params,
        sessionId: started.id,
        sessionUuid: started.session_uuid,
        loadSessionId: undefined,
      });
      const seed = `이전 작업(task)의 핸드오프 요약이 \`${path}\` 에 저장돼 있습니다. 먼저 이 파일을 읽고, 이어서 작업을 계속해 주세요.`;
      pendingSeedRef.current = seed;
      setLastSeed(seed);
      // Reset the timeline for the fresh session, then remount the effect (it
      // reattaches to the new sessionId now in params).
      setItems([]);
      setTurns(new Map());
      setAnswers(new Map());
      setDates(new Map());
      setSubagents([]);
      setChainPrev([]);
      setTokenTotal({ input: 0, output: 0 });
      setSelectedId(null);
      setTextView(null);
      setSummaryDraft(null);
      setGen((g) => g + 1);
      // Close the old session last (its snapshot/summary are kept).
      if (oldId != null) invoke("claude_close", { id: oldId }).catch(() => {});
    } catch (e) {
      // A failure after the new session started would orphan it — close it
      // (codex P3-impl 1). The old session is untouched, so the user can retry.
      if (newId != null) invoke("claude_close", { id: newId }).catch(() => {});
      pendingAttachRef.current = null;
      alert(`핸드오프 실패: ${errText(e)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

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
  // Drag the timeline splitter to resize the timeline column.
  const startDragTimeline = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      setTimelineWidth(Math.max(220, Math.min(rect.width - 240, rect.right - ev.clientX)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Keep the input-lock ref in sync: locked while a handoff is busy or its summary
  // is being reviewed.
  useEffect(() => {
    inputLockedRef.current = handoffBusy || summaryDraft != null;
  }, [handoffBusy, summaryDraft]);

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
        if (text && sessionId != null && !inputLockedRef.current) {
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

      // Re-attach to a persisted PTY, else start a fresh Claude session. A handoff
      // hands us the exact new session via `pendingAttachRef` so the remount
      // doesn't race dockview's param propagation (codex P3-impl 2).
      const attach = pendingAttachRef.current;
      pendingAttachRef.current = null;
      const existing = attach?.id ?? props.params.sessionId;
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

      sessionIdRef.current = sessionId;
      ready = true;
      for (const ev of pending) applyLive(ev);
      pending.length = 0;

      // Handoff: seed the freshly-restarted session once it should be at a prompt.
      // Ready detection is best-effort (codex P3 D3) — a fixed settle delay, with a
      // manual "요약 주입" button if it missed. The seed is idempotent (it points at
      // the summary file), so a re-send is harmless.
      if (pendingSeedRef.current) {
        const seed = pendingSeedRef.current;
        setTimeout(() => {
          if (!disposed && pendingSeedRef.current === seed) {
            injectSeed(seed);
            pendingSeedRef.current = null;
          }
        }, 1800);
      }

      // Seed the timeline from the saved snapshot (reopen or tab-switch
      // re-attach) so it isn't empty until the next live change — unless a live
      // event already arrived (which is newer).
      const seedUuid = attach?.uuid ?? props.params.sessionUuid ?? props.params.loadSessionId;
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

        // Load the handoff chain (previous tasks) so they render below the live
        // timeline — one continuous history across restarts (Phase 2). Excludes
        // the head (the live session); newest prev task first.
        invoke<ChainTask[]>("claude_session_chain", { project, headUuid: seedUuid })
          .then((chain) => {
            if (!disposed) setChainPrev(chain.filter((t) => t.uuid !== seedUuid).reverse());
          })
          .catch(() => {});
      }
    })();

    const onData = term.onData((d) => {
      if (sessionId == null || inputLockedRef.current) return;
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
  }, [gen]);

  const selectedItem = selectedId
    ? ([items, ...subagents.map(([, , , its]) => its), ...chainPrev.map((t) => t.items)]
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
          <span className="claudeterm-head-controls">
            {(tokenTotal.input > 0 || tokenTotal.output > 0) && (
              <span className="claudeterm-tokens" title="입력(컨텍스트) / 출력 토큰">
                ↑{kfmt(tokenTotal.input)} ↓{kfmt(tokenTotal.output)}
              </span>
            )}
            {lastSeed && (
              <button
                className="claudeterm-head-btn"
                title="핸드오프 요약 안내를 현재 세션에 다시 보냅니다"
                onClick={() => injectSeed(lastSeed)}
              >
                요약 주입
              </button>
            )}
            <button
              className="claudeterm-head-btn"
              title="현재 작업을 요약해 새 task로 이어가기 (새 세션 재기동 + 요약 주입)"
              disabled={handoffBusy || !props.params.sessionUuid}
              onClick={startHandoff}
            >
              {handoffBusy ? "처리 중…" : "task 시작"}
            </button>
          </span>
        </div>
        <div className="claudeterm-term" ref={hostRef} />
        {(handoffBusy || summaryDraft) && (
          <div className="claudeterm-term-lock">
            <span className="claudeterm-spinner" />
            {handoffBusy ? "핸드오프 처리 중 — 입력 일시 잠금" : "요약 확인 중 — 입력 일시 잠금"}
          </div>
        )}
      </div>

      {(selectedItem || textView) && (
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
                {textView ? textView.title : `변경 상세 — ${selectedItem!.title || selectedItem!.kind}`}
              </span>
              <span
                className="claudeterm-viewer-x"
                title="닫기"
                onClick={() => {
                  setSelectedId(null);
                  setTextView(null);
                }}
              >
                ×
              </span>
            </div>
            <div className="claudeterm-viewer-body">
              {textView ? (
                <pre className="claudeterm-text">{textView.text}</pre>
              ) : (
                <ItemDetail item={selectedItem!} />
              )}
            </div>
          </div>
        </>
      )}

      <div className="claudeterm-splitter" title="드래그로 크기 조절" onMouseDown={startDragTimeline} />
      <div
        className="claudeterm-pane claudeterm-timeline-pane"
        ref={timelineRef}
        style={{ flex: `0 0 ${timelineWidth}px` }}
      >
        <div className="claudeterm-pane-head">타임라인</div>
        <div className="claudeterm-timeline">
          <TimelineView
            items={items}
            turns={turns}
            answers={answers}
            dates={dates}
            subagents={subagents}
            selectedId={selectedId}
            onSelect={(it) => {
              setSelectedId(it.tool_call_id);
              setTextView(null);
            }}
            onSelectAnswer={(turn) => {
              setTextView({ title: `답변 (Q${turn})`, text: answers.get(turn) ?? "" });
              setSelectedId(null);
            }}
          />
          {chainPrev.map((task) => {
            const collapsed = collapsedTasks.has(task.uuid);
            return (
              <div key={task.uuid} className="claudeterm-prevtask">
                <div
                  className="claudeterm-prevtask-head"
                  title={collapsed ? "펼치기" : "접기"}
                  onClick={() => toggleTask(task.uuid)}
                >
                  <span className="timeline-date-caret">{collapsed ? "▸" : "▾"}</span> ◀ 이전 task —{" "}
                  {task.name} · {task.date}
                </div>
                {!collapsed && (
                  <TimelineView
                    items={task.items}
                    turns={new Map(task.turns)}
                    answers={new Map(task.answers)}
                    dates={new Map(task.dates)}
                    subagents={[]}
                    selectedId={selectedId}
                    onSelect={(it) => {
                      setSelectedId(it.tool_call_id);
                      setTextView(null);
                    }}
                    onSelectAnswer={(turn) => {
                      const a = new Map(task.answers).get(turn) ?? "";
                      setTextView({ title: `답변 (${task.name} Q${turn})`, text: a });
                      setSelectedId(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {summaryDraft && (
        <HandoffModal
          initial={summaryDraft.text}
          busy={handoffBusy}
          onCancel={() => setSummaryDraft(null)}
          onConfirm={confirmHandoff}
        />
      )}
    </div>
  );
}
