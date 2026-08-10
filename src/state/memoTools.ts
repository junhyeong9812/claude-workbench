/**
 * 메모 툴바([저장하기] · [메모 정리])의 **순수 규칙** — 경로 어휘와 모델 기억.
 *
 * UI(`MemoEditor`)에서 떼어 둔 이유는 여기 있는 두 판정이 조용히 틀리면 손해가
 * 크기 때문이다: 경로 정규화가 헐거우면 프로젝트 밖에 파일이 생기고(백엔드
 * `memo_export`의 봉쇄가 마지막 방어선이지, 여기가 첫 번째다), 모델 기억이
 * 어휘를 안 지키면 정리 실행이 CLI 즉사로 끝난다.
 */

import { MODEL_CHOICES } from "./agentOptions";

/** `YYYY-MM-DD` — **로컬 달력** 기준(사용자가 보는 오늘). */
export function isoDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 저장 경로의 기본 제안 — 프로젝트 루트 기준 상대 경로. */
export function defaultMemoPath(now: Date = new Date()): string {
  return `docs/memo-${isoDate(now)}.md`;
}

/**
 * 정리 결과가 원문 대비 이 비율 아래로 줄면 **경고**한다.
 *
 * 정리는 "구조·중복만" 손보는 작업이라 분량이 절반 아래로 떨어지는 것은 정리가
 * 아니라 **절단**의 모양이다(모델이 지시를 놓쳤거나, 구분자를 넘어선 텍스트가
 * 지시로 읽혔거나, 출력이 상한에 걸렸거나). 자동으로 막지는 않는다 — 실제로
 * 중복만 가득한 메모는 정직하게 반 이하로 줄 수 있고, 판단은 미리보기를 보는
 * 사람이 한다. 대신 그 판단을 **하게** 만든다.
 */
export const TIDY_SHRINK_WARN = 0.5;

/** 결과가 원문 대비 급감했는가 (미리보기 경고 배지). */
export function tidyShrank(before: string, after: string): boolean {
  const b = before.trim().length;
  if (b === 0) return false;
  return after.trim().length < b * TIDY_SHRINK_WARN;
}

export type RelPathCheck = { ok: true; rel: string } | { ok: false; reason: string };

/**
 * 입력한 경로를 **프로젝트 루트 기준 상대 경로**로 정규화하거나, 왜 못 쓰는지
 * 말해 준다.
 *
 * 거절 사유를 문자열로 돌려주는 것이 요점이다 — 버튼을 조용히 비활성화하면
 * 사용자는 무엇이 문제인지 모른 채 멈춘다. 통과시키는 것은 최소한으로 좁힌다:
 * 절대 경로·`..`·`~`는 전부 거절하고, 앞의 `./`와 중복 슬래시만 다듬는다.
 */
export function normalizeMemoRel(input: string): RelPathCheck {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "저장할 경로를 입력하세요." };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { ok: false, reason: "프로젝트 루트 기준 상대 경로만 쓸 수 있습니다." };
  }
  if (raw.startsWith("~")) {
    return { ok: false, reason: "홈 경로(~)는 쓸 수 없습니다 — 프로젝트 안 경로를 적으세요." };
  }
  // 앞의 `./`를 걷어내고 빈 조각(중복 슬래시)을 지운다.
  const parts = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) {
    return { ok: false, reason: "'..' 로 프로젝트 밖으로 나갈 수 없습니다." };
  }
  if (parts.length === 0) return { ok: false, reason: "저장할 파일 이름이 없습니다." };
  if (raw.endsWith("/")) return { ok: false, reason: "폴더가 아니라 파일 경로를 적으세요." };
  return { ok: true, rel: parts.join("/") };
}

/**
 * 정리에 쓸 모델의 기본값 — **sonnet**.
 *
 * 세션 옵션(`agentOptions`)의 `""`(미지정)과 다른 선택이다: 저기는 사용자가 쓰던
 * CLI 기본을 존중해야 하는 대화 세션이고, 여기는 한 번 돌고 끝나는 정리 작업이라
 * 비용·속도가 예측 가능한 쪽이 낫다.
 */
export const DEFAULT_TIDY_MODEL = "sonnet";

/** 마지막 선택을 기억하는 키 — agent별 키(`agentOptions:*`)와 같은 선례. */
const TIDY_MODEL_KEY = "memoTidyModel";

/** 기억된 정리 모델 (없거나 어휘 밖이면 기본값). */
export function loadTidyModel(): string {
  try {
    const saved = localStorage.getItem(TIDY_MODEL_KEY);
    return MODEL_CHOICES.some((m) => m === saved) ? saved! : DEFAULT_TIDY_MODEL;
  } catch {
    return DEFAULT_TIDY_MODEL; // 저장소가 막힌 환경 — 기본값으로 계속 동작한다
  }
}

/** 고른 모델을 기억한다 (실패는 무시 — 기억은 편의지 계약이 아니다). */
export function saveTidyModel(model: string): void {
  try {
    localStorage.setItem(TIDY_MODEL_KEY, model);
  } catch {
    /* 저장 실패는 무해 */
  }
}
