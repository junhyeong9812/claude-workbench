import { useEffect, useMemo, useRef, useState } from "react";
import { buildItemIndex } from "./timelineIndex";
import { decodePtyData, ptyEventName, pushPendingCapped } from "./pty";
import { ViewModeToggle } from "./ViewModeToggle";
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
import { openArgs, paramsAfterOpen } from "../state/claudeTermParams";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TimelineView, ItemDetail, MarkdownText } from "./TimelineView";
import {
  ctxWindow,
  useTimelineState,
  type ClaudeTimelineEvent,
  type TimelineSnapshotLike,
} from "../hooks/useClaudeTimeline";
import { openTimelinePeek } from "../state/timelinePeek";
import {
  DEFAULT_REFINE_MODEL,
  PROMPT_FENCE,
  REFINE_MODELS,
  applyBlockReason,
  bracketedPaste,
  extractLatestPromptBlock,
  isRefineParams,
  loadLastRefineModel,
  openPromptRefine,
  saveLastRefineModel,
  type RefineModel,
} from "../state/promptRefine";
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
  /** Directory to root the PTY in, when it must differ from `project`. Only the
   * external-session adopt path sets this: the CLI finds a session to `--resume`
   * only from the directory that session was created in (measured — resuming
   * from anywhere else fails with "No conversation found"), while `project`
   * stays the app's own project so the snapshot, archive and session list all
   * agree on one key. Absent = same as `project` (every other caller).
   *
   * **Persistent** — a restored layout must still spawn in the right directory. */
  spawnCwd?: string;
  /** Ask the backend to re-check liveness before spawning. **One-shot**: set by
   * the picker when the user adopts an external session, and cleared the moment
   * the session opens.
   *
   * It cannot be derived from `spawnCwd`, which has to persist: the taking-over
   * *is* a one-time event, and after it the session is ours like any other. A
   * persistent trigger would re-check on every remount and app restart, so an
   * unrelated bare `claude` in the same directory would make the app refuse to
   * reopen its own session (audit B1). */
  adoptPending?: boolean;
  /** One-shot prompt injected once when this session first starts (review/dev
   * modes seed it with "이 커밋 리뷰하자" / "이 파일 검토해줘"). Cleared from the
   * persisted params after injection so a tab-switch remount won't re-send it. */
  seed?: string;
  /** 이 패널이 **프롬프트 정리 세션**임을 나타내는 표식(`state/promptRefine`).
   * `kind`는 claudeterm 그대로 둔다 — 세션 수명 경로를 물려받아야 PTY가 새지
   * 않는다. **유지**(패널의 성격이지 1회성 사건이 아니다). */
  refineKind?: string;
  /** 정리 세션 전용: 이 패널을 연 Claude 탭의 패널 id. 적용 대상 앵커이자
   * "원본 탭이 닫히면 같이 닫힌다"의 판정 키. **유지**. */
  sourcePanelId?: string;
  /** 정리 세션 전용: [적용]이 최종본을 채워 넣을 원본 세션의 uuid. **유지**. */
  targetUuid?: string;
  /** 스폰 시 `--model` 별칭(`opus`/`fable`). 정리 세션만 설정한다 — 없으면 CLI
   * 기본값(기존 모든 세션의 동작). **유지**: 재시작 후에도 같은 모델로 떠야 한다. */
  model?: string;
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
  // 타임라인 상태 + 스냅샷 적용은 공용 훅 소유 (peek 패널과 공유 — 순수 이동).
  // 구독 배선(리스너 등록 순서·PTY 수명)은 아래 마운트 이펙트가 그대로 들고 있고,
  // `onApply`(상태 반영 직후 실행)로 이 패널만의 attention 배지 파생을 붙인다.
  const {
    items,
    turns,
    answers,
    dates,
    subagents,
    tokenTotal,
    ctxModel,
    ctxTokens,
    applySnapshot,
    setSubagents,
  } = useTimelineState((s, origin) => {
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
  });
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
  // 세션이 실제로 열렸는가 — `sessionIdRef`의 **상태판**. ref만으로는 "아직 안
  // 열려서 배달을 미룬" 이펙트를 다시 태울 신호가 없다(리뷰 #2).
  const [sessionOpened, setSessionOpened] = useState(false);
  // The last one-shot seed (review/dev prompt), so the user can re-inject it if
  // the auto-attempt missed the prompt (ready detection is best-effort).
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  // 종료(아카이브): archive the session's transcript + extraction. The session
  // stays live (closing the tab is a separate, archive-free action).
  const [archiveBusy, setArchiveBusy] = useState(false);

  // ---- 프롬프트 정리 세션 (state/promptRefine) ---------------------------
  // 이 패널이 정리 세션인가. 패널의 성격이라 수명 내내 불변 — 마운트 이펙트가
  // 그대로 읽어도 안전하다.
  const isRefine = isRefineParams(props.params);
  const refineModel = (props.params.model as RefineModel | undefined) ?? DEFAULT_REFINE_MODEL;
  // codex 2차 의견 — 적용과 무관한 참고용(하단 접이식).
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexResult, setCodexResult] = useState<string | null>(null);
  const [codexOpen, setCodexOpen] = useState(true);

  /** Raw bytes to this session's PTY (driver-gated in the backend).
   *
   * **에러를 삼키지 않는다** — 호출부가 배달 성공을 알아야 하는 경로가 있다
   * (프롬프트 정리 [적용]은 write ACK 뒤에야 정리 세션을 끝낸다, 리뷰 #4). 그냥
   * 쏘고 잊는 자리는 각자 `.catch(() => {})`를 붙인다. */
  const writeToSession = (text: string): Promise<void> => {
    const id = sessionIdRef.current;
    if (id == null) return Promise.reject(new Error("세션이 아직 열리지 않았습니다."));
    return invoke("claude_write", {
      id,
      data: Array.from(new TextEncoder().encode(text)),
    });
  };

  /** Write the seed (+Enter) to the current session — the review/dev one-shot
   * prompt path, byte-for-byte unchanged. */
  const injectSeed = (text: string) => writeToSession(text + "\n");

  /** 입력창에 **채우기만** 한다 — 제출 없음.
   *
   * 프롬프트 정리 [적용]의 유일한 주입 경로다. bracketed paste로 감싸고 CR을 절대
   * 붙이지 않는다(`promptRefine.bracketedPaste`가 그 불변식을 소유하고 테스트가
   * 고정한다). 실측(2026-08-05, claude CLI 2.1.222): 이 형태로 여러 줄을 넣으면
   * 입력창에 그대로 채워지고 전사 파일조차 생기지 않는다(=제출 안 됨). */
  const fillInput = (text: string) => writeToSession(bracketedPaste(text));

  /** 한 줄 프롬프트를 채우고 **제출**한다 (정리 세션의 규약 시드 전용).
   *
   * 실측(같은 날): claude TUI는 `\r`만 제출로 읽고 — `\n`은 소프트 개행이다 —
   * 그나마도 입력 버퍼가 **한 줄일 때만** 제출된다. 그래서 시드는 한 줄이고
   * (`refineSeedPrompt`), 개행이 섞여 들어와도 공백으로 접어 계약을 지킨다. */
  const submitSingleLine = (text: string) => writeToSession(`${text.replace(/\s*\n\s*/g, " ")}\r`);

  // Dev mode 확인: inject a review prompt into THIS session if it's the target
  // (matched by uuid) and we're its driver and live. The first "open + seed" goes
  // through the seed mechanism; this handles subsequent injects into the already-
  // live per-project dev session.
  const claudeInjectRequest = useAppStore((s) => s.claudeInjectRequest);
  const requestClaudeInject = useAppStore((s) => s.requestClaudeInject);
  // 처리에 착수한 요청 — 리마운트·deps 재평가로 같은 요청을 두 번 쓰지 않게.
  const injectHandledRef = useRef<object | null>(null);
  useEffect(() => {
    if (!claudeInjectRequest) return;
    const myUuid = props.params.sessionUuid ?? props.params.loadSessionId;
    if (!myUuid || claudeInjectRequest.uuid !== myUuid) return;
    // 아직 배달할 수 없다(미러이거나 세션이 안 열림) — **요청을 소비하지 않고**
    // 그대로 둔다. 아래 deps가 두 조건의 변화를 각각 다시 태운다.
    if (!isDriverRef.current || sessionIdRef.current == null) return;
    if (injectHandledRef.current === claudeInjectRequest) return;
    const req = claudeInjectRequest;
    injectHandledRef.current = req;
    void (async () => {
      try {
        // "fill" = 프롬프트 정리 [적용] — 채우기만 하고 제출하지 않는다.
        if (req.mode === "fill") await fillInput(req.text);
        else await injectSeed(req.text);
      } catch {
        // 쓰기 실패 = 미배달. 요청을 남겨 두고 재시도 가능 상태로 되돌린다 —
        // 여기서 소비해 버리면 정리 세션은 이미 사라졌는데 텍스트만 증발한다.
        injectHandledRef.current = null;
        return;
      }
      // ACK 이후에만 소비한다. 그 사이 다른 요청이 슬롯을 덮었으면 건드리지 않는다.
      if (useAppStore.getState().claudeInjectRequest === req) requestClaudeInject(null);
    })();
    // deps 근거:
    // - `isDriver` — 미러인 동안 도착한 요청은 위에서 그냥 반환한다. 없으면 입력
    //   권한을 가져와도 재평가가 없어 텍스트가 조용히 사라진다.
    // - `sessionOpened` — 소스 탭이 언마운트/마운트 중이면 sessionIdRef가 아직
    //   null이라 같은 이유로 반환한다. 세션이 열린 사실을 **상태로** 노출해 이
    //   이펙트를 다시 태운다(리뷰 #2 — 배달 시점까지 요청은 살아 있다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeInjectRequest, isDriver, sessionOpened]);

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
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // 드래그 도중 패널이 언마운트되면(onUp 미도달) 리스너·pending rAF 해제 (리뷰 P3).
  useEffect(() => () => dragCleanupRef.current?.(), []);
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
    const teardown = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };
    const onUp = () => {
      if (moved) set(compute(lastX)); // 마지막 좌표 확정 커밋 — 최종 폭 보존
      teardown();
    };
    dragCleanupRef.current = teardown;
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
      // P3: 10000행(≈19MB/패널 × 동시 마운트 3 = 창당 ~60MB) → 3000행 상한.
      scrollback: 3000,
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

    const write = (bytes: Uint8Array | number[]) => {
      if (!disposed) {
        term.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        blockedScanner.trigger(scanOrigin);
      }
    };
    const applyLive = (ev: TerminalOutputEvent) => {
      if (ev.session_id === sessionId && ev.seq > lastApplied) {
        // Genuinely new PTY output — from here on, scans report live edges (S4a).
        scanOrigin = "live";
        write(decodePtyData(ev.data));
        lastApplied = ev.seq;
      }
    };
    // P3: 세션별 PTY 이벤트 구독(전 패널 K배 역직렬화 제거). open이 id를 준
    // 직후·스냅샷 **전**에 구독한다(R1-1 계약 유지 — 구독~스냅샷 사이 청크는
    // pending 버퍼(상한부) + seq 게이트가 정확히 잇는다).
    let pendingTotal = 0;
    let pendingDropped = false;
    const subscribeOutput = async (id: number) => {
      if (unlistenTerm) unlistenTerm();
      unlistenTerm = undefined;
      const un = await listen<TerminalOutputEvent>(ptyEventName(id), (e) => {
        if (!ready) {
          const r = pushPendingCapped(pending, e.payload, pendingTotal);
          pendingTotal = r.total;
          pendingDropped ||= r.dropped;
        } else applyLive(e.payload);
      });
      // await 중 언마운트 — cleanup은 이미 지나갔으므로 즉시 해제(리뷰 P1).
      if (disposed) {
        un();
        return;
      }
      unlistenTerm = un;
    };
    // pending 드롭 시 drain 직전 재스냅샷으로 갭을 잇는다(리뷰 P1/P2 — 중간
    // 절단 방지). 초기화는 RIS(ESC c)를 write 큐로 — 동기 reset()은 큐 잔여
    // 도장분과 순서가 깨진다(감사 B1). 재드롭 시 신호 소진까지 반복(감사 B2).
    const healDroppedGap = async () => {
      // 매 회 pending을 비우고 스냅샷으로 완전 대체 — 상한 없이 무갭(지속
      // 홍수에선 스냅샷 폴링으로 강등, disposed/세션 소멸 탈출. TerminalPanel
      // 동일 로직 참조).
      while (pendingDropped && sessionId != null && !disposed) {
        pendingDropped = false;
        pending.length = 0;
        pendingTotal = 0;
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: sessionId });
          if (disposed) return;
          write(new TextEncoder().encode("\x1bc")); // RIS — 큐 순서로 전체 초기화
          write(decodePtyData(snap.data));
          lastApplied = snap.last_seq;
        } catch {
          return; /* 세션 소멸 — drain이 seq 게이트로 처리 */
        }
      }
    };

    (async () => {
      // Listeners first (buffer until ready), so nothing is missed.
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
        // cwd(유지)와 adopt(1회성)의 수명 규칙은 순수 모듈 소유 — 인수하는 그
        // 한 번만 백엔드가 스폰 직전 live 재검증을 한다. 앱이 이미 소유한
        // 세션에는 걸지 않는다: 우리 자신의 argv에 uuid가 실려 있어 스스로를
        // "사용 중"으로 막게 된다(B1).
        const { cwd, adopt } = openArgs(props.params, project);
        const opened = await invoke<ClaudeOpened>("claude_open_or_attach", {
          project,
          uuid: openUuid,
          cwd,
          adopt,
          // 정리 세션만 모델을 못박는다. null이면 백엔드가 `--model`을 아예 붙이지
          // 않으므로 기존 세션의 동작은 그대로다.
          model: (props.params.model as string | undefined) ?? null,
          name: (props.params.title as string) ?? null,
          cols: term.cols,
          rows: term.rows,
        });
        sessionId = opened.id;
        // 프롬프트 정리 세션은 attention 체계에 **등록하지 않는다**(리뷰 #12):
        // 사용자 바로 옆에 떠 있는 임시 보조 세션이라, 배지·롤업·알림에 끼면
        // 실제 작업 세션의 신호를 희석한다. 등록을 건너뛰면 updateFromTimeline도
        // statusUuidRef가 null이라 조용히 no-op이 된다.
        if (!isRefine) {
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
        // 1회성 필드(seed 주입·adopt 재검증)는 지우고 나머지는 보존 —
        // `spawnCwd`는 **남는다**(재시작 후에도 원 디렉토리에서 띄워야 한다).
        props.api.updateParameters(paramsAfterOpen(props.params, opened));
      } catch (e) {
        sessionId = null; // open failed (no project, adopt refused, …)
        // 조용히 빈 패널만 남기면 왜 아무 일도 안 일어났는지 알 길이 없다.
        // 대표 사례가 adopt 거부(그 세션이 다른 곳에서 열려 있음)라, 이유를
        // 터미널 화면에 그대로 띄우고 목록을 다시 열도록 안내한다.
        if (!disposed) {
          term.write(`\r\n\x1b[31m[세션을 열지 못했습니다]\x1b[0m ${errText(e)}\r\n`);
          if (props.params.adoptPending === true) {
            term.write(
              "\x1b[2m이 탭을 닫고 \"+ Claude\" 목록을 다시 열면 최신 상태로 다시 확인합니다.\x1b[0m\r\n",
            );
          }
        }
      }
      if (disposed) return;
      // Backfill scrollback. 구독(세션별 이벤트)이 스냅샷보다 먼저이므로 live
      // 청크는 pending에 쌓이고 `seq > last_seq` drain이 스냅샷 중복을 걸러
      // 잇는다(review R1-1/R7-8); a fresh start just returns empty scrollback.
      if (sessionId != null) {
        await subscribeOutput(sessionId);
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: sessionId });
          write(decodePtyData(snap.data));
          lastApplied = snap.last_seq;
        } catch {
          /* fresh session — no scrollback yet */
        }
      }

      sessionIdRef.current = sessionId;
      // 대기 중인 주입 요청을 깨우는 신호 (리뷰 #2).
      if (!disposed) setSessionOpened(sessionId != null);
      await healDroppedGap();
      ready = true;
      for (const ev of pending) applyLive(ev);
      pending.length = 0;
      pendingTotal = 0;
      pendingDropped = false;

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
            // 정리 세션의 규약 시드는 대화를 **시작**시켜야 하므로 제출까지 한다
            // (한 줄 + CR — 실측 근거는 submitSingleLine). 나머지 시드는 기존
            // 경로 그대로(바이트 무변경).
            if (isRefine) submitSingleLine(seed);
            else injectSeed(seed);
            pendingSeedRef.current = null;
          }
        }, 1800);
      }

      // Seed the timeline from the saved snapshot (reopen or tab-switch
      // re-attach) so it isn't empty until the next live change — unless a live
      // event already arrived (which is newer).
      const seedUuid = props.params.sessionUuid ?? props.params.loadSessionId;
      if (seedUuid && project) {
        invoke<TimelineSnapshotLike | null>("claude_session_snapshot", {
          project,
          uuid: seedUuid,
        })
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

  // tool_call_id → item 인덱스 (P0 F2, 순수 모듈 buildItemIndex + 특성테스트).
  // 전제: items/subagents는 payload 수신마다 새 배열로 교체된다(applySnapshot).
  const itemIndex = useMemo(
    () => buildItemIndex(items, subagents.map(([, , , its]) => its)),
    [items, subagents],
  );
  const selectedItem = selectedId ? (itemIndex.get(selectedId) ?? null) : null;

  // P1: 절단(content_truncated) 아이템 선택 시 원문을 lazy 조회해 뷰어에
  // 전문을 보여준다. 듀얼 리뷰 수정(#4·#11): 캐시 키는 `${uuid}:${tool_call_id}`
  // (세션 결속 — 패널 재사용/합성 id 충돌 방지), effect 의존성은 키 문자열
  // (selectedItem 객체는 emit마다 새 참조 — 객체 dep이면 invoke 폭주), 실패도
  // null sentinel로 캐시(무한 재시도 방지) + in-flight 가드 + 개수 상한(FIFO
  // 축출 — 목적은 메모리 바운드, 원문 수 MB가 힙에 무한 상주하지 않게).
  const DETAIL_CACHE_MAX = 8;
  const [fullDetail, setFullDetail] = useState<Map<string, string | null>>(new Map());
  const detailInFlight = useRef<Set<string>>(new Set());
  const [detailRetry, setDetailRetry] = useState(0);
  const detailUuid = props.params.sessionUuid ?? props.params.loadSessionId ?? null;
  // 타임라인 peek 대상 = 이 패널의 세션 (열리기 전에는 resume/신규 uuid가 곧 그
  // 세션의 uuid — claude_open_or_attach가 그 값을 못박는다).
  const peekUuid = detailUuid;

  // ---- 프롬프트 정리: 최종본 추출 · 적용 · codex 검증 --------------------
  // 세션 전체에서 가장 최근의 **닫힌** ```prompt 블록(턴 역방향). `answers`는
  // 백엔드가 절단하지 않는다(cap_content는 items 전용)라 최종본이 잘릴 일이 없다.
  const refinedPrompt = useMemo(
    () => (isRefine ? extractLatestPromptBlock(answers) : null),
    [isRefine, answers],
  );
  // [적용] 게이트 입력 — 대상 세션이 권한/선택 프롬프트에 걸려 있으면 페이스트가
  // 키 입력으로 소비된다(리뷰 #1). 구독이라 상태가 바뀌면 버튼도 즉시 따라간다.
  const refineTargetUuid = isRefine ? (props.params.targetUuid ?? null) : null;
  const refineTargetBlocked = useClaudeStatus((s) =>
    refineTargetUuid ? s.entries[refineTargetUuid]?.status === "blocked" : false,
  );
  // [적용] 진행 상태 — 배달 ACK를 기다리는 동안 true (리뷰 #4).
  const [applyPending, setApplyPending] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const applyReqRef = useRef<object | null>(null);
  const applyReason = isRefine
    ? applyBlockReason({
        block: refinedPrompt,
        targetUuid: refineTargetUuid,
        targetBlocked: refineTargetBlocked,
        slotBusy: claudeInjectRequest !== null,
        pending: applyPending,
      })
    : null;

  /** 이 Claude 탭 오른쪽에 프롬프트 정리 세션을 연다(탭당 1개). */
  const openRefinePanel = async (model: RefineModel) => {
    if (!peekUuid) return;
    try {
      // 격리 디렉토리는 백엔드가 정본이다 — 프론트가 /tmp를 짓지 않는다.
      const workdir = await invoke<string>("prompt_refine_workdir");
      openPromptRefine(props.containerApi, {
        sourcePanelId: props.api.id,
        targetUuid: peekUuid,
        workdir,
        sessionUuid: crypto.randomUUID(),
        model,
        title: (props.params.title as string) ?? "세션",
      });
    } catch (e) {
      alert(`프롬프트 정리 세션을 열지 못했습니다: ${errText(e)}`);
    }
  };

  /** 모델 세그 선택. 스폰 전이면 params만 갈아끼우고, 이미 떠 있으면 재스폰 확인
   * (돌고 있는 PTY의 모델은 바꿀 수 없다 — `--model`은 스폰 인자다). */
  const chooseRefineModel = (model: RefineModel) => {
    if (model === refineModel) return;
    // 다음 정리 세션이 처음부터 이 모델로 뜨게 기억한다 — 재스폰이 파괴적이라
    // 매번 "열고 바꾸고 날리고 다시 열기"를 반복하지 않도록(리뷰 #12).
    saveLastRefineModel(model);
    if (sessionIdRef.current == null) {
      props.api.updateParameters({ ...props.params, model });
      return;
    }
    if (
      !confirm(
        "모델은 세션을 시작할 때 정해집니다.\n지금 바꾸려면 이 정리 세션을 닫고 새로 시작해야 합니다 — 지금까지의 대화는 사라집니다. 진행할까요?",
      )
    )
      return;
    const sourcePanelId = props.params.sourcePanelId;
    const targetUuid = props.params.targetUuid;
    const workdir = props.params.project;
    const containerApi = props.containerApi;
    const title = ((props.params.title as string) ?? "").replace(/^프롬프트 정리 — /, "") || "세션";
    props.api.close();
    // 재생성은 제거가 반영된 뒤에 — 패널 id가 결정적이라 같은 틱에 다시 추가하면
    // 중복 id가 된다.
    queueMicrotask(() => {
      if (!sourcePanelId || !targetUuid || !workdir) return;
      openPromptRefine(containerApi, {
        sourcePanelId,
        targetUuid,
        workdir,
        sessionUuid: crypto.randomUUID(),
        model,
        title,
      });
    });
  };

  /** [적용]: 최종본을 **원본 세션 입력창에 채우고**(제출 없음) 정리 세션을 끝낸다.
   *
   * 순서가 계약이다(리뷰 #4): 요청을 올려놓고 **배달 ACK(claude_write 성공)를 본
   * 뒤에야** 패널을 닫는다. 예전처럼 먼저 닫으면 배달이 실패했을 때 정리 세션은
   * 이미 사라졌는데 텍스트만 증발한다 — 사용자가 복구할 방법이 없는 손실이다.
   * ACK 신호는 슬롯이 비는 것: 원본 패널의 소비 이펙트가 write를 await한 뒤에만
   * 요청을 지운다.
   *
   * 주입은 기존 요청 버스(claudeInjectRequest)를 탄다 — 원본 패널이 driver·live일
   * 때만 쓰고, 그 탭이 잠시 언마운트돼 있으면 요청이 남아 있다가 마운트 때
   * 배달된다(유실≠소비, DevView 선례). */
  const applyRefined = () => {
    if (applyReason) {
      setApplyNote(applyReason);
      return;
    }
    const text = refinedPrompt;
    const target = refineTargetUuid;
    if (!text || !target) return;
    const req = { uuid: target, text, mode: "fill" as const };
    setApplyNote(null);
    useAppStore.getState().requestClaudeInject(req);
    // 슬롯을 실제로 잡았을 때만 대기 상태로 — 잡지 못했으면 아래 감시가 우리 것도
    // 아닌 요청의 소비를 보고 패널을 닫아 버린다.
    if (useAppStore.getState().claudeInjectRequest !== req) {
      setApplyNote("다른 프롬프트 주입이 먼저 슬롯을 차지했습니다 — 잠시 뒤 다시 시도하세요.");
      return;
    }
    applyReqRef.current = req;
    setApplyPending(true);
  };

  // 적용 배달 감시 — 슬롯이 비면 성공(패널 닫기), 남의 요청으로 바뀌었으면 취소,
  // 오래 그대로면 미배달로 보고 **정리 세션을 보존한 채** 사유를 알린다.
  useEffect(() => {
    if (!applyPending) return;
    const mine = applyReqRef.current;
    if (claudeInjectRequest === null) {
      // ACK — 이제서야 정리 세션을 끝낸다(패널 제거 → claude_detach).
      setApplyPending(false);
      applyReqRef.current = null;
      props.api.close();
      return;
    }
    if (claudeInjectRequest !== mine) {
      setApplyPending(false);
      applyReqRef.current = null;
      setApplyNote("다른 프롬프트 주입이 끼어들어 적용이 취소되었습니다 — 다시 시도하세요.");
      return;
    }
    const t = setTimeout(() => {
      setApplyPending(false);
      applyReqRef.current = null;
      // 우리 요청이 아직 슬롯에 남아 있으면 치운다 — 남겨 두면 다른 주입까지 막는다.
      if (useAppStore.getState().claudeInjectRequest === mine)
        useAppStore.getState().requestClaudeInject(null);
      setApplyNote(
        "원래 세션에 전달하지 못했습니다 — 그 탭이 열려 있고 이 창이 입력 권한을 가진 상태인지 확인한 뒤 다시 [적용]하세요. (정리 세션은 그대로 둡니다)",
      );
    }, 10000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyPending, claudeInjectRequest]);

  /** [codex 검증]: 현재 최종본을 codex에 비판시켜 하단에 표시(적용과 무관). */
  const runCodexCheck = async () => {
    const text = refinedPrompt;
    if (!text || codexBusy) return;
    setCodexBusy(true);
    setCodexOpen(true);
    setCodexResult(null);
    try {
      setCodexResult(await invoke<string>("run_codex_check", { prompt: text }));
    } catch (e) {
      // 실패는 무해 — 검증을 건너뛴다는 안내만 남기고 정리 세션은 계속된다.
      setCodexResult(`codex 검증을 건너뜁니다: ${errText(e)}`);
    } finally {
      setCodexBusy(false);
    }
  };

  // 정리 세션은 원본 Claude 탭의 **동반 패널**이다 — 그 탭이 dock에서 사라지면
  // (닫기, 또는 다른 창으로 전송) 같이 닫는다. 남겨 두면 적용 대상이 없는 세션이
  // 혼자 돌게 되고, 단발성이라는 의미와도 어긋난다. (peek와 같은 규약 —
  // TimelinePeekPanel 참조. 닫기는 마이크로태스크로 미뤄 dock 콜백 재진입을 피한다.)
  const refineSourceId = isRefine ? (props.params.sourcePanelId ?? null) : null;
  const panelApi = props.api;
  const containerApi = props.containerApi;
  useEffect(() => {
    if (!refineSourceId) return;
    const closeLater = () => queueMicrotask(() => panelApi.close());
    if (!containerApi.getPanel(refineSourceId)) closeLater();
    const d = containerApi.onDidRemovePanel((p) => {
      if (p.id === refineSourceId) closeLater();
    });
    return () => d.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refineSourceId]);
  const detailProject = props.params.project ?? useAppStore.getState().activeProject ?? null;
  const detailKey =
    selectedItem?.content_truncated && detailUuid
      ? `${detailUuid}:${selectedItem.tool_call_id}`
      : null;
  const cacheDetail = (key: string, text: string | null) =>
    setFullDetail((prev) => {
      const next = new Map(prev);
      next.delete(key); // 재삽입으로 최신화(Map 삽입 순서 = LRU 순서)
      next.set(key, text);
      while (next.size > DETAIL_CACHE_MAX) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });
  useEffect(() => {
    if (!detailKey || !detailUuid || !detailProject) return;
    if (fullDetail.has(detailKey) || detailInFlight.current.has(detailKey)) return;
    const key = detailKey;
    const tcid = key.slice(detailUuid.length + 1);
    detailInFlight.current.add(key);
    // 감사 B2: 결과는 선택 이탈 여부와 무관하게 **항상** 캐시한다(키 스코프라
    // 오염 없음). 이탈 시 버리면 — A 조회 중 B 갔다 A 복귀 → in-flight 가드가
    // 재발주를 막는데 결과도 없음 → 영구 "불러오는 중" race.
    invoke<{ content_text: string | null }>("claude_item_detail", {
      project: detailProject,
      uuid: detailUuid,
      toolCallId: tcid,
    })
      .then((d) => {
        cacheDetail(key, d.content_text);
      })
      .catch(() => {
        cacheDetail(key, null); // 실패 sentinel — 배너가 재시도 제공
      })
      .finally(() => {
        detailInFlight.current.delete(key);
      });
    // fullDetail dep: 늦게 도착한 다른 키의 캐시가 상한 축출로 **현재** 키를
    // 밀어내면 재조회할 상태 변화가 없어 로딩 고착 — 캐시 변화마다 재평가해
    // 미스면 재발주한다(현재 키가 캐시되면 has() 가드로 즉시 반환 — 루프 없음).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailKey, detailProject, detailRetry, fullDetail]);
  const cachedFull = detailKey != null ? fullDetail.get(detailKey) : undefined;
  const hydratedItem =
    selectedItem && typeof cachedFull === "string"
      ? {
          ...selectedItem,
          content_text: cachedFull,
          content_truncated: false,
        }
      : selectedItem;
  // 절단 상태 안내(#5, spec §2 "실패 시 절단본+안내"): hydrated가 여전히 절단
  // = 원문 미도착 — 로딩 중이거나 실패(sentinel null).
  const detailFailed = detailKey != null && cachedFull === null;
  const retryDetail = () => {
    if (!detailKey) return;
    setFullDetail((prev) => {
      const next = new Map(prev);
      next.delete(detailKey);
      return next;
    });
    setDetailRetry((r) => r + 1);
  };

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
            {isRefine && (
              <>
                <span className="seg" role="group" aria-label="정리 세션 모델">
                  {REFINE_MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`seg-item${refineModel === m.id ? " seg-on" : ""}`}
                      aria-pressed={refineModel === m.id}
                      title="정리 세션을 띄울 모델 — 스폰 이후에는 세션을 다시 시작해야 바뀝니다"
                      onClick={() => chooseRefineModel(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </span>
                <button
                  className="claudeterm-head-btn"
                  disabled={applyReason !== null}
                  title={
                    applyReason ??
                    "최종본을 원래 세션 입력창에 채웁니다 (제출하지 않습니다) — 전달이 확인되면 이 정리 세션은 종료됩니다"
                  }
                  onClick={applyRefined}
                >
                  {applyPending ? "적용 중…" : "적용"}
                </button>
                <button
                  className="claudeterm-head-btn"
                  disabled={!refinedPrompt || codexBusy}
                  title={
                    refinedPrompt
                      ? "현재 최종본을 codex에 비판시켜 아래에 보여줍니다 (적용과 무관 · 실패해도 무해)"
                      : `아직 최종본이 없습니다 — 정리 도우미가 ${PROMPT_FENCE}prompt 블록을 닫아서 출력하면 활성화됩니다`
                  }
                  onClick={() => void runCodexCheck()}
                >
                  {codexBusy ? "codex 검증 중…" : "codex 검증"}
                </button>
              </>
            )}
            {!isRefine && peekUuid && (
              <button
                className="claudeterm-head-btn"
                title="이 세션의 타임라인을 오른쪽에 임시 패널로 엽니다 (같은 세션은 1개 · 앱을 다시 켜면 복원되지 않습니다)"
                onClick={() =>
                  openTimelinePeek(props.containerApi, {
                    sourcePanelId: props.api.id,
                    uuid: peekUuid,
                    project: props.params.project ?? useAppStore.getState().activeProject ?? null,
                    title: (props.params.title as string) ?? "세션",
                  })
                }
              >
                ⧉ 타임라인
              </button>
            )}
            {!isRefine && peekUuid && (
              <button
                className="claudeterm-head-btn"
                title="프롬프트 정리 세션을 오른쪽에 엽니다 — 대화로 다듬은 뒤 [적용]하면 이 세션 입력창에 채워집니다 (자동 제출 없음 · 앱을 다시 켜면 복원되지 않습니다)"
                onClick={() => void openRefinePanel(loadLastRefineModel())}
              >
                ✏ 프롬프트 정리
              </button>
            )}
            {lastSeed && (
              <button
                className="claudeterm-head-btn"
                title="시드 프롬프트를 현재 세션에 다시 보냅니다 (자동 주입이 빗나갔을 때)"
                onClick={() => (isRefine ? submitSingleLine(lastSeed) : injectSeed(lastSeed))}
              >
                시드 재주입
              </button>
            )}
            {/* 아카이브는 정리 세션에 없다 — 스크래치 세션을 아카이브하면 격리해
                둔 전사가 그대로 지식베이스로 들어간다(spec ④ 금지영역). */}
            {!isRefine && (
              <button
                className="claudeterm-head-btn"
                title="세션 아카이브: JSONL 원본 + 책(book.html) + 요약 + 지식(issue/method/domain) 추출 — 세션은 종료되지 않고 계속 사용 가능"
                disabled={archiveBusy || !props.params.sessionUuid}
                onClick={archiveSession}
              >
                {archiveBusy ? "아카이브 중…" : "아카이브"}
              </button>
            )}
          </span>
        </div>
        {isRefine && applyNote && (
          <div className="claudeterm-refine-note" role="status">
            {applyNote}
            <span
              className="claudeterm-refine-note-x"
              title="닫기"
              onClick={() => setApplyNote(null)}
            >
              ×
            </span>
          </div>
        )}
        <div className="claudeterm-term" ref={hostRef} />
        {isRefine && (codexBusy || codexResult) && (
          <div className="claudeterm-codex">
            <button
              className="claudeterm-codex-head"
              aria-expanded={codexOpen}
              title="codex 2차 의견 접기/펼치기"
              onClick={() => setCodexOpen((v) => !v)}
            >
              <span>{codexOpen ? "▾" : "▸"} codex 검증{codexBusy ? " — 실행 중…" : ""}</span>
            </button>
            {codexOpen && (
              <div className="claudeterm-codex-body">
                {codexResult ? (
                  <MarkdownText text={codexResult} />
                ) : (
                  <span className="claudeterm-codex-wait">codex에게 물어보는 중입니다…</span>
                )}
              </div>
            )}
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
              <ViewModeToggle markdown={detailMarkdown} onToggle={() => setDetailMarkdown((v) => !v)} />
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
              {!textView && hydratedItem?.content_truncated && (
                <div className="claudeterm-trunc-note">
                  {detailFailed ? (
                    <>
                      원문 조회 실패 — 32KB 절단본 표시 중
                      <button className="claudeterm-trunc-retry" onClick={retryDetail}>
                        재시도
                      </button>
                    </>
                  ) : (
                    <>절단본 표시 중 — 원문 불러오는 중…</>
                  )}
                </div>
              )}
              {textView ? (
                detailMarkdown ? (
                  <MarkdownText text={textView.text} />
                ) : (
                  <pre className="claudeterm-text">{textView.text}</pre>
                )
              ) : (
                <ItemDetail item={hydratedItem!} markdown={detailMarkdown} />
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
