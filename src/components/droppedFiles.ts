/** 작업 영역 OS 파일 드롭의 분류·상한 순수 로직 (workarea-drop-view spec §2).
 * UI와 분리해 단위 테스트 가능하게 유지한다. 완전 보기 전용 — 여기서도, 소비
 * 측에서도 디스크에 아무것도 쓰지 않는다. */

/** 파일당 크기 상한 — 기존 peek 뷰어 캡(5MB) 준용. */
export const DROP_MAX_BYTES = 5 * 1024 * 1024;
/** 한 번에 받는 최대 파일 수 — 초과분은 건너뛰고 안내한다(무음 스킵 금지). */
export const DROP_MAX_FILES = 10;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

export type DroppedKind = "text" | "image" | "too-large" | "over-limit";

/** 이름 → 확장자(소문자, 없으면 ""). */
export const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** 드롭된 파일 목록의 처리 계획: 각 파일을 text/image로 분류하고 상한 초과는
 * 사유와 함께 반환한다. 순서는 드롭 순서 보존(첫 파일이 활성 탭). */
export function classifyDrops(
  files: { name: string; size: number }[],
): { name: string; kind: DroppedKind }[] {
  return files.map((f, i) => {
    if (i >= DROP_MAX_FILES) return { name: f.name, kind: "over-limit" as const };
    if (f.size > DROP_MAX_BYTES) return { name: f.name, kind: "too-large" as const };
    return {
      name: f.name,
      kind: IMAGE_EXTS.has(extOf(f.name)) ? ("image" as const) : ("text" as const),
    };
  });
}

/** 엄격 UTF-8 디코드 — 유효하지 않으면 null (리뷰 W1: `File.text()`는 깨진
 * 바이트를 U+FFFD로 치환할 뿐 절대 실패하지 않아, 바이너리가 mojibake로
 * 무음 표시된다. fatal 디코더로 "텍스트 아님"을 실제로 판별). */
export function decodeStrict(buf: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** peek 뷰어 탭 하나로 들어가는 드롭 파일 콘텐츠(메모리 전용). */
export interface DroppedFileView {
  name: string;
  /** 텍스트 계열 — 마크다운/코드 뷰로 표시. */
  text?: string;
  /** 이미지 — data URL로 표시. */
  imageUrl?: string;
}
