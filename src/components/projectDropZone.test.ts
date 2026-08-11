/**
 * 프로젝트 탭 화면 드롭 파이프라인 (멀티프로젝트 P6) — App.onProjDrop이 쓰는
 * 합성: resolveDropZone(host rect, x, y) → placementForZone(zone) → 트리 배치.
 * 두 순수 함수의 조합이 좌/우/상/하 가장자리를 올바른 방향·위치로 매핑하는지,
 * 중앙은 분할하지 않는지(null) 검증한다.
 */
import { describe, expect, it } from "vitest";
import { resolveDropZone } from "./sessionDropZone";
import { placementForZone } from "../state/surfaceTree";

// host(작업 영역) rect — 좌표계는 뷰포트 절대값(App은 getBoundingClientRect 사용).
const HOST = { left: 0, top: 0, width: 1000, height: 600 };

/** App 파이프라인 그대로: 드롭 좌표 → 배치(또는 null=분할 아님). */
function dropPlacement(x: number, y: number) {
  const zone = resolveDropZone(HOST, x, y);
  return zone ? placementForZone(zone) : null;
}

describe("프로젝트 드롭 방향 판정 (좌/우/상/하 → 트리 direction/위치)", () => {
  it("좌측 가장자리 → row·before(좌)", () => {
    expect(dropPlacement(20, 300)).toEqual({ direction: "row", before: true });
  });
  it("우측 가장자리 → row·after(우) = 우클릭 우측분할과 동일 방향", () => {
    expect(dropPlacement(980, 300)).toEqual({ direction: "row", before: false });
  });
  it("상단 가장자리 → column·before(상)", () => {
    expect(dropPlacement(500, 20)).toEqual({ direction: "column", before: true });
  });
  it("하단 가장자리 → column·after(하)", () => {
    expect(dropPlacement(500, 580)).toEqual({ direction: "column", before: false });
  });
  it("중앙 → null (분할 아님 — 명세: 중앙 무시)", () => {
    expect(dropPlacement(500, 300)).toBeNull();
  });
  it("host 밖 좌표 → null (드롭 무효)", () => {
    expect(dropPlacement(-5, 300)).toBeNull();
    expect(dropPlacement(500, 601)).toBeNull();
  });
});
