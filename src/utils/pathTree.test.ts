import { describe, expect, it } from "vitest";
import { buildPathTree } from "./pathTree";

/** P4 특성테스트 — 기존 GitPanel buildTree/rootTree 인라인과의 동치를
 * 손계산 픽스처로 고정(자기참조 금지). */

describe("buildPathTree", () => {
  it("중첩 경로 → trie, 누적 path는 slice+join과 동치 (손계산)", () => {
    const items = [{ p: "src/a.ts" }, { p: "src/sub/b.ts" }, { p: "top.ts" }];
    const root = buildPathTree(items, (x) => x.p);
    const src = root.children.get("src")!;
    expect(src.path).toBe("src");
    expect(src.leaf).toBeUndefined(); // 중간 폴더 — 페이로드 없음
    expect(src.children.get("a.ts")!.path).toBe("src/a.ts");
    expect(src.children.get("a.ts")!.leaf).toBe(items[0]);
    expect(src.children.get("sub")!.children.get("b.ts")!.leaf).toBe(items[1]);
    expect(root.children.get("top.ts")!.leaf).toBe(items[2]);
  });

  it("Map 삽입 순서 = 입력 순서 (기존 렌더 순서 보존)", () => {
    const root = buildPathTree([{ p: "b" }, { p: "a" }], (x) => x.p);
    expect([...root.children.keys()]).toEqual(["b", "a"]);
  });

  it("빈 세그먼트 제거 — 선행/중복 슬래시 흡수 (rootTree의 상대화 잔여 대비)", () => {
    const root = buildPathTree([{ p: "/x//y" }], (x) => x.p);
    expect(root.children.get("x")!.children.get("y")!.path).toBe("x/y");
  });

  it("폴더가 나중에 leaf도 되는 경우(경로 중첩) — 둘 다 유지", () => {
    const root = buildPathTree([{ p: "a/b" }, { p: "a" }], (x) => x.p);
    const a = root.children.get("a")!;
    expect(a.leaf).toEqual({ p: "a" });
    expect(a.children.get("b")!.leaf).toEqual({ p: "a/b" });
  });
});
