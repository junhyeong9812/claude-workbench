import { useEffect, useRef, useState } from "react";
import { errText } from "../utils/error";
import type { TerminalOutputEvent, SnapshotResult } from "../types";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import { xtermTheme } from "./xtermTheme";
import { recallArea, rememberArea, type PanelArea } from "../state/panelFocus";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TimelineView, ItemDetail, MarkdownText, type TimelineItem } from "./TimelineView";
import { handleScrollKey } from "./scrollKeys";

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
  /** The project (cwd) this panel runs in. Set when reopening a saved task so the
   * panel uses that task's project; falls back to the active project for
   * freshly-created panels. */
  project?: string;
  /** One-shot prompt injected once when this session first starts (review/dev
   * modes seed it with "이 커밋 리뷰하자" / "이 파일 검토해줘"). Cleared from the
   * persisted params after injection so a tab-switch remount won't re-send it. */
  seed?: string;
}

/** Result of `claude_open_or_attach`: attached to a live PTY (mirror) or started
 * fresh (driver), plus the current input driver + its revision (P6). */
interface ClaudeOpened {
  id: number;
  session_uuid: string;
  role: "driver" | "mirror";
  driver: string;
  rev: number;
}
interface DriverChanged {
  id: number;
  driver: string;
  rev: number;
}
/** A previous task in the handoff chain (a saved session snapshot), rendered
 * read-only below the live timeline so the chain reads as one continuous task
 * history across restarts. */
interface ChainTask {
  uuid: string;
  name: string;
  date: string;
  /** AI-generated one-line title (header label); falls back to `name` if absent. */
  title?: string | null;
  /** Handoff summary text — shown as the header hover tooltip. */
  summary?: string | null;
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

/**
 * Review/edit step of a handoff: shows the generated summary in a textarea so the
 * user can curate it before the new session is seeded with it. Confirm starts the
 * restart; cancel aborts without touching the live session.
 */
function HandoffModal(props: {
  initial: string;
  initialTitle: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (text: string, title: string) => void;
}) {
  const [text, setText] = useState(props.initial);
  const [title, setTitle] = useState(props.initialTitle);
  return (
    <div className="claudeterm-modal-overlay" onMouseDown={props.onCancel}>
      <div className="claudeterm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="claudeterm-modal-head">핸드오프 요약 — 확인 후 이어가기</div>
        {/* 1-line title — the prev-task header label. Editable before save. */}
        <input
          className="claudeterm-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="task 제목 (한 줄)"
          spellCheck={false}
        />
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
          <button onClick={() => props.onConfirm(text, title)} disabled={props.busy}>
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
  // The selected question turn (Q&A) — highlights its head and shows prompt+answer
  // in the detail pane. Mutually exclusive with selectedId. `selectedTurnScope`
  // disambiguates which timeline owns it ("live" or a prev-task uuid), since turn
  // numbers repeat across the live session and each previous task.
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);
  const [selectedTurnScope, setSelectedTurnScope] = useState<string>("live");
  // Detail pane render mode for pure-content (non-diff) views: rendered markdown
  // (뷰모드, default) vs raw text (원본). Toggled from the detail head.
  const [detailMarkdown, setDetailMarkdown] = useState(true);
  // Hide the whole previous-task history region (it renders above the live
  // timeline, oldest-first). Each task is still individually collapsible.
  const [hidePrev, setHidePrev] = useState(false);
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
  // Multiwindow mirror (P6): this window's label, whether it's the input *driver*
  // for the session (mirrors are read-only), and the last driver-change revision
  // seen (to drop stale `claude-driver-changed` events).
  const myLabel = getCurrentWindow().label;
  const isDriverRef = useRef(true);
  const driverRevRef = useRef(-1);
  const [isDriver, setIsDriver] = useState(true);
  // The last handoff seed, so the user can re-inject it if the auto-attempt missed
  // the prompt (codex P3 D3 — ready detection is best-effort).
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  // The generated summary awaiting review/edit (null = modal closed).
  const [summaryDraft, setSummaryDraft] = useState<{
    cwd: string;
    oldUuid: string;
    text: string;
    title: string;
  } | null>(null);
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
    invoke("claude_write", {
      id,
      data: Array.from(new TextEncoder().encode(text + "\n")),
    }).catch(() => {});
  };

  // Dev mode 확인: inject a review prompt into THIS session if it's the target
  // (matched by uuid) and we're its driver and live. The first "open + seed" goes
  // through the seed mechanism; this handles subsequent injects into the already-
  // live per-project dev session.
  const claudeInjectRequest = useAppStore((s) => s.claudeInjectRequest);
  const requestClaudeInject = useAppStore((s) => s.requestClaudeInject);
  useEffect(() => {
    if (!claudeInjectRequest) return;
    const myUuid = props.params.sessionUuid ?? props.params.loadSessionId;
    if (!myUuid || claudeInjectRequest.uuid !== myUuid) return;
    if (!isDriverRef.current || sessionIdRef.current == null) return;
    injectSeed(claudeInjectRequest.text);
    requestClaudeInject(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeInjectRequest]);

  // Step 1 of "task 시작": summarize the current task and open it for review. Only
  // generates — the restart happens on confirm, so a failure here never tears
  // down the live session (codex P3 D1).
  const startHandoff = async () => {
    const cwd = props.params.project ?? useAppStore.getState().activeProject ?? null;
    const oldUuid = props.params.sessionUuid ?? null;
    if (!cwd || !oldUuid) {
      alert("현재 세션 정보를 찾을 수 없습니다.");
      return;
    }
    setHandoffBusy(true);
    try {
      const res = await invoke<{ path: string; text: string; title: string }>("generate_task_summary", {
        cwd,
        uuid: oldUuid,
      });
      setSummaryDraft({ cwd, oldUuid, text: res.text, title: res.title });
    } catch (e) {
      alert(`요약 생성 실패: ${errText(e)}`);
    } finally {
      setHandoffBusy(false);
    }
  };

  // Step 2: persist the (edited) summary, start a fresh session, link the chain,
  // remount onto it, and seed it. Order per codex P3: start(new) → set_task_meta →
  // remount → close(old), so no step's failure orphans the live session.
  const confirmHandoff = async (edited: string, editedTitle: string) => {
    const draft = summaryDraft;
    if (!draft) return;
    setHandoffBusy(true);
    let newId: number | null = null;
    try {
      const path = await invoke<string>("save_task_summary", {
        cwd: draft.cwd,
        uuid: draft.oldUuid,
        text: edited,
        title: editedTitle,
      });
      const started = await invoke<ClaudeOpened>("claude_open_or_attach", {
        project: draft.cwd,
        uuid: null, // brand-new task session (handoff)
        cwd: draft.cwd,
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

  // Focus a specific sub-area's content. Returns whether the target existed —
  // the viewer pane only renders when something is selected, so a stale "viewer"
  // request falls through to the terminal.
  const focusArea = (area: PanelArea): boolean => {
    if (area === "timeline") {
      const el = timelineRef.current?.querySelector(".timeline-list") as HTMLElement | null;
      if (el) {
        el.focus();
        return true;
      }
    } else if (area === "viewer") {
      if (viewerRef.current) {
        viewerRef.current.focus();
        return true;
      }
    }
    if (termRef.current) {
      termRef.current.focus();
      return true;
    }
    return false;
  };

  // Restore focus to the sub-area this panel last held it in (default: the
  // terminal). dockview's onlyWhenVisible mode remounts the panel on every tab
  // switch, so the "last area" is read from the module-level panelFocus map
  // (component state would have been wiped by the remount).
  const restoreFocus = () => {
    focusArea(recallArea(props.api.id) ?? "term");
  };

  // Track which sub-area holds focus so a later tab switch can restore it.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onFocusIn = () => {
      const a = document.activeElement;
      if (!a) return;
      let area: PanelArea | null = null;
      if (timelineRef.current?.contains(a)) area = "timeline";
      else if (viewerRef.current?.contains(a)) area = "viewer";
      else if (hostRef.current?.contains(a)) area = "term";
      if (area) rememberArea(props.api.id, area);
    };
    c.addEventListener("focusin", onFocusIn);
    return () => c.removeEventListener("focusin", onFocusIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Becoming the active tab without a remount (e.g. activated in a split while
  // another group is clicked) doesn't re-run the mount effect, so restore focus
  // here too. The mount path calls restoreFocus() directly once xterm is ready.
  useEffect(() => {
    const d = props.api.onDidActiveChange(() => {
      if (props.api.isActive) restoreFocus();
    });
    return () => d.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api]);
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

  // Live-update the xterm palette when the app theme or custom colors change.
  const theme = useAppStore((s) => s.theme);
  const termColors = useAppStore((s) => s.termColors);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, termColors);
  }, [theme, termColors]);

  // Live-update terminal font size (+ refit dimensions) on change.
  const fitRef = useRef<FitAddon | null>(null);
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
      // A CJK-capable monospace stack so Hangul in Claude's TUI renders cleanly,
      // falling back through common Linux fonts.
      fontFamily:
        "'JetBrains Mono', 'DejaVu Sans Mono', 'Noto Sans Mono CJK KR', 'Noto Sans Mono', monospace",
      fontSize: useAppStore.getState().fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      // Follows the app theme (Catppuccin Mocha/Latte); updated live below.
      theme: xtermTheme(useAppStore.getState().theme, useAppStore.getState().termColors),
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — ResizeObserver fits shortly */
    }

    // Intercept Ctrl+←/→ before xterm consumes them, so they move focus between
    // panes instead of being sent to the PTY as word-motion. Stop propagation so
    // the event does NOT also bubble to the container's `onContainerKey`, which
    // would call `navPane` a second time (moving two panes — with the viewer
    // closed that wraps right back to the terminal).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
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
        if (text && sessionId != null && !inputLockedRef.current && isDriverRef.current) {
          invoke("claude_write", {
            id: sessionId,
            data: Array.from(new TextEncoder().encode(text)),
          }).catch(() => {});
        }
      });
    }

    let disposed = false;
    let unlistenTerm: UnlistenFn | undefined;
    let unlistenTl: UnlistenFn | undefined;
    let unlistenDriver: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;
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
      // Driver changes (P6): lock/unlock input by whether we hold the driver role.
      // `rev` is monotonic — drop stale events (review R7-4).
      unlistenDriver = await listen<DriverChanged>("claude-driver-changed", (e) => {
        if (sessionId == null || e.payload.id !== sessionId) return;
        if (e.payload.rev <= driverRevRef.current) return;
        driverRevRef.current = e.payload.rev;
        const driving = e.payload.driver === myLabel;
        isDriverRef.current = driving;
        setIsDriver(driving);
      });
      // Another window deleted/force-closed this session — it's dead now; lock
      // input and tell the user (review P6-impl #2).
      unlistenClosed = await listen<number>("claude-session-closed", (e) => {
        if (sessionId == null || e.payload !== sessionId) return;
        inputLockedRef.current = true;
        isDriverRef.current = false;
        setIsDriver(false);
        if (!disposed) term.write("\r\n\x1b[2m[세션이 다른 창에서 종료되었습니다]\x1b[0m\r\n");
      });
      if (disposed) return;

      // Open the session: attach to its live PTY if another window already runs
      // it (mirror, read-only) or start a fresh one (driver) — atomic in the
      // backend (P6). A handoff hands the exact new session via `pendingAttachRef`.
      const attach = pendingAttachRef.current;
      pendingAttachRef.current = null;
      const project = props.params.project ?? useAppStore.getState().activeProject ?? null;
      const openUuid =
        attach?.uuid ?? props.params.loadSessionId ?? props.params.sessionUuid ?? null;
      try {
        const opened = await invoke<ClaudeOpened>("claude_open_or_attach", {
          project,
          uuid: openUuid,
          cwd: project,
          name: (props.params.title as string) ?? null,
          cols: term.cols,
          rows: term.rows,
        });
        sessionId = opened.id;
        driverRevRef.current = opened.rev;
        const driving = opened.driver === myLabel;
        isDriverRef.current = driving;
        setIsDriver(driving);
        // Fresh review/dev session: queue the one-shot seed prompt (only if no
        // handoff seed is already pending — that one wins). It's injected by the
        // pendingSeed block below once the session settles.
        if (driving && props.params.seed && pendingSeedRef.current == null) {
          pendingSeedRef.current = props.params.seed;
          setLastSeed(props.params.seed);
        }
        props.api.updateParameters({
          ...props.params,
          sessionId: opened.id,
          sessionUuid: opened.session_uuid,
          // A seed is one-shot — drop it from the persisted params so a remount
          // (tab switch / reopen) doesn't re-inject it.
          seed: undefined,
        });
      } catch {
        sessionId = null; // open failed (no project, etc.)
      }
      if (disposed) return;
      // Backfill scrollback. `sessionId` is set BEFORE the snapshot so the live
      // listener buffers matching chunks into `pending` from the first frame and
      // the `seq > last_seq` drain skips snapshot-included dups (review R1-1/R7-8);
      // a fresh start just returns empty scrollback.
      if (sessionId != null) {
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: sessionId });
          write(snap.data);
          lastApplied = snap.last_seq;
        } catch {
          /* fresh session — no scrollback yet */
        }
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
      // Mirrors are read-only; only the driver writes (backend also enforces — P6).
      if (sessionId == null || inputLockedRef.current || !isDriverRef.current) return;
      // Drop IME composition output (multi-byte / non-ASCII) — Hangul only
      // arrives legitimately via `compositionend` (handled above); any CJK here
      // is a duplicate. Keyboard input through onData is ASCII/control only.
      for (const ch of d) {
        if ((ch.codePointAt(0) ?? 0) > 0x7f) return;
      }
      const bytes = Array.from(new TextEncoder().encode(d));
      invoke("claude_write", { id: sessionId, data: bytes }).catch(() => {});
    });
    const onResize = term.onResize(() => {
      if (sessionId == null) return;
      // Driver-only (backend ignores a mirror's resize — the PTY size is shared).
      invoke("claude_resize", { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
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

    // Mount = activation under onlyWhenVisible (the panel only mounts when it
    // becomes the visible tab), so land focus in the last-used sub-area now that
    // xterm exists — fixing the race where MainArea focused one frame too early.
    restoreFocus();

    return () => {
      // Detach only — the PTY + poll thread live on (closed by claude_close on
      // real panel removal in MainArea).
      disposed = true;
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      if (unlistenTerm) unlistenTerm();
      if (unlistenTl) unlistenTl();
      if (unlistenDriver) unlistenDriver();
      if (unlistenClosed) unlistenClosed();
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
            {!isDriver && (
              <>
                <span className="claudeterm-mirror-badge" title="다른 창이 입력 중 — 이 창은 읽기전용 미러">
                  🪞 미러(읽기전용)
                </span>
                <button
                  className="claudeterm-head-btn"
                  title="이 창에서 입력하도록 입력 권한을 가져옵니다 (다른 창은 읽기전용)"
                  onClick={() => {
                    const id = sessionIdRef.current;
                    if (id != null) invoke("claude_set_driver", { id }).catch(() => {});
                  }}
                >
                  입력 권한 가져오기
                </button>
              </>
            )}
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
              const body = viewerRef.current?.querySelector(
                ".claudeterm-viewer-body",
              ) as HTMLElement | null;
              // Focusable code/diff blocks in reading order, and which one (if any)
              // currently holds focus.
              const blocks = body
                ? (Array.from(body.querySelectorAll(".timeline-diff-block")) as HTMLElement[])
                : [];
              const focusedIdx = blocks.findIndex((b) => b.contains(document.activeElement));

              // v: 뷰모드(html)/원본 전환 — 항상(일관성). diff엔 효과 없지만 토글은 유지.
              // Ctrl/Cmd/Alt+V(붙여넣기 등)는 토글하지 않도록 가드(FilePeekViewer와 일치).
              if ((e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                setDetailMarkdown((v) => !v);
                return;
              }
              // Enter: 변경상세(또는 현재 블록)에서 **다음 코드블럭으로 내려가며** 포커스.
              // 마지막 블록에선 그대로 유지(래핑 안 함 — 덜 놀람).
              if (e.key === "Enter" && blocks.length > 0) {
                e.preventDefault();
                const next = focusedIdx === -1 ? 0 : Math.min(focusedIdx + 1, blocks.length - 1);
                blocks[next].focus();
                blocks[next].scrollIntoView({ block: "nearest" });
                return;
              }
              // Esc: 2단계. 코드블럭에 포커스가 있으면 변경상세 패널로 복귀(뷰어 유지);
              // 뷰어 자체에 포커스면 뷰어를 닫고 타임라인으로 포커스 복귀(↑↓ 이어가기).
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (focusedIdx !== -1) {
                  viewerRef.current?.focus();
                } else {
                  setSelectedId(null);
                  setTextView(null);
                  (timelineRef.current?.querySelector(".timeline-list") as HTMLElement | null)?.focus();
                }
                return;
              }
              // ←/→: 포커스된 블록 안에서 가로 스크롤(긴 diff 라인의 뒷부분 읽기).
              // Ctrl/Cmd+←/→는 가로스크롤 대신 컨테이너의 패널 이동(onContainerKey)에
              // 넘기도록 modifier로 가드(이중 발동 방지). stopPropagation은 쓰지 않는다.
              if (
                (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
                focusedIdx !== -1 &&
                !e.ctrlKey &&
                !e.metaKey
              ) {
                e.preventDefault();
                const dx = e.key === "ArrowRight" ? 64 : -64;
                blocks[focusedIdx]
                  .querySelectorAll("pre")
                  .forEach((p) => ((p as HTMLElement).scrollLeft += dx));
                return;
              }
              // ↑/↓/PageUp/PageDown: 뷰어 바디 세로 스크롤(읽기) — 공유 헬퍼.
              if (handleScrollKey(e, body)) return;
            }}
          >
            <div className="claudeterm-pane-head">
              <span className="claudeterm-pane-head-title">
                {textView ? textView.title : `변경 상세 — ${selectedItem!.title || selectedItem!.kind}`}
              </span>
              {/* 뷰모드↔원본 토글: 항상 표시(일관성) + 단축키 v. */}
              <button
                className="claudeterm-viewmode-btn"
                title="뷰모드 ↔ 원본 (단축키 v)"
                onClick={() => setDetailMarkdown((v) => !v)}
              >
                {detailMarkdown ? "원본 보기" : "뷰모드 보기"}
              </button>
              <span
                className="claudeterm-viewer-x"
                title="닫기"
                onClick={() => {
                  // Esc 닫기와 동작 일치: selectedTurn을 유지해 TimelineView가
                  // 직전 항목으로 scrollIntoView하도록 두고, 타임라인 리스트로 포커스 복귀.
                  // (setSelectedTurn(null)을 하면 스크롤 복원 대상이 사라져 맨 위로 튐.)
                  setSelectedId(null);
                  setTextView(null);
                  (timelineRef.current?.querySelector(".timeline-list") as HTMLElement | null)?.focus();
                }}
              >
                ×
              </span>
            </div>
            {/* Shortcut hint row. */}
            <div className="claudeterm-viewer-hint">
              <span className="claudeterm-viewer-hint-keys">
                v 뷰/원본 · Enter 코드블럭 · ←→ 가로 · Esc 복귀 · ↑↓ 스크롤 · Ctrl+←/→ 패널
              </span>
            </div>
            <div className="claudeterm-viewer-body">
              {textView ? (
                detailMarkdown ? (
                  <MarkdownText text={textView.text} />
                ) : (
                  <pre className="claudeterm-text">{textView.text}</pre>
                )
              ) : (
                <ItemDetail item={selectedItem!} markdown={detailMarkdown} />
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
        {/* Prev-task expand/collapse lives IN the header (outside the scroll
            container) so the live timeline's auto-scroll-to-bottom can't hide it.
            Only shown when a handoff chain exists. */}
        <div className="claudeterm-pane-head">
          <span className="claudeterm-pane-head-title">타임라인</span>
          {chainPrev.length > 0 && (
            <span
              className="claudeterm-prevtasks-toggle"
              title={hidePrev ? "이전 task 펼치기" : "이전 task 접기"}
              onClick={() => setHidePrev((h) => !h)}
            >
              <span className="timeline-date-caret">{hidePrev ? "▸" : "▾"}</span> 이전 task{" "}
              {chainPrev.length}개
            </span>
          )}
        </div>
        <div className="claudeterm-timeline">
          {/* Previous tasks render ABOVE the live timeline (older = higher), each
              collapsible. Reverse the (newest-first) chain so the oldest task sits
              at the very top — chronological down. */}
          {chainPrev.length > 0 && !hidePrev && (
            <div className="claudeterm-prevtasks">
              {[...chainPrev].reverse().map((task) => {
                  const collapsed = collapsedTasks.has(task.uuid);
                  return (
                    <div key={task.uuid} className="claudeterm-prevtask">
                      <div
                        className="claudeterm-prevtask-head"
                        title={task.summary || (collapsed ? "펼치기" : "접기")}
                        onClick={() => toggleTask(task.uuid)}
                      >
                        <span className="timeline-date-caret">{collapsed ? "▸" : "▾"}</span> ◀ 이전 task —{" "}
                        {task.title || task.name} · {task.date}
                      </div>
                      {!collapsed && (
                        <TimelineView
                          items={task.items}
                          turns={new Map(task.turns)}
                          answers={new Map(task.answers)}
                          dates={new Map(task.dates)}
                          subagents={[]}
                          selectedId={selectedId}
                          selectedTurn={selectedTurn}
                          selectedScope={selectedTurnScope}
                          scope={task.uuid}
                          sessionCwd={props.params.project ?? useAppStore.getState().activeProject ?? undefined}
                          onSelect={(it) => {
                            setSelectedId(it.tool_call_id);
                            setTextView(null);
                            setSelectedTurn(null);
                          }}
                          onSelectTurn={(turn) => {
                            const q = new Map(task.turns).get(turn) ?? "";
                            const a = new Map(task.answers).get(turn) ?? "";
                            setTextView({
                              title: `${task.name} Q${turn}`,
                              text: `질문:\n${q}\n\n답변:\n${a || "(없음)"}`,
                            });
                            setSelectedId(null);
                            setSelectedTurn(turn);
                            setSelectedTurnScope(task.uuid);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          <TimelineView
            items={items}
            turns={turns}
            answers={answers}
            dates={dates}
            subagents={subagents}
            selectedId={selectedId}
            selectedTurn={selectedTurn}
            selectedScope={selectedTurnScope}
            scope="live"
            followBottom
            sessionCwd={props.params.project ?? useAppStore.getState().activeProject ?? undefined}
            onSelect={(it) => {
              setSelectedId(it.tool_call_id);
              setTextView(null);
              setSelectedTurn(null);
            }}
            onSelectTurn={(turn) => {
              const q = turns.get(turn) ?? "";
              const a = answers.get(turn) ?? "";
              setTextView({ title: `Q${turn}`, text: `질문:\n${q}\n\n답변:\n${a || "(없음)"}` });
              setSelectedId(null);
              setSelectedTurn(turn);
              setSelectedTurnScope("live");
            }}
          />
        </div>
      </div>

      {summaryDraft && (
        <HandoffModal
          initial={summaryDraft.text}
          initialTitle={summaryDraft.title}
          busy={handoffBusy}
          onCancel={() => setSummaryDraft(null)}
          onConfirm={confirmHandoff}
        />
      )}
    </div>
  );
}
