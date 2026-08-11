/**
 * store 배선 통합 테스트 (멀티프로젝트 P3') — setDualProject가 트리 API로
 * 매핑되며 두 localStorage 키(surfaceTree + 레거시 dualProject)를 함께 기록해
 * 다운그레이드 안전을 유지하는지 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// store.ts는 @tauri-apps/api를 import 하지만 이 테스트가 부르는 경로(setDualProject)
// 는 invoke를 타지 않는다 — 안전하게 no-op 목킹.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: vi.fn(() => Promise.resolve(() => {})) }),
}));

import { loadSurfaceTree, useAppStore } from "./store";
import { emptyTree, secondaryProject, surfaceLayout } from "./surfaceTree";

describe("store: setDualProject → 트리 + 이중 기록", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().setDualProject(null);
  });

  it("열기: 트리 블롭(정본, 방향 포함) + legacy 빵부스러기 함께 기록 (P6 재슬라이스)", () => {
    useAppStore.getState().setDualProject("/b");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/b");
    // 메모리 트리에 secondary 멤버십.
    expect(JSON.stringify(s.surfaceTree)).toContain("/b");
    // 디스크 정본 = 트리 블롭(방향까지 담음). provenance 마커 없음(화해 폐지).
    const blob = localStorage.getItem("surfaceTree");
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob!)).toEqual(s.surfaceTree);
    expect(JSON.parse(blob!).legacyMirror).toBeUndefined();
    // write-only 다운그레이드 빵부스러기 = 구버전 앱이 읽는 legacy 문자열 키.
    expect(localStorage.getItem("dualProject")).toBe("/b");
  });

  it("닫기: primary 단독 + emptyTree tombstone 기록(키 부재 아님) + legacy 제거", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject(null);
    const s = useAppStore.getState();
    expect(s.dualProject).toBeNull();
    expect(secondaryProject(s.surfaceTree)).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
    // 트리 키는 emptyTree tombstone으로 남는다(removeItem 아님) — "키 부재 ⟺ pre-P6"
    // 불변 유지(닫기 removeItem 부분실패 시 stale legacy 부활 차단).
    expect(localStorage.getItem("surfaceTree")).not.toBeNull();
    expect(secondaryProject(loadSurfaceTree())).toBeNull();
  });

  it("방향(placement) 열기: 트리 블롭에 direction 보존 (하=column)", () => {
    useAppStore.getState().setDualProject("/b", { direction: "column", before: false });
    const blob = JSON.parse(localStorage.getItem("surfaceTree")!);
    expect(blob.root.direction).toBe("column");
    // 미러는 여전히 secondary 문자열(방향 정보 없음 — 파생).
    expect(localStorage.getItem("dualProject")).toBe("/b");
  });

  it("교체: secondary 재지정 시 중복 없이 최신 프로젝트만", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject("/c");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/c");
    expect(localStorage.getItem("dualProject")).toBe("/c");
  });
});

describe("store: closeProject가 우측 표면·미러·키를 정리 (FD)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ projects: [] });
    useAppStore.getState().setDualProject(null);
  });

  it("마지막 프로젝트를 닫아 목록이 비어도 우측 표면 잔존 0", () => {
    // 우측 표면 = "/b" (목록이 비어 있어도 예전 projects.length>0 가드가 정리를
    // 막던 케이스). closeProject가 갱신 안에서 함께 제거해야 한다.
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().closeProject("/b");
    const s = useAppStore.getState();
    expect(secondaryProject(s.surfaceTree)).toBeNull();
    expect(s.dualProject).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
  });

  it("우측이 아닌 다른 프로젝트를 닫으면 우측 표면은 그대로", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().closeProject("/a");
    const s = useAppStore.getState();
    expect(secondaryProject(s.surfaceTree)).toBe("/b");
    expect(localStorage.getItem("dualProject")).toBe("/b");
  });
});

describe("loadSurfaceTree — 트리 블롭 유일 정본(P6 재슬라이스, 화해 없음)", () => {
  beforeEach(() => localStorage.clear());

  it("(a) 트리 present valid + legacy 다른 값 → 트리 채택(legacy 무관)", () => {
    // 트리 = /b(column), legacy = /old. 로드는 legacy를 무시하고 트리를 채택한다.
    useAppStore.getState().setDualProject("/b", { direction: "column", before: true });
    localStorage.setItem("dualProject", "/old"); // 어긋난 legacy — 무시돼야 함.
    const t = loadSurfaceTree();
    expect(secondaryProject(t)).toBe("/b");
    expect(surfaceLayout(t)).toEqual({ direction: "column", before: true });
    useAppStore.getState().setDualProject(null);
  });

  it('(b) 트리 present "null" (parsed null) → 기본(stale legacy 부활 없음)', () => {
    localStorage.setItem("surfaceTree", "null");
    localStorage.setItem("dualProject", "/b");
    expect(secondaryProject(loadSurfaceTree())).toBeNull();
  });

  it("(c) 트리 present 손상 JSON + legacy=/b → 기본(닫힌 분할 부활 금지)", () => {
    localStorage.setItem("surfaceTree", "{not valid json");
    localStorage.setItem("dualProject", "/b");
    expect(secondaryProject(loadSurfaceTree())).toBeNull();
  });

  it("(d) 트리 키 부재 + legacy=/b → /b 승격(pre-P6 마이그레이션)", () => {
    localStorage.setItem("dualProject", "/b");
    expect(secondaryProject(loadSurfaceTree())).toBe("/b");
  });

  it("(e) 실패쓰기 유사(트리=/new present, legacy=/old stale) → /new 승(트리)", () => {
    // 신버전이 트리+legacy를 쓰려다 legacy 쓰기만 실패해 어긋난 상황을 흉내낸다.
    // 예전 화해는 여기서 /old로 오판했다 — 재슬라이스는 트리(/new)를 그대로 채택.
    useAppStore.getState().setDualProject("/new");
    localStorage.setItem("dualProject", "/old");
    expect(secondaryProject(loadSurfaceTree())).toBe("/new");
    useAppStore.getState().setDualProject(null);
  });

  it("(g) 닫기: 저장값이 실제 emptyTree tombstone → 로드 기본(primary 단독)", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject(null);
    const blob = localStorage.getItem("surfaceTree");
    expect(blob).not.toBeNull(); // 키 제거 아님
    // "null"·손상도 통과하지 않도록 저장값이 진짜 emptyTree인지 비교(codex P2).
    expect(JSON.parse(blob!)).toEqual(emptyTree());
    expect(secondaryProject(loadSurfaceTree())).toBeNull();
  });

  it("(h) 닫기 부분실패(legacy removeItem이 throw) → tombstone 먼저 기록·부활 없음", () => {
    // codex 최종확인: 닫기의 legacy removeItem이 stale 값을 남긴 채 throw해도,
    // tombstone setItem이 **먼저** 실행되므로 트리 키는 emptyTree로 갱신된다.
    // 로드는 present tombstone을 읽어 legacy를 무시 → /b 부활 없음. 이 목킹은
    // 쓰기 순서까지 고정한다: removeItem을 setItem보다 앞으로 옮기는 회귀가 생기면
    // 트리 키에 옛 /b 블롭이 남아 로드가 /b를 부활시켜 이 단언이 깨진다.
    useAppStore.getState().setDualProject("/b");
    const realRemove = Storage.prototype.removeItem;
    const spy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === "dualProject") throw new Error("io"); // stale /b 잔존
        realRemove.call(this, key);
      });
    try {
      try {
        useAppStore.getState().setDualProject(null);
      } catch {
        /* persist가 throw를 전파할 수 있음 — 최종 디스크 상태만 검증 */
      }
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(localStorage.getItem("surfaceTree")!)).toEqual(emptyTree()); // tombstone 먼저
    expect(localStorage.getItem("dualProject")).toBe("/b"); // stale legacy 잔존
    expect(secondaryProject(loadSurfaceTree())).toBeNull(); // 그래도 부활 없음
  });

  it("유효 블롭(방향 포함) 왕복 로드 → 방향·멤버십 보존", () => {
    useAppStore.getState().setDualProject("/c", { direction: "column", before: false });
    const t = loadSurfaceTree();
    expect(secondaryProject(t)).toBe("/c");
    expect(surfaceLayout(t)).toEqual({ direction: "column", before: false });
    useAppStore.getState().setDualProject(null);
  });
});
