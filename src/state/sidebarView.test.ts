import { beforeEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_TABS,
  applyActivityPick,
  applyTabPick,
  ctrlBAction,
  loadSidebarView,
  mountedTabs,
  normalizeSidebarView,
  saveSidebarView,
  toggleSplit,
  type SidebarTab,
  type SidebarView,
} from "./sidebarView";

const view = (v: Partial<SidebarView> = {}): SidebarView => ({ ...SIDEBAR_DEFAULT, ...v });

describe("normalizeSidebarView", () => {
  it("keeps a state whose halves already differ", () => {
    const v = view({ split: true, topTab: "git", bottomTab: "graph" });
    expect(normalizeSidebarView(v)).toEqual(v);
  });

  it("repairs same-tab-both-halves by moving the bottom half (불변식 §2)", () => {
    // 손계산: top=git 고정, bottom은 목록 첫 비-git 탭 = files.
    expect(normalizeSidebarView(view({ split: true, topTab: "git", bottomTab: "git" }))).toEqual(
      view({ split: true, topTab: "git", bottomTab: "files" }),
    );
    // top=files → bottom은 목록 첫 비-files 탭 = git.
    expect(
      normalizeSidebarView(view({ split: true, topTab: "files", bottomTab: "files" })),
    ).toEqual(view({ split: true, topTab: "files", bottomTab: "git" }));
  });

  it("repairs the violation even while split is off (복원 경로 포함 전 진입점)", () => {
    const out = normalizeSidebarView(view({ split: false, topTab: "graph", bottomTab: "graph" }));
    expect(out.topTab).toBe("graph");
    expect(out.bottomTab).not.toBe("graph");
  });
});

describe("applyTabPick", () => {
  it("replaces the half's tab when the other half is free", () => {
    const out = applyTabPick(view({ split: true, topTab: "files", bottomTab: "git" }), "bottom", "graph");
    expect(out).toEqual(view({ split: true, topTab: "files", bottomTab: "graph" }));
  });

  it("swaps both halves when the picked tab already lives in the other half", () => {
    // 손계산: 아래에서 files(=위쪽 탭) 선택 → 위=git, 아래=files.
    const out = applyTabPick(view({ split: true, topTab: "files", bottomTab: "git" }), "bottom", "files");
    expect(out).toEqual(view({ split: true, topTab: "git", bottomTab: "files" }));
    // 대칭: 위에서 git(=아래쪽 탭) 선택 → 위=git, 아래=files.
    const back = applyTabPick(out, "top", "git");
    expect(back).toEqual(view({ split: true, topTab: "git", bottomTab: "files" }));
  });

  it("is a no-op when the half already shows that tab", () => {
    const v = view({ split: true, topTab: "archive", bottomTab: "worktree" });
    expect(applyTabPick(v, "top", "archive")).toBe(v);
  });

  it("never produces the same tab in both halves — exhaustive over every pick", () => {
    for (const top of SIDEBAR_TABS) {
      for (const bottom of SIDEBAR_TABS) {
        for (const half of ["top", "bottom"] as const) {
          for (const pick of SIDEBAR_TABS) {
            const start = normalizeSidebarView(view({ split: true, topTab: top, bottomTab: bottom }));
            const out = applyTabPick(start, half, pick);
            expect(out.topTab).not.toBe(out.bottomTab);
            // 선택한 탭은 반드시 그 반쪽에 놓인다.
            expect(half === "top" ? out.topTab : out.bottomTab).toBe(pick);
            expect(mountedTabs(out)).toHaveLength(new Set(mountedTabs(out)).size);
          }
        }
      }
    }
  });
});

describe("applyActivityPick", () => {
  it("sets the single tab while split is off (기존 동작 보존)", () => {
    expect(applyActivityPick(view({ split: false, tab: "files" }), "archive")).toEqual(
      view({ split: false, tab: "archive" }),
    );
  });

  it("drives the TOP half (with the swap rule) while split is on", () => {
    const v = view({ split: true, topTab: "files", bottomTab: "git" });
    // 자유 탭 → 위쪽만 교체.
    expect(applyActivityPick(v, "graph")).toEqual(view({ split: true, topTab: "graph", bottomTab: "git" }));
    // 아래쪽 탭 선택 → 스왑.
    expect(applyActivityPick(v, "git")).toEqual(view({ split: true, topTab: "git", bottomTab: "files" }));
  });

  it("leaves the single tab untouched when split is on (분할 OFF 복귀용 보존)", () => {
    const out = applyActivityPick(view({ split: true, tab: "files", topTab: "files", bottomTab: "git" }), "graph");
    expect(out.tab).toBe("files");
  });
});

describe("toggleSplit", () => {
  it("carries the single tab onto the top half when turning split on", () => {
    const out = toggleSplit(view({ split: false, tab: "archive", topTab: "files", bottomTab: "git" }));
    expect(out.split).toBe(true);
    expect(out.topTab).toBe("archive");
    expect(out.bottomTab).toBe("git");
  });

  it("normalizes a collision produced by that carry-over", () => {
    // tab=git가 위로 올라오면 아래(git)와 충돌 → 아래가 비켜난다.
    const out = toggleSplit(view({ split: false, tab: "git", topTab: "files", bottomTab: "git" }));
    expect(out.topTab).toBe("git");
    expect(out.bottomTab).toBe("files");
  });

  it("returns the top half's tab to the single view when turning split off", () => {
    const out = toggleSplit(view({ split: true, tab: "files", topTab: "graph", bottomTab: "git" }));
    expect(out.split).toBe(false);
    expect(out.tab).toBe("graph");
    // 반쪽 상태는 보존 — 다시 켜면 그대로 돌아온다.
    expect(out.topTab).toBe("graph");
    expect(out.bottomTab).toBe("git");
  });
});

describe("mountedTabs", () => {
  it("lists one tab while split is off", () => {
    expect(mountedTabs(view({ split: false, tab: "git" }))).toEqual(["git"]);
  });

  it("lists both halves, top first, while split is on", () => {
    expect(mountedTabs(view({ split: true, topTab: "graph", bottomTab: "files" }))).toEqual([
      "graph",
      "files",
    ]);
  });
});

describe("loadSidebarView", () => {
  beforeEach(() => localStorage.clear());

  it("returns the default when nothing is stored", () => {
    expect(loadSidebarView()).toEqual(SIDEBAR_DEFAULT);
  });

  it("returns the default for corrupt / non-object JSON", () => {
    localStorage.setItem("sidebarView", "{not json");
    expect(loadSidebarView()).toEqual(SIDEBAR_DEFAULT);
    localStorage.setItem("sidebarView", '"files"');
    expect(loadSidebarView()).toEqual(SIDEBAR_DEFAULT);
    localStorage.setItem("sidebarView", "null");
    expect(loadSidebarView()).toEqual(SIDEBAR_DEFAULT);
  });

  it("falls back per field for unknown tab names / wrong types", () => {
    localStorage.setItem(
      "sidebarView",
      JSON.stringify({ split: "yes", tab: "nope", topTab: 3, bottomTab: "graph" }),
    );
    expect(loadSidebarView()).toEqual(view({ split: false, tab: "files", topTab: "files", bottomTab: "graph" }));
  });

  it("normalizes a persisted same-tab-both-halves state (복원 경로 불변식)", () => {
    localStorage.setItem(
      "sidebarView",
      JSON.stringify({ split: true, tab: "graph", topTab: "graph", bottomTab: "graph" }),
    );
    const out = loadSidebarView();
    expect(out.topTab).toBe("graph");
    expect(out.bottomTab).not.toBe("graph");
    expect(mountedTabs(out)).toHaveLength(2);
  });

  it("round-trips a saved view", () => {
    const v = view({ split: true, tab: "archive", topTab: "archive", bottomTab: "worktree" });
    saveSidebarView(v);
    expect(loadSidebarView()).toEqual(v);
  });

  it("survives a localStorage that throws (private mode / quota)", () => {
    const orig = Object.getOwnPropertyDescriptor(Storage.prototype, "getItem")!;
    Object.defineProperty(Storage.prototype, "getItem", {
      configurable: true,
      value: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(loadSidebarView()).toEqual(SIDEBAR_DEFAULT);
    } finally {
      Object.defineProperty(Storage.prototype, "getItem", orig);
    }
  });
});

describe("ctrlBAction", () => {
  it("expands a collapsed sidebar and focuses the tree when one is mounted", () => {
    expect(ctrlBAction(true, false)).toEqual({ kind: "expand", focusTree: true });
  });

  it("collapses an expanded sidebar regardless of which tab is showing (결함 ① 해소)", () => {
    // 트리가 없는 탭(git 등)에서도 무동작이 아니라 접힌다.
    expect(ctrlBAction(false, false)).toEqual({ kind: "collapse", restoreFocus: false });
  });

  it("restores the last work spot when collapsing away from focus inside the sidebar", () => {
    expect(ctrlBAction(false, true)).toEqual({ kind: "collapse", restoreFocus: true });
  });

  it("ignores focus location while expanding", () => {
    expect(ctrlBAction(true, true)).toEqual({ kind: "expand", focusTree: true });
  });
});

describe("SIDEBAR_TABS", () => {
  it("covers the five activity-bar tabs", () => {
    const expected: SidebarTab[] = ["files", "git", "worktree", "archive", "graph"];
    expect([...SIDEBAR_TABS]).toEqual(expected);
  });

  it("ships a default that already satisfies the invariant", () => {
    expect(SIDEBAR_DEFAULT.topTab).not.toBe(SIDEBAR_DEFAULT.bottomTab);
  });
});
