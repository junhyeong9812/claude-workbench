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
import { secondaryProject, surfaceLayout } from "./surfaceTree";

describe("store: setDualProject → 트리 + 이중 기록", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.getState().setDualProject(null);
  });

  it("열기: 트리 블롭(정본, 방향 포함) + legacy 파생 미러 함께 기록 (P6)", () => {
    useAppStore.getState().setDualProject("/b");
    const s = useAppStore.getState();
    expect(s.dualProject).toBe("/b");
    // 메모리 트리에 secondary 멤버십.
    expect(JSON.stringify(s.surfaceTree)).toContain("/b");
    // 디스크 정본 = 트리 블롭(방향까지 담음, P6) + provenance 마커 legacyMirror(F1).
    const blob = localStorage.getItem("surfaceTree");
    expect(blob).not.toBeNull();
    expect(JSON.parse(blob!)).toEqual({ ...s.surfaceTree, legacyMirror: "/b" });
    // F1 불변식: legacyMirror는 항상 트리 secondary와 일치(쓰기 시점 동봉).
    expect(JSON.parse(blob!).legacyMirror).toBe(secondaryProject(s.surfaceTree));
    // 다운그레이드 파생 미러 = 구버전 앱이 읽는 legacy 문자열 키.
    expect(localStorage.getItem("dualProject")).toBe("/b");
  });

  it("닫기: primary 단독 + 두 키 모두 제거(구버전 앱도 닫힘 반영)", () => {
    useAppStore.getState().setDualProject("/b");
    useAppStore.getState().setDualProject(null);
    const s = useAppStore.getState();
    expect(s.dualProject).toBeNull();
    expect(secondaryProject(s.surfaceTree)).toBeNull();
    expect(localStorage.getItem("dualProject")).toBeNull();
    expect(localStorage.getItem("surfaceTree")).toBeNull();
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

describe("F2(codex P1-2): loadSurfaceTree — 손상 블롭 ≠ 블롭 부재", () => {
  beforeEach(() => localStorage.clear());

  it("손상 블롭(파싱 실패) + legacy=/b → 기본(닫힌 분할 부활 금지)", () => {
    localStorage.setItem("surfaceTree", "{not valid json");
    localStorage.setItem("dualProject", "/b");
    expect(secondaryProject(loadSurfaceTree())).toBeNull();
  });

  it("블롭 부재(키 없음) + legacy=/b → /b 승격(pre-P6 마이그레이션 정상)", () => {
    localStorage.setItem("dualProject", "/b");
    expect(secondaryProject(loadSurfaceTree())).toBe("/b");
  });

  it("유효 블롭(방향 포함) 왕복 로드 → 방향·멤버십 보존", () => {
    useAppStore.getState().setDualProject("/c", { direction: "column", before: false });
    const t = loadSurfaceTree();
    expect(secondaryProject(t)).toBe("/c");
    expect(surfaceLayout(t)).toEqual({ direction: "column", before: false });
    useAppStore.getState().setDualProject(null);
  });
});
