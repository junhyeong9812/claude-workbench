/**
 * 프로젝트 메모장 — dock 조작 규칙 + 자동 저장 계약 (순수 모듈).
 *
 * 두 가지 성질이 규칙으로 고정된다:
 *
 * 1. **프로젝트당 1개** — 패널 id가 프로젝트 경로로 결정적이라, 이미 열려 있으면
 *    새로 만들지 않고 그 패널을 활성화한다(타임라인 peek·diff 패널 선례).
 * 2. **일반 탭** — 단발성이 아니다. `ephemeralPanels`의 대상이 **아니므로**
 *    레이아웃 복원으로 되살아난다. 그래야 맞다: 메모는 세션이 아니라 프로젝트에
 *    딸린 문서고, 본문은 디스크에 있어 복원이 곧 이어쓰기다.
 *
 * 자동 저장이 이 모듈에 같이 있는 이유는 **유실 창이 dock 수명과 맞물리기**
 * 때문이다. dockview 패널은 비활성 탭이 되면 언마운트되고(onlyWhenVisible),
 * 그러면 CodeMirror state가 통째로 사라진다. 디바운스 타이머만 있으면 "타이핑 →
 * 곧바로 탭 전환"이 마지막 편집을 삼킨다. 그래서 계약이 세 경로다:
 * **디바운스 저장 + blur 저장 + 언마운트 flush**. {@link makeAutoSaver}가 그
 * 셋을 한 객체로 제공하고, flush는 대기 중인 값이 있을 때만 저장한다(중복 쓰기
 * 없음).
 *
 * **창을 넘는 중복은 허용한다 — 충돌이 안전해졌기 때문이다.** "프로젝트당 1개"의
 * 조회 범위는 이 웹뷰다(`surfaceRegistry`는 창별 싱글턴이라 주·부 두 dock은
 * 덮지만 팝아웃 창은 못 본다 — 타임라인 peek·attention 롤업과 같은 계열). 그래서
 * 메모 탭을 다른 창으로 끌어낸 뒤 메인 창에서 다시 열면 같은 memo.md를 보는
 * 에디터가 둘 생길 수 있다.
 *
 * 예전에는 그게 조용한 데이터 유실이었다(나중에 저장한 쪽이 상대의 문서를 통째로
 * 덮는다). 지금은 저장이 **낙관적 잠금**을 통과해야 하므로(`memo_write`의
 * base_hash — 디스크가 읽은 시점과 다르면 거부) 최악이 "저장이 거부되고 배너가
 * 뜬다"이고, 사용자의 글자는 에디터에 그대로 남는다. 덮어쓸지 다시 읽을지는
 * 사용자가 고른다. 그래서 창 간 이동을 막지 않는다 — 막는 길도 마땅치 않다:
 * peek처럼 단발성으로 분류하면 레이아웃 복원에서도 함께 닫혀 버린다(두 규칙이
 * `ephemeralKindOf` 하나를 공유한다).
 */
import { findPanelById } from "./surfaceRegistry";

/** 메모 패널의 `params.kind` — 패널 종류 판정 키. */
export const MEMO_KIND = "memo";

/** 자동 저장 디바운스(ms). 입력이 멎고 이만큼 지나면 1회 저장. */
export const MEMO_SAVE_DELAY = 1000;

/** 결정적 패널 id — 같은 프로젝트 메모 중복 열기를 id 하나로 막는다. */
export const memoPanelId = (project: string): string => `memo:${project}`;

/** 이 패널 params가 프로젝트 메모인가. */
export function isMemoParams(params: unknown): boolean {
  return (params as { kind?: unknown } | null | undefined)?.kind === MEMO_KIND;
}

/** dock api 중 이 모듈이 쓰는 최소 표면 (실제 인자는 DockviewApi). */
interface MemoablePanel {
  id: string;
  params?: unknown;
  api: { setActive(): void };
}
export interface MemoDock {
  getPanel(id: string): MemoablePanel | undefined;
  addPanel(opts: {
    id: string;
    component: string;
    title: string;
    params: Record<string, unknown>;
  }): unknown;
}

/** 표시용 마지막 경로 조각 (탭 제목). */
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * 이 프로젝트의 메모 패널을 연다 — 이미 있으면(이 dock이든 다른 surface든)
 * 활성화만. 반환값은 어느 쪽이었는지(테스트·호출부 판단용).
 */
export function openProjectMemo(dock: MemoDock, project: string): "focused" | "opened" {
  const id = memoPanelId(project);
  const existing = dock.getPanel(id) ?? findPanelById(id);
  if (existing) {
    existing.api.setActive();
    return "focused";
  }
  const title = `메모 — ${baseName(project)}`;
  dock.addPanel({
    id,
    component: MEMO_KIND,
    title,
    // sessionId를 갖지 않는다 — 패널 제거가 세션 종료 경로를 타지 않는다.
    params: { kind: MEMO_KIND, title, project },
  });
  return "opened";
}

/** 대기 중인 편집을 잃지 않고 저장하는 자동 저장기. */
export interface AutoSaver<T> {
  /** 값이 바뀌었다 — `delay` 후 1회 저장(버스트는 마지막 값 하나로 합쳐진다). */
  schedule(value: T): void;
  /** 대기 중인 값을 **지금** 저장하고 그 저장이 끝날 때까지 기다린다
   * (blur·언마운트·창 종료). 대기 값이 없으면 진행 중인 저장만 기다린다. */
  flush(): Promise<void>;
  /** 대기 중인 저장을 저장하지 않고 버린다 (명시 폐기용). */
  cancel(): void;
  /** 아직 **디스크에 들어가지 못한** 값이 있는가 = dirty. 실패로 남은 것도
   * 포함한다 — 그게 이 플래그의 요점이다. */
  pending(): boolean;
  /** 그 dirty 값 (없으면 undefined). stash·진단용. */
  peek(): T | undefined;
}

/**
 * trailing 디바운스 + flush.
 *
 * `claudeStatus`의 `makeDebouncedScanner`와 모양이 같지만 그걸 쓰지 않는다:
 * 저기엔 타임라인 origin 배치 규칙이 얽혀 있고, 무엇보다 **flush가 없다** —
 * 취소(`cancel`)만 있어서 언마운트 시 마지막 편집이 버려진다. 저장기에 필요한
 * 것은 정확히 그 반대(버리지 말고 지금 쓰기)라 순수 함수로 새로 둔다.
 *
 * 불변식:
 * - **성공했을 때만** 대기 값이 비워진다 (리뷰 P2-2). `save`가 reject하면 값은
 *   dirty로 남아 다음 flush·편집이 다시 시도한다 — "저장 요청을 보냈다"를
 *   "저장됐다"로 세던 것이 무음 유실의 통로였다.
 * - 저장 중 더 새 편집이 들어오면 그 값은 dirty로 남는다 (seq로 판정) — 늦게
 *   도착한 성공 응답이 새 편집을 clean으로 지워 버리지 않는다.
 * - 저장은 **직렬화**된다 — 같은 파일에 동시 쓰기를 걸지 않는다.
 * - flush는 타이머도 함께 끈다 → flush 뒤 시간이 흘러도 중복 저장이 없다.
 * - 대기 값이 없을 때의 flush는 저장을 부르지 않는다 → 언마운트마다 빈 쓰기가
 *   생기지 않는다.
 *
 * `save`는 **동기적으로** 호출된다(마이크로태스크를 거치지 않는다) — 언마운트
 * 같은 동기 경로에서 IPC가 실제로 출발하는 것이 유실 방어의 전제다.
 */
export function makeAutoSaver<T>(save: (value: T) => Promise<void>, delay: number): AutoSaver<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 대기 값은 박스로 감싼다 — T가 ""·null·0일 수 있어 값 자체로는 "대기 없음"을
  // 표현할 수 없다(빈 메모 저장이 조용히 누락되는 실패 모드).
  let box: { value: T; seq: number } | null = null;
  let seq = 0;
  let inflight = false;
  let settled: Promise<void> = Promise.resolve();

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const runOnce = (): Promise<void> => {
    const b = box;
    if (!b || inflight) return settled;
    inflight = true;
    settled = save(b.value).then(
      () => {
        // 저장 중 더 새 편집이 없었을 때만 clean 처리.
        if (box && box.seq === b.seq) box = null;
        inflight = false;
      },
      () => {
        // 실패 — dirty 유지. 호출부가 사유를 표시하고, 다음 flush가 재시도한다.
        inflight = false;
      },
    );
    return settled;
  };

  const flush = (): Promise<void> => {
    clear();
    if (!box) return settled;
    // 진행 중인 저장이 있으면 끝난 뒤 한 번 더 — 그 사이 쌓인 값도 나간다.
    if (inflight) return settled.then(() => flush());
    return runOnce();
  };

  return {
    schedule(value: T) {
      box = { value, seq: ++seq };
      clear();
      timer = setTimeout(() => void runOnce(), delay);
    },
    flush,
    cancel() {
      clear();
      box = null;
    },
    pending: () => box !== null,
    peek: () => box?.value,
  };
}

// ---- 저장 못 한 편집의 임시 보관 (리뷰 P2-2) -------------------------------

/**
 * 언마운트 순간의 저장이 실패하면 그 본문은 갈 곳이 없다 — 에디터는 이미
 * 사라졌고 디스크에는 안 들어갔다. 그 값을 웹뷰 메모리에 붙들어 뒀다가 다음
 * 마운트에서 되살린다(무음 유실 0).
 *
 * 창 수명을 넘지는 못한다(메모리다). 그건 한계가 아니라 범위다: 앱이 죽으면
 * 어차피 그 값을 들고 있던 것이 아무것도 없다. 이 stash가 막는 것은 훨씬 흔한
 * 쪽 — **탭을 전환했다가 돌아오는 사이의 저장 실패**다.
 */
const stash = new Map<string, string>();

export function stashMemo(project: string, text: string): void {
  stash.set(project, text);
}

/** 보관된 값을 꺼내며 지운다 (없으면 undefined). */
export function takeStash(project: string): string | undefined {
  const v = stash.get(project);
  stash.delete(project);
  return v;
}

export function clearStash(project: string): void {
  stash.delete(project);
}

/** 테스트 격리용 — 보관함을 비운다. */
export function resetStash(): void {
  stash.clear();
  undo.clear();
}

// ---- 정리 [적용]의 되돌리기 버퍼 (리뷰 W1) ---------------------------------

/**
 * AI 정리를 [적용]하기 **직전의 본문**. 키는 `undo:<storeKey>`.
 *
 * 컴포넌트 state가 아니라 모듈 맵인 이유는 stash와 같다 — dockview는 비활성 탭의
 * 패널을 언마운트하므로, state에 들고 있으면 **탭을 한 번 전환하는 순간 되돌릴
 * 길이 사라진다**. 정리 적용은 사용자의 글을 통째로 갈아 끼운 직후라 그 창이 가장
 * 좁아서는 안 되는 자리다.
 *
 * 창 수명을 넘지 않는 것은 의도다(앱 재시작 = 소멸): 되돌리기는 방금 한 조작에
 * 대한 취소지, 어제 적용한 정리까지 되돌리는 히스토리가 아니다.
 *
 * **만료**도 같은 이유로 필요하다 — 적용 후 사용자가 계속 쓴 뒤에 [되돌리기]가
 * 눌리면 옛 본문이 그 작업을 통째로 지운다. 그래서 호출부는 적용 이후 **첫 일반
 * 편집**에서 이 버퍼를 버린다.
 */
const undo = new Map<string, UndoEntry>();

/**
 * 되돌리기 한 칸 — 직전 본문과 **그때 적용한 본문**.
 *
 * `applied`를 함께 들고 있는 것이 요점이다: 되살아난 버퍼를 쓰기 전에 "지금
 * 화면의 본문이 정말 그 적용의 결과인가"를 물어야 한다. 그 사이 다른 창이나
 * 디스크가 문서를 바꿨다면 `before`는 더 이상 "직전"이 아니라 **남의 수정을
 * 통째로 지우는 값**이다.
 */
export interface UndoEntry {
  before: string;
  applied: string;
}

const undoKey = (storeKey: string): string => `undo:${storeKey}`;

export function setUndo(storeKey: string, before: string, applied: string): void {
  undo.set(undoKey(storeKey), { before, applied });
}

/** 보관된 한 칸 (없으면 null — 되돌릴 것이 없다). */
export function getUndo(storeKey: string): UndoEntry | null {
  return undo.get(undoKey(storeKey)) ?? null;
}

export function clearUndo(storeKey: string): void {
  undo.delete(undoKey(storeKey));
}

// ---- 창 종료 시 일괄 flush (리뷰 P1) ---------------------------------------

/**
 * 창을 닫을 때 쓸 수 있는 시간의 상한(ms).
 *
 * 메인 창 닫기 경로의 예산에서 역산한 값이다: watchdog이 4000ms 뒤 강제
 * `destroy()`를 걸고, 그 앞에 팝아웃 ack 대기가 최대 2500ms 있다. 1200 + 2500 =
 * 3700 < 4000 이라 메모 flush를 앞에 끼워도 기존 종료 보증을 잠식하지 않는다.
 * 여기를 늘리려면 watchdog부터 같이 봐야 한다.
 */
export const MEMO_CLOSE_FLUSH_MS = 1200;

/** 이 창에 살아 있는 메모 저장기들. 창 종료는 React cleanup을 거치지 않으므로
 * (`win.destroy()`가 언마운트를 보장하지 않는다) 닫기 경로가 직접 붙잡을 수
 * 있는 손잡이가 필요하다. */
const activeSavers = new Set<{ flush(): Promise<void> }>();

/** 저장기를 등록하고 해제 함수를 돌려준다 (패널 언마운트에서 호출). */
export function registerMemoSaver(saver: { flush(): Promise<void> }): () => void {
  activeSavers.add(saver);
  return () => {
    activeSavers.delete(saver);
  };
}

/**
 * 이 창의 모든 메모를 flush하고 완료를 기다린다 — 단, `timeoutMs`까지만.
 *
 * 상한이 있는 이유는 닫기가 **반드시** 진행돼야 하기 때문이다. 저장이 걸리면
 * 메모 한 줄 때문에 앱이 안 닫히는 쪽이 더 나쁜 실패다. 시간 안에 못 끝낸 값은
 * stash에 남아 다음 실행이 아니라 이번 창의 다음 마운트에서 복구된다(그마저
 * 못 하면 그때는 프로세스가 사라진 뒤라 어차피 붙들 것이 없다).
 *
 * 개별 flush의 실패는 삼킨다 — 하나가 거부돼도 나머지는 저장돼야 한다.
 */
export function flushAllMemos(timeoutMs: number = MEMO_CLOSE_FLUSH_MS): Promise<void> {
  const all = [...activeSavers].map((s) => s.flush().catch(() => {}));
  if (all.length === 0) return Promise.resolve();
  return Promise.race([
    Promise.all(all).then(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** 테스트 격리용 — 등록된 저장기를 모두 잊는다. */
export function resetMemoSavers(): void {
  activeSavers.clear();
}
