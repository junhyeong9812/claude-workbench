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
  /** 대기 중인 값을 **지금** 저장한다 (blur·언마운트). 없으면 no-op. */
  flush(): void;
  /** 대기 중인 저장을 저장하지 않고 버린다 (명시 폐기용). */
  cancel(): void;
  /** 아직 저장되지 않은 값이 있는가 (테스트·상태 표시). */
  pending(): boolean;
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
 * - flush/저장 실행 후 대기 값은 비워진다 → 같은 값이 두 번 쓰이지 않는다.
 * - flush는 타이머도 함께 끈다 → flush 뒤 시간이 흘러도 재저장이 없다.
 * - 대기 값이 없을 때의 flush는 no-op → 언마운트마다 빈 쓰기가 생기지 않는다.
 */
export function makeAutoSaver<T>(save: (value: T) => void, delay: number): AutoSaver<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 대기 값은 박스로 감싼다 — T가 ""·null·0일 수 있어 값 자체로는 "대기 없음"을
  // 표현할 수 없다(빈 메모 저장이 조용히 누락되는 실패 모드).
  let box: { value: T } | null = null;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const fire = () => {
    clear();
    const b = box;
    if (!b) return;
    box = null;
    save(b.value);
  };
  return {
    schedule(value: T) {
      box = { value };
      clear();
      timer = setTimeout(fire, delay);
    },
    flush: fire,
    cancel() {
      clear();
      box = null;
    },
    pending: () => box !== null,
  };
}
