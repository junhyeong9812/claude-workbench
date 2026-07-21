/** 파일트리 DnD의 순수 판정 로직 — 드롭 대상 해석과 금지 가드. UI(FolderTree)
 * 와 분리해 단위 테스트 가능하게 유지한다. */

/** 트리 DnD 전용 dataTransfer mime — 프로젝트 탭 드래그(text/plain)·dockview
 * 탭 드래그가 트리 드래그를 오인하지 않도록 격리한다. */
export const TREE_DND_MIME = "application/x-mt-tree-path";

/** 드래그 payload: 원본 경로 + 폴더 여부. */
export interface TreeDragPayload {
  path: string;
  isDir: boolean;
}

/** 부모 디렉토리 (루트 직속은 "/"). */
export const parentDir = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};

/** 경로의 마지막 이름. */
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** 드롭 대상 폴더 해석: 폴더 행 → 그 폴더, 파일 행 → 그 부모, 빈 영역(row
 * null) → 프로젝트 루트. */
export function resolveDropDir(
  row: { path: string; is_dir: boolean } | null,
  root: string,
): string {
  if (!row) return root;
  return row.is_dir ? row.path : parentDir(row.path);
}

/** 이동/복사 금지 판정 — 허용이면 null, 금지면 사유 문자열.
 * - 자기 자신 폴더 위 드롭 = 그 폴더 "안"으로의 이동인데 원본과 동일 → 금지.
 * - 폴더를 자기 하위로 → 무한 중첩/자기복제 금지.
 * - 같은 부모로 → dest가 원본 자신이 된다: 이동은 no-op, 복사는 "덮어쓰기
 *   확인 → 원본 삭제 → 사라진 원본 복사"의 파괴 시나리오라 둘 다 금지. */
export function dropDisallowed(src: TreeDragPayload, destDir: string): string | null {
  if (!src.path || !destDir) return "잘못된 드롭입니다";
  if (src.path === destDir) return "자기 자신 위로는 놓을 수 없습니다";
  if (src.isDir && destDir.startsWith(src.path + "/")) {
    return "자기 하위 폴더로는 이동/복사할 수 없습니다";
  }
  if (parentDir(src.path) === destDir) return "이미 같은 폴더에 있습니다";
  return null;
}

/** payload 직렬화/파싱 — 파싱 실패는 null(다른 출처의 드래그). */
export const encodePayload = (p: TreeDragPayload): string => JSON.stringify(p);
export function decodePayload(raw: string): TreeDragPayload | null {
  try {
    const v = JSON.parse(raw) as TreeDragPayload;
    if (typeof v?.path === "string" && v.path && typeof v?.isDir === "boolean") return v;
    return null;
  } catch {
    return null;
  }
}
