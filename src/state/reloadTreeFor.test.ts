/**
 * store.reloadTreeFor 표면-스코프 계약 (멀티프로젝트 P5 — 2인스턴스 폴 격리).
 *
 * 각 표면의 FolderTree가 **자기 프로젝트** 트리만 리로드해야 한다 — 예전
 * reloadActiveTree는 전역 activeProject를 재로드해, 부 표면 트리의 4s 인터벌이
 * 주 프로젝트를 리로드하는 2인스턴스 버그가 있었다. 이 테스트는:
 *  ① reloadTreeFor(project)가 그 project의 root+expanded만 read_dir 한다(전역 아님)
 *  ② null이면 no-op
 * 를 고정한다. (활성 표면만 폴하는 인터벌 게이트는 FolderTree pollActive.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const readDirCalls: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { path?: string }) => {
    if (cmd === "read_dir" && args?.path) readDirCalls.push(args.path);
    return Promise.resolve([]);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

import { useAppStore } from "./store";

const mkProject = (path: string, expanded: string[]) => ({
  path,
  name: path.split("/").pop() ?? path,
  tree_state: { expanded },
  layout: null,
});

describe("reloadTreeFor — 표면-스코프 폴 (전역 activeProject 아님)", () => {
  beforeEach(() => {
    readDirCalls.length = 0;
    useAppStore.setState({
      // 전역 activeProject는 /a로 두되, reloadTreeFor는 인자 project를 따라야 한다.
      activeProject: "/a",
      projects: [mkProject("/a", ["/a/src"]), mkProject("/b", ["/b/lib"])] as never,
      childrenCache: {},
    });
  });

  it("reloadTreeFor('/b')는 /b의 root+expanded만 읽는다 (전역 /a 아님)", async () => {
    await useAppStore.getState().reloadTreeFor("/b");
    expect(readDirCalls).toContain("/b");
    expect(readDirCalls).toContain("/b/lib");
    // 전역 activeProject(/a) 관련 경로는 건드리지 않는다.
    expect(readDirCalls).not.toContain("/a");
    expect(readDirCalls).not.toContain("/a/src");
  });

  it("reloadTreeFor('/a')는 /a의 root+expanded를 읽는다", async () => {
    await useAppStore.getState().reloadTreeFor("/a");
    expect(readDirCalls).toContain("/a");
    expect(readDirCalls).toContain("/a/src");
    expect(readDirCalls).not.toContain("/b");
  });

  it("reloadTreeFor(null)은 no-op (읽기 없음)", async () => {
    await useAppStore.getState().reloadTreeFor(null);
    expect(readDirCalls).toHaveLength(0);
  });

  it("reloadActiveTree는 전역 activeProject로 위임한다", async () => {
    await useAppStore.getState().reloadActiveTree();
    expect(readDirCalls).toContain("/a");
    expect(readDirCalls).not.toContain("/b");
  });
});

/**
 * toggleExpandedFor 프로젝트-스코프 (P5 F2) — 부 표면 트리가 자기 프로젝트의
 * tree_state에만 확장을 기록해야 한다. 예전 toggleExpanded는 전역 activeProject에
 * 기록해, 부 표면(secondary) 폴더를 펼치면 주 프로젝트 tree_state가 오염되고
 * reloadTreeFor(secondary)가 그 확장을 못 봤다(재시작 후 부 확장 소실).
 */
describe("toggleExpandedFor — 프로젝트-스코프 확장 (2인스턴스 격리)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      activeProject: "/a", // 전역 활성은 /a
      projects: [mkProject("/a", []), mkProject("/b", [])] as never,
    });
  });

  const expandedOf = (project: string): string[] =>
    useAppStore.getState().projects.find((p) => p.path === project)?.tree_state.expanded ?? [];

  it("toggleExpandedFor('/b', dir)는 /b의 tree_state에만 기록(주 /a 무영향)", () => {
    useAppStore.getState().toggleExpandedFor("/b", "/b/lib");
    expect(expandedOf("/b")).toContain("/b/lib");
    expect(expandedOf("/a")).toEqual([]); // 주 프로젝트 오염 없음
  });

  it("접기도 그 프로젝트에만 — 두 프로젝트가 서로의 확장을 안 건드린다", () => {
    const g = useAppStore.getState();
    g.toggleExpandedFor("/a", "/a/src");
    g.toggleExpandedFor("/b", "/b/lib");
    expect(expandedOf("/a")).toEqual(["/a/src"]);
    expect(expandedOf("/b")).toEqual(["/b/lib"]);
    // /b 접기 → /a 확장 온전.
    useAppStore.getState().toggleExpandedFor("/b", "/b/lib");
    expect(expandedOf("/b")).toEqual([]);
    expect(expandedOf("/a")).toEqual(["/a/src"]);
  });

  it("toggleExpanded(레거시)는 전역 activeProject(/a)로 위임", () => {
    useAppStore.getState().toggleExpanded("/a/src");
    expect(expandedOf("/a")).toContain("/a/src");
    expect(expandedOf("/b")).toEqual([]);
  });
});
