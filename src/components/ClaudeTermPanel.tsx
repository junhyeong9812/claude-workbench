import { useEffect, useMemo, useRef, useState } from "react";
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
import { SubagentsPane } from "./SubagentsPane";
import { handleScrollKey } from "./scrollKeys";
import {
  useClaudeStatus,
  deriveSessionActivity,
  hasOpenQuestion,
  scanBottomForPrompt,
  makeDebouncedScanner,
  makeScanGate,
  PROMPT_SCAN_MAX_LINES,
} from "../state/claudeStatus";

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
  /** Current assistant model id (sizes the context-window gauge), or null. */
  model?: string | null;
  /** Most recent assistant message's usage = current context occupancy (gauge
   * numerator), distinct from `tokens` which sums a turn's tool round-trips. */
  last_usage?: TokenUsage | null;
  /** [agentId, parentToolCallId|null, turn, items] per subagent — nested under
   * its spawning Agent item (parent), or its turn when there's no known parent. */
  subagents: [string, string | null, number, TimelineItem[]][];
}

/** Context-window size (tokens) for a Claude model id. The `[1m]` variants carry
 * a 1M window; other Claude models default to 200k. Unknown / non-Claude → 0, so
 * the gauge is hidden rather than showing a made-up window. */
function ctxWindow(model?: string | null): number {
  if (!model || !model.includes("claude")) return 0;
  if (model.includes("[1m]") || model.includes("-1m")) return 1_000_000;
  return 200_000;
}

/** Compact token count: 1234 → "1.2k". */
const kfmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** A short error string from an invoke rejection (AppError `{message}` or text). */

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
  // Context-window gauge (P5): current occupancy = the latest assistant message's
  // input+cache tokens (last_usage), sized by the session model's window.
  const [ctxModel, setCtxModel] = useState<string | null>(null);
  const [ctxTokens, setCtxTokens] = useState<number>(0);
  // Width (px) of the detail viewer + timeline panes; drag splitters to resize.
  const [viewerWidth, setViewerWidth] = useState(480);
  const [timelineWidth, setTimelineWidth] = useState(360);
  // 타임라인 패널 통째 접기 — 접힌 동안 좁은 스트립만 남기고 터미널에 폭을 양보.
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  // 서브에이전트 칼럼 (opt-in): every agent's live progress stacked beside the
  // terminal, instead of digging into the timeline's nested groups.
  const [showAgents, setShowAgents] = useState(false);
  const [agentsWidth, setAgentsWidth] = useState(300);
  const agentsPaneRef = useRef<HTMLDivElement | null>(null);

  // Current live PTY session id, mirrored out of the effect so component-scope
  // actions (seed inject, archive) can read it. The effect remains the sole writer.
  const sessionIdRef = useRef<number | null>(null);
  // This session's stable uuid, used to key the attention-status store (badges).
  // Set alongside the numeric session id once the session opens; the timeline
  // payload carries only the numeric id, so status derivation reads it here.
  const statusUuidRef = useRef<string | null>(null);
  // Seed to inject into a freshly-started session once it looks ready (review/dev
  // modes' one-shot prompt).
  const pendingSeedRef = useRef<string | null>(null);
  // Input lock — set when the session dies (closed in another window) so
  // keystrokes can't land in a dead PTY. A ref so the mount-time input handlers
  // read the live value.
  const inputLockedRef = useRef(false);
  // Multiwindow mirror (P6): this window's label, whether it's the input *driver*
  // for the session (mirrors are read-only), and the last driver-change revision
  // seen (to drop stale `claude-driver-changed` events).
  const myLabel = getCurrentWindow().label;
  const isDriverRef = useRef(true);
  const driverRevRef = useRef(-1);
  const [isDriver, setIsDriver] = useState(true);
  // The last one-shot seed (review/dev prompt), so the user can re-inject it if
  // the auto-attempt missed the prompt (ready detection is best-effort).
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  // 종료(아카이브): archive the session's transcript + extraction. The session
  // stays live (closing the tab is a separate, archive-free action).
  const [archiveBusy, setArchiveBusy] = useState(false);

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

  // 종료(아카이브): copy the JSONL verbatim + normalized.json + book.html, then
  // claude extracts title/summary/knowledge (best-effort — extraction failure
  // still leaves the archive). Idempotent: re-archiving replaces the old folder.
  const archiveSession = async () => {
    const cwd = props.params.project ?? useAppStore.getState().activeProject ?? null;
    const uuid = props.params.sessionUuid ?? null;
    if (!cwd || !uuid) {
      alert("현재 세션 정보를 찾을 수 없습니다.");
      return;
    }
    if (!confirm("이 세션을 아카이브할까요?\n(요약·지식 추출에 1~2분 걸릴 수 있습니다. 세션은 계속 사용할 수 있고, 이후 대화는 다시 아카이브하면 반영됩니다.)"))
      return;
    setArchiveBusy(true);
    try {
      const res = await invoke<{
        dir: string;
        book_path: string;
        replaced: boolean;
        summary_ok: boolean;
        knowledge_files: number;
        extraction_error?: string | null;
        unchanged: boolean;
      }>("archive_session", { cwd, uuid });
      // 아카이브 브라우저 탭이 이미 열려 있으면 즉시 갱신되도록 알린다.
      window.dispatchEvent(new CustomEvent("mt-archive-updated"));
      if (res.unchanged) {
        alert(`이미 최신 아카이브입니다 — 마지막 아카이브 이후 새 대화가 없어 그대로 두었습니다.\n${res.dir}`);
      } else {
        alert(
          `아카이브 완료${res.replaced ? " (재아카이브 — 달라진 이전 내용은 버전으로 보존)" : ""}\n${res.dir}\n` +
            `요약: ${res.summary_ok ? "생성됨" : "없음"} · 지식 항목 ${res.knowledge_files}건` +
            (res.extraction_error ? `\n추출 경고: ${res.extraction_error}` : ""),
        );
      }
    } catch (e) {
      alert(`아카이브 실패: ${errText(e)}`);
    } finally {
      setArchiveBusy(false);
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
    // The user "sees" this session when it's the active tab and its window is
    // focused — clear its done-unseen badge then (invariant ①).
    const markSeenIfLooking = () => {
      const uuid = statusUuidRef.current;
      if (!uuid) return;
      const st = useClaudeStatus.getState();
      // activeClaudeUuid tracks the dock-active tab regardless of focus — the
      // roll-up's cycle cursor (S12). Distinct from watchedUuid (active AND
      // focused) which drives alert suppression.
      if (props.api.isActive) st.setActiveClaudeUuid(uuid);
      else if (st.activeClaudeUuid === uuid) st.setActiveClaudeUuid(null);
      if (props.api.isActive && document.hasFocus()) {
        st.markSeen(uuid);
        // This panel is what the user is actively watching now — suppress its
        // attention alerts (P4 N4). `watchedUuid` is a live signal (cleared on
        // blur / tab-away below), distinct from the store's per-tick `seen`.
        st.setWatched(uuid);
      } else if (st.watchedUuid === uuid) {
        // Was the watched panel, but no longer active+focused — stop suppressing.
        st.setWatched(null);
      }
    };
    const d = props.api.onDidActiveChange(() => {
      // Run on both activate and deactivate so `watchedUuid` clears when this tab
      // stops being active (markSeenIfLooking handles the not-looking branch).
      if (props.api.isActive) restoreFocus();
      markSeenIfLooking();
    });
    // Also flip seen when this window regains focus while the panel is active.
    window.addEventListener("focus", markSeenIfLooking);
    // Losing window focus means the user isn't watching this panel anymore.
    const onBlur = () => {
      const uuid = statusUuidRef.current;
      if (uuid && useClaudeStatus.getState().watchedUuid === uuid) {
        useClaudeStatus.getState().setWatched(null);
      }
    };
    window.addEventListener("blur", onBlur);
    // Seed: if we mount already active+focused, count it as seen immediately.
    markSeenIfLooking();
    return () => {
      d.dispose();
      window.removeEventListener("focus", markSeenIfLooking);
      window.removeEventListener("blur", onBlur);
      // This panel is unmounting (tab switch / close) — if it was the watched or
      // active-cycle session, release those live signals so a stale uuid doesn't
      // keep suppressing alerts or anchoring the roll-up cycle (S8/S12).
      const uuid = statusUuidRef.current;
      if (uuid) {
        const st = useClaudeStatus.getState();
        if (st.watchedUuid === uuid) st.setWatched(null);
        if (st.activeClaudeUuid === uuid) st.setActiveClaudeUuid(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api]);
  // Drag the terminal|viewer splitter to resize the viewer (timeline stays 360px).
  /** 스플리터 드래그 공통 (P0 F3): mousemove(>60Hz)마다 setState → 패널 전체
   * 재렌더가 프레임 드랍의 원인이라, rAF로 프레임당 1회로 합친다. 보존 계약:
   * 드래그 중 시각 추종(프레임 단위) + 종료 시 마지막 좌표 반영 + 클램프 동일. */
  const dragWithRaf = (compute: (clientX: number) => number, set: (w: number) => void) => {
    let raf = 0;
    let lastX = 0;
    let moved = false; // move 없는 클릭은 기존처럼 아무 set도 하지 않는다
    const onMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      moved = true;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        set(compute(lastX));
      });
    };
    const onUp = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (moved) set(compute(lastX)); // 마지막 좌표 확정 커밋 — 최종 폭 보존
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const TIMELINE_W = 360;
    dragWithRaf(
      (x) => Math.max(240, Math.min(rect.width - TIMELINE_W - 240, rect.right - TIMELINE_W - x)),
      setViewerWidth,
    );
  };
  // Drag the timeline splitter to resize the timeline column.
  const startDragAgents = (e: React.MouseEvent) => {
    e.preventDefault();
    const pane = agentsPaneRef.current;
    const container = containerRef.current;
    if (!pane || !container) return;
    const right = pane.getBoundingClientRect().right;
    // Container-aware max (like the timeline splitter): leave the other fixed
    // panes + a 240px terminal minimum, so the fixed widths can't overflow.
    // Viewer visibility approximated from state (selectedItem derives later in
    // render) — over-reserving when a selection has no item is harmless.
    const others = timelineWidth + (selectedId != null || textView != null ? viewerWidth : 0);
    const max = Math.max(220, container.getBoundingClientRect().width - others - 240);
    dragWithRaf((x) => Math.max(220, Math.min(max, right - x)), setAgentsWidth);
  };

  const startDragTimeline = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragWithRaf(
      (x) => Math.max(220, Math.min(rect.width - 240, rect.right - x)),
      setTimelineWidth,
    );
  };

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
    // The uuid this mount attached to the attention store (P3). Tracked locally so
    // the cleanup detaches exactly what it attached, regardless of a later handoff
    // reassigning statusUuidRef.
    let attachedUuid: string | null = null;
    const pending: TerminalOutputEvent[] = [];

    const applySnapshot = (
      s: {
        items: TimelineItem[];
        turns: [number, string][];
        answers: [number, string][];
        dates: [number, string][];
        tokens?: [number, TokenUsage][];
        model?: string | null;
        last_usage?: TokenUsage | null;
      },
      origin: "snapshot" | "live",
    ) => {
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
      setCtxModel(s.model ?? null);
      const lu = s.last_usage;
      setCtxTokens(lu ? lu.input + lu.cache_read + lu.cache_creation : 0);
      // Derive the attention status from the same snapshot so a restart / reopen
      // restores the badge (invariant ⑥) — not just live events (S5). A
      // `snapshot` origin seeds the notifier silently (no restore re-alert);
      // `live` (the timeline-event caller) edges normally.
      const statusUuid = statusUuidRef.current;
      if (statusUuid) {
        useClaudeStatus.getState().updateFromTimeline(statusUuid, {
          activity: deriveSessionActivity(s.turns, s.answers, s.items),
          questionBlocked: hasOpenQuestion(s.items),
          seenNow: props.api.isActive && document.hasFocus(),
          origin,
        });
      }
    };

    // P2: after PTY output settles, scan the live screen bottom for an
    // input-waiting prompt (permission dialog / numbered menu) and set the
    // screen-blocked signal. No-op until a session is open (statusUuidRef).
    //
    // Origin (S4a): scans triggered by the restore replay (the scrollback
    // backfill write + the scheduled open scan) are a *snapshot* of pre-existing
    // screen state — they must seed the notifier silently, not re-alert a prompt
    // the user already saw before the restart. The first genuinely NEW output
    // (a live terminal-output event) or a keystroke flips this to "live". Each
    // trigger passes the origin AT TRIGGER TIME — the debounced scanner resolves
    // a coalesced batch to snapshot only when every trigger was snapshot, so live
    // output landing inside the debounce window can't retroactively promote a
    // pure restore scan.
    let scanOrigin: "snapshot" | "live" = "snapshot";
    // S1: gate empty-screen scans — blank before the restore paints is "no data"
    // (don't clear a blocked signal); after the post-restore scan is armed (or a
    // non-empty screen was seen) a blank screen is a real verdict and may clear.
    const scanGate = makeScanGate();
    const runBlockedScan = (origin: "snapshot" | "live") => {
      const t = termRef.current;
      const uuid = statusUuidRef.current;
      if (!t || !uuid) return;
      const buf = t.buffer.active;
      // Read the *live screen* rows [baseY … baseY+rows-1] bottom-first — not the
      // scrolled viewport — so scrolling up to an old, already-answered prompt
      // can't drag it into range. translateToString has already stripped ANSI.
      const lines: string[] = [];
      const bottom = buf.baseY + t.rows - 1;
      for (let i = bottom; i >= buf.baseY && lines.length < PROMPT_SCAN_MAX_LINES; i--) {
        const s = buf.getLine(i)?.translateToString(true) ?? "";
        if (s.trim() === "") continue;
        lines.push(s);
      }
      if (!scanGate.admit(lines.length > 0)) return;
      // NOTE: a permission/menu prompt that Claude drew while this session was a
      // *backgrounded* (unmounted) tab isn't scanned until the panel remounts and
      // repaints — the scan reads this window's live xterm buffer only. Remount +
      // the scheduled open scan (below) recover it; a still-backgrounded prompt is
      // a known limitation (its blocked badge still comes from the timeline
      // question path when applicable).
      useClaudeStatus.getState().setScreenBlocked(uuid, scanBottomForPrompt(lines), origin);
    };
    const blockedScanner = makeDebouncedScanner(runBlockedScan, 300);

    const write = (bytes: number[]) => {
      if (!disposed) {
        term.write(new Uint8Array(bytes));
        blockedScanner.trigger(scanOrigin);
      }
    };
    const applyLive = (ev: TerminalOutputEvent) => {
      if (ev.session_id === sessionId && ev.seq > lastApplied) {
        // Genuinely new PTY output — from here on, scans report live edges (S4a).
        scanOrigin = "live";
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
        // applySnapshot("live") also derives this session's attention status
        // (badge) from the same payload — "seen" = this panel is the active tab
        // AND its window is focused right now (S5 unified the derive path).
        applySnapshot(e.payload, "live");
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
        // Session is truly dead now — drop its attention badge. (Not done in the
        // detach cleanup below, which is a mere tab-switch remount; a done-unseen
        // badge must survive that so it stays visible until the user looks.)
        const closedUuid = statusUuidRef.current;
        if (closedUuid) useClaudeStatus.getState().remove(closedUuid);
        if (!disposed) term.write("\r\n\x1b[2m[세션이 다른 창에서 종료되었습니다]\x1b[0m\r\n");
      });
      if (disposed) return;

      // Open the session: attach to its live PTY if another window already runs
      // it (mirror, read-only) or start a fresh one (driver) — atomic in the
      // backend (P6).
      const project = props.params.project ?? useAppStore.getState().activeProject ?? null;
      const openUuid = props.params.loadSessionId ?? props.params.sessionUuid ?? null;
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
        statusUuidRef.current = opened.session_uuid;
        // Register this session's numeric↔uuid mapping so the app-level global
        // listener can resolve its timeline events while this panel is a
        // backgrounded (unmounted) tab, and mark it attached so the global
        // listener defers to this panel's own (accurate-seenNow) updates (P3).
        attachedUuid = opened.session_uuid;
        useClaudeStatus.getState().registerSession(opened.session_uuid, opened.id);
        useClaudeStatus.getState().attachPanel(opened.session_uuid);
        // Audit gap: the mount-time markSeenIfLooking ran before statusUuidRef was
        // set (uuid null → no-op), so an initially active+focused panel would set
        // neither watchedUuid (alert suppression) nor activeClaudeUuid (roll-up
        // cursor) until its next activate event. Establish them now the uuid is
        // known (S8/S12). markSeen is a no-op until the first timeline tick creates
        // the entry — the entry's seen flag is captured there via seenNow — so
        // watched/active are the load-bearing part here.
        {
          const st = useClaudeStatus.getState();
          if (props.api.isActive) st.setActiveClaudeUuid(opened.session_uuid);
          if (props.api.isActive && document.hasFocus()) {
            st.markSeen(opened.session_uuid);
            st.setWatched(opened.session_uuid);
          }
        }
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

      // Mount rescan (S1): the scrollback `write()` above already triggers the
      // debounced scanner, but a fresh reopen with no new scrollback wouldn't —
      // so schedule one scan now that the session uuid is set and the screen is
      // restored, recovering a blocked badge for a session reopened while sitting
      // at a permission/menu prompt. This restore scan reports origin "snapshot"
      // (silent notifier seed — S4a) unless live output already arrived. Arming
      // the gate here (S1): the restore is over, so from this scan onward even a
      // genuinely-empty screen is a valid verdict and may clear a stale blocked
      // signal (before arming, blank = "not painted yet" and is ignored).
      if (sessionId != null) {
        scanGate.arm();
        blockedScanner.trigger(scanOrigin);
      }

      // Seed (review/dev one-shot prompt): inject once the session should be at a
      // prompt. Ready detection is best-effort — a fixed settle delay, with a
      // manual re-inject button if it missed.
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
      const seedUuid = props.params.sessionUuid ?? props.params.loadSessionId;
      if (seedUuid && project) {
        invoke<{
          items: TimelineItem[];
          turns: [number, string][];
          answers: [number, string][];
          dates: [number, string][];
          tokens?: [number, TokenUsage][];
        } | null>("claude_session_snapshot", { project, uuid: seedUuid })
          .then((snap) => {
            if (snap && !gotLive && !disposed) applySnapshot(snap, "snapshot");
          })
          .catch(() => {});
      }
    })();

    const onData = term.onData((d) => {
      // A keystroke is a response too — rescan so a prompt that the key dismisses
      // clears quickly (the PTY redraw also triggers a scan; this just leads it).
      // User interaction ends the restore phase — subsequent scans are live (S4a).
      scanOrigin = "live";
      blockedScanner.trigger("live");
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
      // Release this panel's attention-store attachment so the global listener
      // takes over the (still-live) session's badge. Does NOT remove the entry /
      // mapping — a done-unseen badge must survive a tab-switch remount (the
      // session is only truly removed on claude-session-closed).
      if (attachedUuid) useClaudeStatus.getState().detachPanel(attachedUuid);
      blockedScanner.cancel();
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
  }, []);

  // tool_call_id → item 인덱스 (P0 F2) — 기존 flat().find와 동일한 우선순위
  // (본 items 먼저, 그다음 서브에이전트 순서·각 배열 순서)를 "먼저 넣은 것
  // 유지"로 보존한다. 렌더마다 전체 배열 재할당+선형 탐색 → 변경 시 1회 빌드.
  const itemIndex = useMemo(() => {
    const m = new Map<string, TimelineItem>();
    for (const it of items) if (!m.has(it.tool_call_id)) m.set(it.tool_call_id, it);
    for (const [, , , its] of subagents) {
      for (const it of its) if (!m.has(it.tool_call_id)) m.set(it.tool_call_id, it);
    }
    return m;
  }, [items, subagents]);
  const selectedItem = selectedId ? (itemIndex.get(selectedId) ?? null) : null;

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
            {(() => {
              const win = ctxWindow(ctxModel);
              if (ctxTokens <= 0 || win <= 0) return null;
              const pct = Math.min(100, Math.round((ctxTokens / win) * 100));
              return (
                <span
                  className="claudeterm-ctx"
                  title={`컨텍스트 ${kfmt(ctxTokens)} / ${kfmt(win)} (${ctxModel ?? "?"})`}
                >
                  <span className="claudeterm-ctx-bar">
                    <span className="claudeterm-ctx-fill" style={{ width: `${pct}%` }} />
                  </span>
                  {pct}%
                </span>
              );
            })()}
            {subagents.length > 0 && (
              <button
                className={`claudeterm-head-btn${showAgents ? " claudeterm-head-btn-on" : ""}`}
                title="서브에이전트 진행상황을 별도 칼럼으로 나란히 봅니다"
                onClick={() => setShowAgents((v) => !v)}
              >
                🤖 서브 {(() => {
                  const running = subagents.filter(([, , , its]) => {
                    const last = its[its.length - 1];
                    return (
                      last?.agent_status === "in_progress" || last?.agent_status === "pending"
                    );
                  }).length;
                  return running > 0 ? `${running}▶` : subagents.length;
                })()}
              </button>
            )}
            {lastSeed && (
              <button
                className="claudeterm-head-btn"
                title="시드 프롬프트를 현재 세션에 다시 보냅니다 (자동 주입이 빗나갔을 때)"
                onClick={() => injectSeed(lastSeed)}
              >
                시드 재주입
              </button>
            )}
            <button
              className="claudeterm-head-btn"
              title="세션 아카이브: JSONL 원본 + 책(book.html) + 요약 + 지식(issue/method/domain) 추출 — 세션은 종료되지 않고 계속 사용 가능"
              disabled={archiveBusy || !props.params.sessionUuid}
              onClick={archiveSession}
            >
              {archiveBusy ? "아카이브 중…" : "아카이브"}
            </button>
          </span>
        </div>
        <div className="claudeterm-term" ref={hostRef} />
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

      {showAgents && subagents.length > 0 && (
        <>
          <div className="claudeterm-splitter" title="드래그로 크기 조절" onMouseDown={startDragAgents} />
          <div
            className="claudeterm-pane claudeterm-agents-pane"
            ref={agentsPaneRef}
            style={{ flex: `0 0 ${agentsWidth}px` }}
          >
            <div className="claudeterm-pane-head">
              <span className="claudeterm-pane-head-title">서브에이전트</span>
              <span
                className="claudeterm-viewer-x"
                title="닫기"
                onClick={() => setShowAgents(false)}
              >
                ×
              </span>
            </div>
            <SubagentsPane
              subagents={subagents}
              selectedId={selectedId}
              onSelect={(it) => {
                setSelectedId(it.tool_call_id);
                setTextView(null);
                setSelectedTurn(null);
              }}
            />
          </div>
        </>
      )}
      {!timelineCollapsed && (
        <div className="claudeterm-splitter" title="드래그로 크기 조절" onMouseDown={startDragTimeline} />
      )}
      {timelineCollapsed && (
        <button
          className="claudeterm-timeline-expand"
          title="타임라인 펼치기"
          onClick={() => setTimelineCollapsed(false)}
        >
          ◀ 타임라인
        </button>
      )}
      <div
        className="claudeterm-pane claudeterm-timeline-pane"
        ref={timelineRef}
        style={timelineCollapsed ? { display: "none" } : { flex: `0 0 ${timelineWidth}px` }}
      >
        <div className="claudeterm-pane-head">
          <span className="claudeterm-pane-head-title">타임라인</span>
          <span
            className="claudeterm-viewer-x"
            title="타임라인 접기"
            onClick={() => setTimelineCollapsed(true)}
          >
            ▶
          </span>
        </div>
        <div className="claudeterm-timeline">
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
    </div>
  );
}
