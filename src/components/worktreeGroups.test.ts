import { describe, expect, it } from "vitest";
import { groupWorktrees, type Worktree } from "./worktreeGroups";

const wt = (path: string, branch: string, is_main = false): Worktree => ({
  path,
  head: "abc123",
  branch,
  is_main,
});

// squatting-project 실측 구조 축소판: 모음 폴더 아래 repo 2개 + 링크드
// 워크트리 폴더들이 전부 git root로 잡히는 입력.
const WAS = [
  wt("/m/was-server", "develop", true),
  wt("/m/was-authz-guard-wt", "feature/authz"),
  wt("/m/was-usr-alrt-wt", "feature/usr-alrt"),
];
const FRONT = [wt("/m/front-server", "develop", true), wt("/m/front-feature-wt", "feature/damage")];

describe("groupWorktrees", () => {
  it("repo별 그룹핑 + 링크드 워크트리 root 중복 제거", () => {
    const groups = groupWorktrees([
      { root: "/m/front-server", worktrees: FRONT },
      { root: "/m/was-server", worktrees: WAS },
      // 링크드 워크트리 폴더도 root로 잡힘 — 같은 repo의 목록을 반환한다.
      { root: "/m/was-authz-guard-wt", worktrees: WAS },
      { root: "/m/was-usr-alrt-wt", worktrees: WAS },
      { root: "/m/front-feature-wt", worktrees: FRONT },
    ]);
    expect(groups.map((g) => g.mainPath)).toEqual(["/m/front-server", "/m/was-server"]);
    expect(groups[1].worktrees).toHaveLength(3);
    expect(groups[0].worktrees).toHaveLength(2);
    // 그룹 안 순서 = git 출력 순서(main 먼저).
    expect(groups[1].worktrees[0].is_main).toBe(true);
  });

  it("단일 repo면 그룹 1개 — 기존 동작 보존", () => {
    const groups = groupWorktrees([{ root: "/p", worktrees: WAS }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].worktrees).toBe(WAS);
  });

  it("빈 목록 root(비-repo·오류)는 무시", () => {
    expect(groupWorktrees([{ root: "/junk", worktrees: [] }])).toEqual([]);
  });

  it("is_main이 없는 비정형 목록은 첫 항목을 main으로 간주", () => {
    const odd = [wt("/x/a", "dev"), wt("/x/b", "f")];
    const groups = groupWorktrees([
      { root: "/x/a", worktrees: odd },
      { root: "/x/b", worktrees: odd },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].mainPath).toBe("/x/a");
  });
});
