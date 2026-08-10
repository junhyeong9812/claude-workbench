/**
 * 트리 "새 파일 / 새 폴더" 입력 파싱 — 순수 함수 (파일 탭·스터디·개발 트리 공용).
 *
 * 두 가지를 한다:
 *  1. `normalizeRel` — 타이핑된 상대 경로 정리(빈/`.`/`..` 세그먼트 거부).
 *  2. `expandBraces` — brace 다중 생성(`{a,b}.ts` · `x.{ts,tsx}` · `p/{a,b}.go`).
 *
 * brace 계약(의도적으로 좁다 — 셸 호환이 목적이 아니라 오타로 대량 파일이
 * 생기는 사고를 막는 것이 목적):
 *  - **1단계만**: 중첩 `{}`는 거부(파싱 모호성·폭발 차단).
 *  - 형제 그룹은 교차곱(`{a,b}.{ts,tsx}` = 4개) — 총 개수 상한 `BRACE_MAX`.
 *  - 빈 항목(`{a,}`·`{}`)·중복 결과(`{a,a}.ts`)·그룹 안 경로 구분자는 거부.
 *  - **이스케이프는 지원하지 않는다**: `\{`는 리터럴 `\` + 그룹 시작으로 읽힌다
 *    (지원하는 척하다 조용히 다른 파일을 만드는 것보다 오류가 낫다).
 */

/** 한 번의 "새 파일"로 만들 수 있는 최대 개수 (백엔드 `create_files`도 같은 상한). */
export const BRACE_MAX = 20;

/** 확장 결과 — 실패는 사용자에게 그대로 보여줄 한국어 사유. */
export type ExpandResult = { ok: true; names: string[] } | { ok: false; error: string };

/**
 * 타이핑된 상대 경로 정리: 빈/공백 세그먼트를 버리고 `.`/`..`가 섞이면 무효("").
 * `.` / `/` / `...` 같은 입력이 조용한 no-op 생성으로 새지 않게 하는 게 목적.
 * (파일 탭 트리의 기존 구현을 그대로 옮긴 것 — 동작 문자 단위 동일.)
 */
export function normalizeRel(s: string): string {
  const segs = s
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
  if (segs.length === 0 || segs.some((x) => x === "." || x === "..")) return "";
  return segs.join("/");
}

/** brace 확장. 그룹이 없으면 입력 자신 하나를 돌려준다(= 기존 단일 생성 경로). */
export function expandBraces(raw: string): ExpandResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: "이름을 입력하세요" };

  // 리터럴 조각과 {..} 그룹을 등장 순서대로 모은다 (1단계 스캔 — 중첩 없음).
  const parts: (string | string[])[] = [];
  let lit = "";
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === "}") return { ok: false, error: "중괄호 짝이 맞지 않습니다" };
    if (c !== "{") {
      lit += c;
      i += 1;
      continue;
    }
    const end = input.indexOf("}", i + 1);
    if (end === -1) return { ok: false, error: "중괄호 짝이 맞지 않습니다" };
    const body = input.slice(i + 1, end);
    if (body.includes("{")) return { ok: false, error: "중첩 중괄호는 지원하지 않습니다" };
    const items = body.split(",").map((x) => x.trim());
    if (items.some((x) => x === "")) return { ok: false, error: "중괄호 안에 빈 항목이 있습니다" };
    if (items.some((x) => /[\\/]/.test(x))) {
      return { ok: false, error: "중괄호 안에는 경로 구분자(/ \\)를 쓸 수 없습니다" };
    }
    if (lit) {
      parts.push(lit);
      lit = "";
    }
    parts.push(items);
    i = end + 1;
  }
  if (lit) parts.push(lit);

  // 개수는 **조합을 만들기 전에** 센다 — 상한 초과 입력이 메모리를 먼저 먹지
  // 못하게(폭발 차단).
  const total = parts.reduce<number>((n, p) => (typeof p === "string" ? n : n * p.length), 1);
  if (total > BRACE_MAX) {
    return { ok: false, error: `한 번에 최대 ${BRACE_MAX}개까지 만들 수 있습니다 (요청 ${total}개)` };
  }

  let names: string[] = [""];
  for (const p of parts) {
    names =
      typeof p === "string" ? names.map((n) => n + p) : names.flatMap((n) => p.map((it) => n + it));
  }
  // 중복은 "만들다 만" 상태의 원인이라 생성 전에 막는다 (부분 생성 금지).
  const dup = names.find((n, idx) => names.indexOf(n) !== idx);
  if (dup !== undefined) return { ok: false, error: `중복된 이름이 있습니다: ${dup}` };
  return { ok: true, names };
}

/** "새 파일" 입력 → 만들 절대 경로 목록 (brace 확장 + 세그먼트 정규화). */
export function planNewFiles(
  input: string,
  dir: string,
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const ex = expandBraces(input);
  if (!ex.ok) return ex;
  const paths: string[] = [];
  for (const n of ex.names) {
    const rel = normalizeRel(n);
    if (!rel) return { ok: false, error: "올바른 파일명을 입력하세요" };
    paths.push(`${dir}/${rel}`);
  }
  return { ok: true, paths };
}
