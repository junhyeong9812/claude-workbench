/**
 * 메모 툴바([저장하기])의 **순수 규칙** — 저장 경로 어휘.
 *
 * UI(`MemoEditor`)에서 떼어 둔 이유는 이 판정이 조용히 틀리면 손해가 크기
 * 때문이다: 경로 정규화가 헐거우면 프로젝트 밖에 파일이 생긴다(백엔드
 * `memo_export`의 봉쇄가 마지막 방어선이지, 여기가 첫 번째다).
 */

/** `YYYY-MM-DD` — **로컬 달력** 기준(사용자가 보는 오늘). */
export function isoDate(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 저장 경로의 기본 제안 — 프로젝트 루트 기준 상대 경로. */
export function defaultMemoPath(now: Date = new Date()): string {
  return `docs/memo-${isoDate(now)}.md`;
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
