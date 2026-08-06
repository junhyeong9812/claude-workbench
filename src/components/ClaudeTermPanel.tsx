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
  DEFAULT_REFINE_VIEW,
  PROMPT_FENCE,
  REFINE_MODELS,
  REFINE_SUBMIT_CONFIRM_MS,
  REFINE_SUBMIT_CR_DELAY,
  REFINE_VIEWS,
  applyBlockReason,
  bracketedPaste,
  extractLatestPromptBlock,
  injectDeliveryDecision,
  isRefineParams,
  loadLastRefineModel,
  makeSubmitProbe,
  openPromptRefine,
  refineCloseDecision,
  refineCloseFailure,
  refineClosePhase,
  refineMemoLocked,
  refineExitAction,
  refineMemoStoreKey,
  refineViewStyle,
  resolveApplyAck,
  saveLastRefineModel,
  sendBlockReason,
  shouldNavPanes,
  submitPasteBytes,
  type RefineExitReason,
  type RefineModel,
  type RefineView,
} from "../state/promptRefine";
import { MemoEditor, type MemoDoc, type MemoHandle, type MemoSaveResult } from "./MemoEditor";
import { useClaudeUi } from "../state/claudeUi";
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
  /** 이 정리 세션의 uuid — 아카이브 대상(세션마다 새로 생긴다). */
  const refineUuid = isRefine
    ? (props.params.sessionUuid ?? props.params.loadSessionId ?? null)
    : null;
  /** 초안의 저장 키 — **세션이 아니라 이 정리 작업**에 딸린다(리뷰 #9).
   * 모델을 바꾸면 세션이 재스폰되어 uuid가 새로 생기는데, 대화를 버리는 것은
   * 사용자가 동의한 바지만 초안까지 고아가 되는 것은 합의한 적이 없다. 소스
   * 패널 id는 그 재시작을 가로질러 같다. */
  const refineMemoKey = isRefine ? refineMemoStoreKey(props.params) : null;
  /** 이 정리 세션이 기록될 **원본 프로젝트** — `params.project`는 격리 스크래치라
   * 그걸 쓰면 모든 프로젝트의 프롬프트가 정체불명 그룹 하나로 뭉친다. */
  const refineSourceProject = isRefine
    ? ((props.params as { sourceProject?: string | null }).sourceProject ??
      useAppStore.getState().activeProject ??
      null)
    : null;
  // codex 2차 의견 — 적용과 무관한 참고용(하단 접이식).
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexResult, setCodexResult] = useState<string | null>(null);
  const [codexOpen, setCodexOpen] = useState(true);
  // 3뷰 스와톱 — 한 번에 하나만 보이고 나머지는 `display:none`으로 **마운트를
  // 유지한 채** 숨는다(터미널의 PTY가 살아 있어야 한다 — refineViewStyle 참조).
  const [refineView, setRefineView] = useState<RefineView>(DEFAULT_REFINE_VIEW);
  // 메모 본문의 최신값 — [보내기]가 읽는다. state가 아니라 ref인 이유: 타이핑
  // 한 글자마다 이 큰 패널을 다시 그릴 이유가 없다. 버튼의 활성/비활성만
  // 필요하므로 "비었는가"만 state로 따로 둔다.
  const memoTextRef = useRef("");
  const [memoEmpty, setMemoEmpty] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  // 종료가 이미 돌고 있는가 — **동기** 가드. setState는 다음 렌더에나 반영되므로
  // 같은 프레임에 두 경로(× + 동반 닫힘)가 겹치면 아카이브가 두 번 나간다.
  const closingRef = useRef(false);
  // [보내기]의 동기 중복 가드 (리뷰 #6).
  const sendingRef = useRef(false);
  // 제출 확인 타이머 · 최신 턴 수 (리뷰 #8).
  const sendCheckRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turnsCountRef = useRef(0);
  // 메모 저장기의 손잡이 (MemoEditor가 마운트되면 채워진다) — 닫기 전에 저장을
  // 확인하는 유일한 경로.
  const memoHandleRef = useRef<MemoHandle | null>(null);
  // 닫기=아카이브의 진행/실패 상태. 실패하면 패널을 **닫지 않고** 사유를 남긴다.
  const [closing, setClosing] = useState(false);
  const [closeNote, setCloseNote] = useState<{ reason: string; retryable: boolean } | null>(null);

  /** Raw bytes to this session's PTY (driver-gated in the backend).
   *
   * **에러를 삼키지 않는다** — 호출부가 배달 성공을 알아야 하는 경로가 있다
   * (프롬프트 정리 [적용]은 write ACK 뒤에야 정리 세션을 끝낸다, 리뷰 #4). 그냥
   * 쏘고 잊는 자리는 각자 `.catch(() => {})`를 붙인다. */
  const writeToSession = (text: string): Promise<boolean> => {
    const id = sessionIdRef.current;
    if (id == null) return Promise.reject(new Error("세션이 아직 열리지 않았습니다."));
    // 반환값 = **바이트가 실제로 PTY에 들어갔는가**. 이 창이 driver가 아니면
    // 백엔드가 조용히 무시하고 false를 준다(감사 G1) — 성공으로 오인하면 정리
    // 세션이 아무것도 배달되지 않은 채 종료된다.
    return invoke<boolean>("claude_write", {
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
  // 처리에 착수한 요청 id — 리마운트·deps 재평가로 같은 요청을 두 번 쓰지 않게.
  const injectHandledRef = useRef<string | null>(null);
  // 이 세션이 지금 권한/선택 프롬프트에 걸려 있는가. **구독**이라 상태가 풀리면
  // 아래 이펙트가 다시 돌아 보류해 둔 주입이 자동으로 재시도된다(감사 G2).
  const myInjectUuid = props.params.sessionUuid ?? props.params.loadSessionId ?? null;
  const myBlocked = useClaudeStatus((s) =>
    myInjectUuid ? s.entries[myInjectUuid]?.status === "blocked" : false,
  );
  useEffect(() => {
    const req = claudeInjectRequest;
    // 판정은 순수 모듈이 소유한다(테스트가 규칙을 고정). "defer"인 동안 요청은
    // 슬롯에 그대로 남고, 아래 deps가 조건 해소를 다시 물어본다 — 여기서 조용히
    // 소비하면 정리 세션은 닫혔는데 텍스트만 증발한다.
    const decision = injectDeliveryDecision({
      request: req,
      myUuid: myInjectUuid,
      isDriver: isDriverRef.current,
      sessionOpen: sessionIdRef.current != null,
      blocked: myBlocked,
      handledId: injectHandledRef.current,
    });
    if (decision !== "write" || !req) return;
    injectHandledRef.current = req.id;
    void (async () => {
      // 그 사이 요청이 치워지거나 다른 것으로 바뀌었으면 쓰지 않는다.
      if (useAppStore.getState().claudeInjectRequest?.id !== req.id) return;
      let ok = false;
      let reason: string | undefined;
      try {
        // "fill" = 프롬프트 정리 [적용] — 채우기만 하고 제출하지 않는다.
        ok = (await (req.mode === "fill" ? fillInput(req.text) : injectSeed(req.text))) === true;
        if (!ok) reason = "이 창이 세션의 입력 권한을 갖고 있지 않습니다.";
      } catch (e) {
        reason = errText(e);
      }
      const st = useAppStore.getState();
      // 소비는 우리 요청일 때만 (그 사이 다른 요청이 슬롯을 덮었으면 건드리지 않는다).
      if (st.claudeInjectRequest?.id === req.id) st.requestClaudeInject(null);
      st.reportClaudeInjectAck({ id: req.id, ok, reason });
      // 실패는 재시도 여지를 남긴다(같은 id로 새 요청이 오는 경우는 없지만,
      // 이 패널이 그 id를 다시 붙들고 있지 않게 한다).
      if (!ok) injectHandledRef.current = null;
    })();
    // deps 근거:
    // - `isDriver` — 미러인 동안 도착한 요청은 위에서 그냥 반환한다. 없으면 입력
    //   권한을 가져와도 재평가가 없어 텍스트가 조용히 사라진다.
    // - `sessionOpened` — 소스 탭이 언마운트/마운트 중이면 sessionIdRef가 아직
    //   null이라 같은 이유로 반환한다(리뷰 #2).
    // - `myBlocked` — 프롬프트가 해소되면 보류해 둔 주입을 자동 재시도(G2).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeInjectRequest, isDriver, sessionOpened, myBlocked]);

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
      // 메모를 쓰는 중에는 Ctrl+←/→가 **단어 이동**이어야 한다(리뷰 #7). 패널
      // 이동으로 가로채면 롱폼 편집의 기본 조작을 뺏는 셈이고, 정리 패널의 메모
      // 뷰에서는 옮겨 갈 다른 pane도 없다. preventDefault도 하지 않는다 —
      // CodeMirror가 그 키를 그대로 받아야 한다.
      const inEditor = (e.target as HTMLElement | null)?.closest?.(".cm-editor") != null;
      if (!shouldNavPanes({ inEditor, isRefine, view: refineView })) return;
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
    // 정리 패널은 보이는 뷰가 하나뿐이다 — 기억해 둔 영역("term" 기본)으로 보내면
    // 숨은(display:none) 터미널을 향하게 되고, 그런 요소는 포커스를 받지 못해
    // 커서가 아무 데도 없는 상태가 된다(리뷰 #10). 보이는 뷰로 보낸다.
    if (isRefine) {
      focusRefineViewRef.current();
      return;
    }
    focusArea(recallArea(props.api.id) ?? "term");
  };
  // 뷰 전환 이펙트와 restoreFocus가 같은 동작을 쓰도록 하는 손잡이 — 마운트
  // 이펙트(deps [])에서 불리므로 최신 뷰를 ref로 읽는다.
  const focusRefineViewRef = useRef<() => void>(() => {});

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
            // 쏘고 잊는 자리 — writeToSession은 더 이상 에러를 삼키지 않으므로
            // 여기서 명시적으로 흘린다(실패해도 "시드 재주입" 버튼이 남는다).
            void (isRefine ? submitSingleLine(seed) : injectSeed(seed)).catch(() => {});
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
      // 퇴화 크기는 PTY로 내보내지 않는다(백스톱). 어떤 실제 레이아웃도 두 자리
      // 미만 컬럼을 만들지 않는다 — 이 값이 나온다는 건 호스트가 0px로 접혔다는
      // 뜻이고(FitAddon의 `max(2, …)`/`max(1, …)` 하한), 그대로 보내면 claude
      // TUI가 2×1로 실제 리사이즈되어 화면이 파괴된다. 3뷰 스와톱이 뷰를 숨길 때
      // `display:none`만 쓰는 이유가 이것이고(promptRefine.refineViewStyle),
      // 여기는 그 규칙이 어디선가 어긋나도 PTY까지는 못 가게 막는 두 번째 선이다.
      if (term.cols < 10 || term.rows < 3) return;
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
  const applyReqIdRef = useRef<string | null>(null);
  const claudeInjectAcks = useAppStore((s) => s.claudeInjectAcks);
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
        // 닫기=아카이브가 이 세션을 기록할 프로젝트(격리 cwd가 아니다).
        sourceProject: props.params.project ?? useAppStore.getState().activeProject ?? null,
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
    const sourceProject = refineSourceProject;
    const containerApi = props.containerApi;
    const title = ((props.params.title as string) ?? "").replace(/^프롬프트 정리 — /, "") || "세션";
    exitRefine("model-restart");
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
        sourceProject,
      });
    });
  };

  /**
   * [적용]: 최종본을 **원본 세션 입력창에 채우고**(제출 없음) 정리 세션을 끝낸다.
   *
   * 배달 보장은 **at-least-once + 수동 재시도**다. exactly-once(요청 id 원장으로
   * 중복 배달을 막는 설계)를 두 번 시도했고 두 번 다 수명 관리에서 깨졌다 —
   * 선기록 race, 축출된 id의 오삭제, 재시도 이펙트 미재실행. 세 번째로 같은
   * 토대를 다듬는 대신 요구를 다시 봤다: **이 주입은 자동 제출이 없는 "입력창
   * 채우기"라 중복 배달이 파괴적이지 않다.** 두 번 붙으면 사용자가 그걸 보고
   * 지우면 그만이고, 그 대가로 자동 재시도·타임아웃·배달 원장이 전부 사라진다.
   *
   * 그래서 여기엔 타이머가 없다. 요청을 올리고 **자기 id의 ack만** 기다린다:
   * - `ok` → 배달 확인, 정리 세션 종료(패널 제거 → claude_detach).
   * - 실패(쓰기 오류 / driver 아님) → 정리 세션을 **보존**하고 사유 + [다시 적용].
   * - 무소식 → "전달 대기 중"을 그대로 둔다. 자동 조치는 하지 않는다. 원본 탭이
   *   언마운트라 보류 중인 상태가 대부분이고, 그건 그 탭을 활성화하면 풀린다.
   *
   * 남는 중복 가능성은 "실패로 보고됐지만 실제로는 늦게 성공한" 희귀 케이스에서
   * 사용자가 스스로 [다시 적용]을 누를 때뿐이고, 채우기 전용이라 무해하다.
   */
  const applyRefined = () => {
    if (applyReason) {
      setApplyNote(applyReason);
      return;
    }
    const text = refinedPrompt;
    const target = refineTargetUuid;
    if (!text || !target) return;
    // 매 시도는 새 요청이다 — 재시도 id를 재사용하며 dedupe를 노리던 설계는 폐기.
    const req = { id: crypto.randomUUID(), uuid: target, text, mode: "fill" as const };
    setApplyNote(null);
    useAppStore.getState().requestClaudeInject(req);
    // 슬롯을 실제로 잡았을 때만 대기 상태로 — 잡지 못했으면 남의 요청의 결과를
    // 기다리게 된다.
    if (useAppStore.getState().claudeInjectRequest?.id !== req.id) {
      setApplyNote("다른 프롬프트 주입이 먼저 슬롯을 차지했습니다 — 잠시 뒤 다시 시도하세요.");
      return;
    }
    applyReqIdRef.current = req.id;
    setApplyPending(true);
  };

  /**
   * 적용 배달 확인 — **우리 요청 id의 ack만** 신뢰한다(감사 G1).
   *
   * "슬롯이 비면 성공"이라는 추론은 두 곳에서 틀렸었다: `claude_write`는 이 창이
   * driver가 아니면 아무것도 쓰지 않고도 성공을 반환했고(이제 백엔드가 bool로
   * 사실을 준다), 슬롯을 비운 주체가 우리 소비자였다는 보장도 없었다. 이제
   * 소비 패널이 실제 쓰기 결과를 ack로 남기고 여기서 id로 짝짓는다.
   *
   * 타이머는 없다(위 at-least-once 근거). ack가 올 때까지 대기 표시가 유지된다.
   */
  useEffect(() => {
    if (!applyPending) return;
    const myId = applyReqIdRef.current;
    const outcome = resolveApplyAck(myId, claudeInjectAcks);
    if (outcome.kind === "wait") return;
    setApplyPending(false);
    applyReqIdRef.current = null;
    if (myId) useAppStore.getState().clearClaudeInjectAck(myId); // 결과 확인 완료
    if (outcome.kind === "delivered") {
      // 배달 확인 = 이 정리 세션의 **정상 종료**다. 그냥 닫으면 기능이 성공했을
      // 때만 기록이 남지 않는다(리뷰 #1) — 다른 종료 경로와 같은 문을 쓴다.
      exitRefineRef.current("apply-delivered");
      return;
    }
    setApplyNote(
      `원래 세션에 전달하지 못했습니다: ${outcome.reason}\n정리 세션은 그대로 둡니다 — [다시 적용]을 눌러 보세요.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyPending, claudeInjectAcks]);

  // ---- 메모 [보내기] · 닫기=아카이브 -------------------------------------
  const sendReason = isRefine
    ? sendBlockReason({
        text: memoEmpty ? "" : "x",
        sessionOpen: sessionOpened,
        isDriver,
        blocked: myBlocked,
        sending,
      })
    : null;

  /**
   * [보내기]: 메모 **전문**을 정리 세션에 제출한다.
   *
   * 바이트는 두 조각이고 **반드시 따로** 나가야 한다 — 실측 근거와 지연값은
   * `promptRefine.REFINE_SUBMIT_CR_DELAY`가 소유한다(같은 write에 CR을 붙이면
   * 페이스트 본문으로 먹혀 제출되지 않는다). 줄 구조는 그대로 보존된다.
   *
   * 실패는 남긴다: 첫 write가 실패했으면 아무것도 안 들어간 것이고, CR만 실패한
   * 경우엔 본문이 입력창에 채워진 채 남아 사용자가 Enter를 누르면 된다 — 그
   * 차이를 문구로 구분해 준다.
   */
  const sendMemo = async () => {
    // **동기** 가드가 먼저다 — `sending` state는 다음 렌더에나 반영되므로 같은
    // 프레임의 더블클릭은 setSending을 통과해 메모를 두 번 제출한다(리뷰 #6).
    if (sendingRef.current) return;
    if (sendReason) {
      setSendNote(sendReason);
      return;
    }
    const text = memoTextRef.current;
    if (text.trim() === "") return;
    const [paste, cr] = submitPasteBytes(text);
    // 관측 기준선은 **바이트를 쓰기 전에** 잡는다(리뷰 I2). CR 뒤에 잡으면 아주
    // 빠르게 도착한 턴이 이미 기준선에 포함돼, 제출이 성공했는데도 "확인 못 함"
    // 경고가 뜬다.
    const probe = makeSubmitProbe(() => turnsCountRef.current);
    probe.capture();
    sendingRef.current = true;
    setSending(true);
    setSendNote(null);
    try {
      if ((await writeToSession(paste)) !== true) {
        setSendNote("정리 세션에 쓰지 못했습니다 — 이 창이 입력 권한을 갖고 있지 않습니다.");
        return;
      }
      await new Promise((r) => setTimeout(r, REFINE_SUBMIT_CR_DELAY));
      if ((await writeToSession(cr)) !== true) {
        setSendNote("메모는 입력창에 들어갔지만 제출 키를 보내지 못했습니다 — 터미널 뷰에서 Enter를 눌러 주세요.");
        return;
      }
      // 제출은 **타이밍에 기대는 동작**이다(붙여넣기 다음 프레임의 CR). 성공
      // 여부를 눈으로 확인할 길이 없으면 사용자는 보낸 줄 알고 기다린다 — 그래서
      // 전사가 실제로 자랐는지 한 번 확인한다(리뷰 #8). **자동 재전송은 하지
      // 않는다**: 늦게 도착한 제출과 겹치면 같은 프롬프트가 두 번 실행된다.
      if (sendCheckRef.current !== undefined) clearTimeout(sendCheckRef.current);
      sendCheckRef.current = setTimeout(() => {
        sendCheckRef.current = undefined;
        if (probe.observed()) return;
        setSendNote(
          "제출을 확인하지 못했습니다 — 메모는 입력창에 들어가 있을 수 있습니다.\n" +
            "터미널 뷰에서 Enter를 눌러 주세요. (같은 내용을 자동으로 다시 보내지는 않습니다.)",
        );
      }, REFINE_SUBMIT_CONFIRM_MS);
      // 보냈으면 대화를 보는 것이 다음 동작이다.
      setRefineView("term");
    } catch (e) {
      setSendNote(`보내지 못했습니다: ${errText(e)}`);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /**
   * 닫기 = **아카이브**. 정리 세션은 여기서만 아카이브된다(툴바에 버튼이 없다).
   *
   * 순서와 그 이유:
   * 1. 메모를 먼저 디스크로 flush한다 — 동봉할 본문의 단일 출처는 파일이고,
   *    디바운스 창 안이면 마지막 문장이 빠진 채 아카이브된다.
   * 2. 대화가 하나도 없으면(빈 세션) **아카이브하지 않고 그냥 닫는다**. 시드만
   *    보내고 닫는 것이 흔한 경로고, 그걸 실패로 보고하면 소음이다.
   * 3. 성공했을 때만 닫는다. 실패하면 패널을 살려 두고 사유를 남긴다 — 세션은
   *    한 번 닫히면 되돌릴 수 없으므로 조용한 실패가 곧 기록 소실이다.
   */
  const closeWithArchive = async () => {
    if (closingRef.current) return; // 재진입 금지 (동반 닫힘 + × 가 겹칠 수 있다)
    closingRef.current = true;
    setClosing(true);
    setCloseNote(null);
    // 초안 본문의 정본은 **디스크**다. `memoTextRef`는 에디터가 본문을 읽은 뒤에야
    // 채워지는데, 배경 탭의 ×는 패널을 방금 마운트시킨 참이라 아직 빈 문자열일 수
    // 있다 — 그걸로 "메모 없음"을 판정하면 초안이 있는데도 NoTurns에서 조용히
    // 닫힌다(리뷰 #2가 막으려던 바로 그 소실). 읽기 전이면 ref로 폴백한다.
    let memoText: string | null = null;
    try {
      // 메모를 **확실히** 디스크에 올린 뒤에 읽는다. 동봉할 본문의 단일 출처는
      // 파일이므로, 저장이 실패했는데 성공으로 알고 진행하면 편집 **이전** 본문이
      // 아카이브에 들어간다(리뷰 #4 — flushAllMemos는 실패를 삼키고 타임아웃도
      // 정상 resolve라 이 자리에 맞지 않는다).
      if ((await memoHandleRef.current?.flush()) === false) {
        setCloseNote({
          reason:
            "메모를 저장하지 못해 닫지 않았습니다 — 지금 닫으면 마지막 편집이 아카이브에 빠집니다.\n" +
            "메모 뷰의 상태 줄에서 사유를 확인한 뒤 다시 시도하세요.",
          retryable: true,
        });
        return;
      }
      const decision = refineCloseDecision({
        uuid: refineUuid,
        project: refineSourceProject,
      });
      if (decision.kind === "close") {
        props.api.close();
        return;
      }
      const { uuid, project } = decision;
      const memo = refineMemoKey
        ? await invoke<MemoDoc>("refine_memo_read", { key: refineMemoKey })
        : { text: "", hash: null };
      memoText = memo.text;
      const res = await invoke<{ extraction_error?: string | null }>("archive_session", {
        cwd: project,
        uuid,
        kind: "prompt",
        skipExtraction: true,
        summary: memo.text,
        title: (props.params.title as string) ?? "프롬프트 정리",
      });
      // 백엔드가 스킵 경로의 부분 실패를 Err로 올리지만(리뷰 #3), 계약을 프론트에도
      // 남겨 둔다 — "성공했다는 응답"과 "경고가 실린 응답"을 같이 취급하지 않는다.
      if (res.extraction_error) throw new Error(`아카이브 부분 실패: ${res.extraction_error}`);
      // 초안은 이제 아카이브 안의 summary.md가 정본이다 — 스크래치 사본을 남기면
      // 다음 정리 세션에 되살아난다(리뷰 #10). best-effort: 이미 기록은 끝났다.
      if (refineMemoKey) {
        await invoke("refine_memo_delete", { key: refineMemoKey }).catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("mt-archive-updated"));
      props.api.close();
    } catch (e) {
      const memo = memoText ?? memoTextRef.current;
      const verdict = refineCloseFailure(errText(e), memo.trim() === "");
      if (verdict.kind === "close") {
        props.api.close();
        return;
      }
      setCloseNote({ reason: verdict.reason, retryable: verdict.retryable });
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  };
  // 최신 클로저를 다른 이펙트가 붙잡을 수 있는 손잡이. 종료 경로들(동반 닫힘·
  // [적용] 성공)은 마운트 시점의 deps로 등록되므로 함수를 직접 캡처하면 그때의
  // 낡은 상태(메모·uuid·프로젝트)로 아카이브하게 된다.
  const closeWithArchiveRef = useRef(closeWithArchive);
  closeWithArchiveRef.current = closeWithArchive;

  /** 정리 패널의 **유일한 종료 문**. 어떤 사건이 아카이브를 부르는지는 정책 표가
   * 정한다(`promptRefine.refineExitAction`) — 경로마다 판단을 흩뿌리면 그중 하나가
   * 조용히 기록을 건너뛴다(리뷰 #1이 잡은 실결함이 정확히 그것이었다). */
  const exitRefine = (reason: RefineExitReason) => {
    if (refineExitAction(reason) === "archive") void closeWithArchiveRef.current();
    else props.api.close();
  };
  const exitRefineRef = useRef(exitRefine);
  exitRefineRef.current = exitRefine;

  // 탭 ×가 올린 닫기 요청을 여기서 처리한다 — 아카이브 실패를 보여 줄 자리가
  // 패널 안뿐이기 때문이다(탭 헤더는 overflow:hidden이고, 모달은 쓰지 않기로 했다).
  const refineCloseRequest = useClaudeUi((s) => s.refineCloseRequest);
  useEffect(() => {
    if (!isRefine || !refineCloseRequest) return;
    if (refineCloseRequest.panelId !== props.api.id) return;
    useClaudeUi.getState().clearRefineClose();
    exitRefine("tab-close");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refineCloseRequest]);

  // 보이는 뷰로 커서를 옮긴다(+터미널이면 다시 맞춘다). `display:none` 동안
  // fit()은 조기 return했으므로 (NaN 가드) 표시되는 순간 한 번은 필요하다 —
  // ResizeObserver도 곧 때리지만 첫 프레임의 깜빡임을 없앤다.
  focusRefineViewRef.current = () => {
    if (refineView === "term") {
      try {
        fitRef.current?.fit();
      } catch {
        /* 아직 레이아웃 전 */
      }
      termRef.current?.focus();
    } else if (refineView === "memo") {
      // 마운트 직후에는 에디터가 아직 없다(본문을 비동기로 읽는다) — 그때는
      // MemoEditor가 스스로 포커스를 잡으므로 여기서 아무것도 하지 않는 것이 맞다.
      (containerRef.current?.querySelector(".memo-body .cm-content") as HTMLElement | null)?.focus();
    } else {
      (containerRef.current?.querySelector(".timeline-list") as HTMLElement | null)?.focus();
    }
  };
  useEffect(() => {
    if (isRefine) focusRefineViewRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refineView]);

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
  const containerApi = props.containerApi;
  useEffect(() => {
    if (!refineSourceId) return;
    // **마운트 시점에 이미 원본이 없다** = 레이아웃 복원 직후의 유령 패널이다.
    // 여기만 기존 detach-닫기를 유지한다 — 프로젝트 탭을 왕복할 때마다 아카이브가
    // 터지면 기록이 소음으로 찬다(closeEphemeralPanels 무적용과 같은 이유).
    if (!containerApi.getPanel(refineSourceId)) {
      queueMicrotask(() => exitRefineRef.current("source-missing-at-mount"));
      return;
    }
    // 반면 **살아 있던 원본이 사라지는 것**(닫기/삭제·다른 창으로 전송)은 사용자가
    // 이 작업을 끝낸 사건이다 — ×와 같은 문으로 보낸다(리뷰 #1). 최신 클로저를
    // ref로 집는 이유는 이 이펙트가 refineSourceId에만 묶여 있기 때문(그때의 낡은
    // 메모·uuid로 아카이브하면 안 된다).
    const d = containerApi.onDidRemovePanel((p) => {
      if (p.id === refineSourceId) queueMicrotask(() => exitRefineRef.current("source-removed"));
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

  // 툴바(제목 + 컨트롤). 정리 세션에서는 이 줄이 **패널 맨 위**로 올라간다 —
  // 3뷰 중 무엇을 보고 있든 [적용]·[codex 검증]·모델·뷰 전환은 늘 손에 닿아야
  // 하는데, 원래 자리는 터미널 창(뷰 하나)의 안쪽이기 때문이다.
  const paneHead = (
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
                <span className="seg" role="group" aria-label="정리 패널 뷰">
                  {REFINE_VIEWS.map((v) => (
                    <button
                      key={v.id}
                      className={`seg-item${refineView === v.id ? " seg-on" : ""}`}
                      aria-pressed={refineView === v.id}
                      title={
                        v.id === "memo"
                          ? "초안을 길게 쓰는 곳 — 자동 저장되고, 닫을 때 아카이브에 함께 남습니다"
                          : v.id === "timeline"
                            ? "정리 대화의 변경 타임라인"
                            : "정리 세션의 claude 터미널 (숨어 있는 동안에도 계속 돌아갑니다)"
                      }
                      onClick={() => setRefineView(v.id)}
                    >
                      {v.label}
                    </button>
                  ))}
                </span>
                <button
                  className="claudeterm-head-btn"
                  disabled={sendReason !== null}
                  title={sendReason ?? "메모 전문을 정리 세션에 보냅니다 (제출까지)"}
                  onClick={() => void sendMemo()}
                >
                  {sending ? "보내는 중…" : "보내기"}
                </button>
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
                  {applyPending ? "전달 대기 중…" : applyNote ? "다시 적용" : "적용"}
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
                onClick={() =>
                  void (isRefine ? submitSingleLine(lastSeed) : injectSeed(lastSeed)).catch(
                    () => {},
                  )
                }
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
  );

  // 정리 세션의 상태 배너들 — 적용 배달 대기/실패, [보내기] 실패, 닫기(아카이브)
  // 실패. 셋 다 "조용히 넘어가면 사용자가 알 길이 없는" 사건이라 화면에 남는다.
  const refineNotes = !isRefine ? null : (
    <>
      {closeNote && (
        <div className="claudeterm-refine-note" role="alert">
          {closeNote.reason}
          {closeNote.retryable && (
            <button
              className="claudeterm-head-btn"
              disabled={closing}
              title="아카이브를 다시 시도하고, 성공하면 이 패널을 닫습니다"
              onClick={() => void closeWithArchive()}
            >
              {closing ? "아카이브 중…" : "다시 닫기"}
            </button>
          )}
          <button
            className="claudeterm-head-btn"
            title="아카이브 없이 이 정리 세션을 닫습니다 (메모 파일은 남습니다)"
            onClick={() => props.api.close()}
          >
            그래도 닫기
          </button>
          <span className="claudeterm-refine-note-x" title="이 안내 닫기" onClick={() => setCloseNote(null)}>
            ×
          </span>
        </div>
      )}
      {closing && !closeNote && (
        <div className="claudeterm-refine-note" role="status">
          아카이브하는 중입니다 — 끝나면 이 패널이 닫힙니다.
        </div>
      )}
      {sendNote && (
        <div className="claudeterm-refine-note" role="alert">
          {sendNote}
          <span className="claudeterm-refine-note-x" title="닫기" onClick={() => setSendNote(null)}>
            ×
          </span>
        </div>
      )}
      {(applyPending || applyNote) && (
        <div className="claudeterm-refine-note" role="status">
            {applyPending
              ? "전달 대기 중 — 원래 Claude 탭이 열려 있어야 전달됩니다. 그 탭을 활성화해 주세요.\n(전달이 확인되면 이 정리 세션은 자동으로 닫힙니다.)"
              : applyNote}
            <span
              className="claudeterm-refine-note-x"
              title={applyPending ? "전달 대기를 그만둡니다 (이미 보낸 요청은 취소되지 않습니다)" : "닫기"}
              onClick={() => {
                if (applyPending) {
                  // 대기를 접는다. 이미 보낸 요청을 취소하지는 못하므로(그건
                  // exactly-once 설계가 필요했던 지점) 슬롯만 우리 것이면 치운다.
                  const myId = applyReqIdRef.current;
                  const st = useAppStore.getState();
                  if (myId && st.claudeInjectRequest?.id === myId) st.requestClaudeInject(null);
                  applyReqIdRef.current = null;
                  setApplyPending(false);
                }
                setApplyNote(null);
              }}
            >
              ×
            </span>
          </div>
        )}
    </>
  );

  turnsCountRef.current = turns.size;
  // 패널이 사라진 뒤에 확인 배너를 띄우려 들지 않게.
  useEffect(
    () => () => {
      if (sendCheckRef.current !== undefined) clearTimeout(sendCheckRef.current);
    },
    [],
  );

  // 종료 흐름의 단계 — 초안 잠금과 배너가 같은 값을 읽는다(리뷰 I1).
  const closePhase = refineClosePhase({ closing, blocked: closeNote !== null });
  const memoLocked = isRefine && refineMemoLocked(closePhase);

  const codexPane = !isRefine || !(codexBusy || codexResult) ? null : (
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
  );

  /** 터미널 창. 정리 세션에서는 숨은 뷰가 될 수 있고, 그때도 **마운트는 유지**된다
   * (PTY와 대화가 살아 있어야 한다 — 숨기는 방법은 refineViewStyle 단일 출처). */
  const termPane = (
    <div
      className="claudeterm-pane claudeterm-term-pane"
      style={isRefine ? refineViewStyle(refineView, "term") : undefined}
    >
      {!isRefine && paneHead}
      <div className="claudeterm-term" ref={hostRef} />
    </div>
  );

  const viewerPane = (selectedItem || textView) && (
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
  );

  const agentsPane = showAgents && subagents.length > 0 && (
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
  );

  // 타임라인 컬럼. 일반 세션에선 우측 고정폭(접기 가능)이고, 정리 세션에선
  // 3뷰 중 하나라 폭을 다 쓰거나 통째로 숨는다.
  const timelineBlock = (
    <>
      {!isRefine && !timelineCollapsed && (
        <div className="claudeterm-splitter" title="드래그로 크기 조절" onMouseDown={startDragTimeline} />
      )}
      {!isRefine && timelineCollapsed && (
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
        style={
          isRefine
            ? refineViewStyle(refineView, "timeline")
            : timelineCollapsed
              ? { display: "none" }
              : { flex: `0 0 ${timelineWidth}px` }
        }
      >
        {!isRefine && (
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
        )}
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
    </>
  );

  // 일반 세션: 가로 한 줄(터미널 | 상세 | 서브에이전트 | 타임라인) — 기존 그대로.
  if (!isRefine) {
    return (
      <div className="claudeterm" ref={containerRef} onKeyDown={onContainerKey}>
        {termPane}
        {viewerPane}
        {agentsPane}
        {timelineBlock}
      </div>
    );
  }

  // 정리 세션: 세로 스택(툴바 · 배너 · 뷰 하나 · codex 결과). 뷰 셋은 전부
  // 마운트된 채로 `display:none`으로 갈아 끼운다 — 터미널을 숨기려고 크기를
  // 0으로 만들면 PTY가 실제로 2×1로 줄어든다(refineViewStyle).
  return (
    <div className="claudeterm claudeterm-refine" ref={containerRef} onKeyDown={onContainerKey}>
      {paneHead}
      {refineNotes}
      <div className="claudeterm-refine-body">
        <div
          className="claudeterm-pane claudeterm-memo-pane"
          style={refineViewStyle(refineView, "memo")}
        >
          {refineMemoKey ? (
            <MemoEditor
              storeKey={refineMemoKey}
              subtitle="이 정리 세션의 초안 — 닫을 때 아카이브에 함께 남습니다"
              read={(key) => invoke<MemoDoc>("refine_memo_read", { key })}
              write={(key, text, baseHash) =>
                invoke<MemoSaveResult>("refine_memo_write", { key, text, baseHash })
              }
              onText={(t) => {
                memoTextRef.current = t;
                setMemoEmpty(t.trim() === "");
              }}
              onHandle={(h) => {
                memoHandleRef.current = h;
              }}
              readOnly={memoLocked}
              readOnlyNote="닫는 중 — 아카이브에 저장하고 있습니다"
            />
          ) : (
            <div className="memo-err">정리 세션을 식별할 수 없어 메모를 열지 못했습니다</div>
          )}
        </div>
        {termPane}
        {refineView === "timeline" && viewerPane}
        {timelineBlock}
      </div>
      {codexPane}
    </div>
  );
}
