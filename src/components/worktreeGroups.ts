/** One git worktree as the backend reports it (`git worktree list --porcelain`). */
export interface Worktree {
  path: string;
  head: string;
  branch: string;
  is_main: boolean;
}

/** One discovered git root's worktree listing (input: git_roots × git_worktrees). */
export interface RepoWorktrees {
  root: string;
  worktrees: Worktree[];
}

/** One repository's worktrees, keyed by its main working tree path. */
export interface WorktreeGroup {
  mainPath: string;
  worktrees: Worktree[];
}

/**
 * git_roots가 찾은 각 root의 `git worktree list` 결과를 repo 단위 그룹으로
 * 병합한다. 링크드 워크트리 폴더도 root로 잡히지만(gitlink 인식) 그 목록의
 * main(첫 항목) 경로가 같으므로 **mainPath 기준 dedup** — 같은 repo가 root
 * 수만큼 중복 표시되지 않는다. 그룹은 mainPath 사전순, 그룹 안 순서는 git
 * 출력 순서(main 먼저)를 유지한다. 목록이 빈 root(비-repo·오류)는 건너뛴다.
 */
export function groupWorktrees(repos: RepoWorktrees[]): WorktreeGroup[] {
  const byMain = new Map<string, Worktree[]>();
  for (const r of repos) {
    if (r.worktrees.length === 0) continue;
    const main = r.worktrees.find((w) => w.is_main)?.path ?? r.worktrees[0].path;
    if (!byMain.has(main)) byMain.set(main, r.worktrees);
  }
  return [...byMain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mainPath, worktrees]) => ({ mainPath, worktrees }));
}
