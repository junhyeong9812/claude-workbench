import { describe, expect, it } from "vitest";
import {
  computeSessionDropTarget,
  decodeSessionDrag,
  encodeSessionDrag,
  resolveDropZone,
  sameZoneRect,
  zoneHighlight,
} from "./sessionDropZone";

const R = { left: 100, top: 100, width: 200, height: 100 };

describe("resolveDropZone", () => {
  it("중앙은 center", () => {
    expect(resolveDropZone(R, 200, 150)).toBe("center");
  });

  it("가장자리 20% 밴드는 각 방향", () => {
    expect(resolveDropZone(R, 105, 150)).toBe("left"); // rx=0.025
    expect(resolveDropZone(R, 295, 150)).toBe("right"); // rx=0.975
    expect(resolveDropZone(R, 200, 105)).toBe("above"); // ry=0.05
    expect(resolveDropZone(R, 200, 195)).toBe("below"); // ry=0.95
  });

  it("밴드 경계(정확히 20%)는 center — dist < band 엄격 비교", () => {
    // rx = 0.2 → left 후보 dist=0.2, band 미만 아님 → center
    expect(resolveDropZone(R, 140, 150)).toBe("center");
  });

  it("모서리는 더 가까운 변이 이긴다", () => {
    // 좌상단 구석: rx=0.05(좌 10px), ry=0.02(상 2px) → above가 더 가깝다
    expect(resolveDropZone(R, 110, 102)).toBe("above");
    // 반대: rx=0.01, ry=0.15 → left
    expect(resolveDropZone(R, 102, 115)).toBe("left");
  });

  it("rect 밖·0 크기는 null", () => {
    expect(resolveDropZone(R, 99, 150)).toBeNull();
    expect(resolveDropZone(R, 200, 201)).toBeNull();
    expect(resolveDropZone({ ...R, width: 0 }, 100, 150)).toBeNull();
    expect(resolveDropZone({ ...R, height: 0 }, 200, 100)).toBeNull();
  });

  it("커스텀 band를 존중한다", () => {
    // rx=0.25는 기본 band(0.2)로는 center, band 0.3이면 left
    expect(resolveDropZone(R, 150, 150)).toBe("center");
    expect(resolveDropZone(R, 150, 150, 0.3)).toBe("left");
  });
});

describe("zoneHighlight", () => {
  it("스플릿 존은 결과 반쪽을 칠한다", () => {
    expect(zoneHighlight(R, "left")).toEqual({ left: 100, top: 100, width: 100, height: 100 });
    expect(zoneHighlight(R, "right")).toEqual({ left: 200, top: 100, width: 100, height: 100 });
    expect(zoneHighlight(R, "above")).toEqual({ left: 100, top: 100, width: 200, height: 50 });
    expect(zoneHighlight(R, "below")).toEqual({ left: 100, top: 150, width: 200, height: 50 });
  });
  it("center는 전체", () => {
    expect(zoneHighlight(R, "center")).toEqual(R);
  });
});

describe("encode/decodeSessionDrag", () => {
  it("왕복 보존", () => {
    const p = { uuid: "u-1", project: "/home/x/proj", title: "작업 A", source: "archive" as const };
    expect(decodeSessionDrag(encodeSessionDrag(p))).toEqual(p);
    const q = { ...p, source: "picker" as const };
    expect(decodeSessionDrag(encodeSessionDrag(q))).toEqual(q);
  });
  it("손상/외부 payload는 null", () => {
    expect(decodeSessionDrag("not-json")).toBeNull();
    expect(decodeSessionDrag("{}")).toBeNull();
    expect(
      decodeSessionDrag(JSON.stringify({ uuid: "", project: "p", title: "t", source: "picker" })),
    ).toBeNull();
    expect(
      decodeSessionDrag(JSON.stringify({ uuid: 1, project: "p", title: "t", source: "picker" })),
    ).toBeNull();
    expect(decodeSessionDrag(JSON.stringify(null))).toBeNull();
  });
  it("빈 project는 거부 — activeProject 무음 폴백 차단 (S8)", () => {
    expect(
      decodeSessionDrag(JSON.stringify({ uuid: "u", project: "", title: "t", source: "archive" })),
    ).toBeNull();
  });
  it("source 누락/불량은 거부 (S11)", () => {
    expect(decodeSessionDrag(JSON.stringify({ uuid: "u", project: "p", title: "t" }))).toBeNull();
    expect(
      decodeSessionDrag(JSON.stringify({ uuid: "u", project: "p", title: "t", source: "tree" })),
    ).toBeNull();
  });
});

describe("computeSessionDropTarget", () => {
  // host(.main-area)는 뷰포트 (50,20)에 800x600. 두 그룹이 좌/우 반반.
  const HOST = { left: 50, top: 20, width: 800, height: 600 };
  const A = { ref: "p-a", rect: { left: 50, top: 20, width: 400, height: 600 } };
  const B = { ref: "p-b", rect: { left: 450, top: 20, width: 400, height: 600 } };

  it("그룹 중앙 = 그 그룹에 탭 추가 + 하이라이트는 host 로컬 좌표", () => {
    // (250,320) = A의 정중앙 (rx=0.5, ry=0.5) → center. hl = A 전체 - host 원점.
    expect(computeSessionDropTarget([A, B], HOST, 250, 320, true)).toEqual({
      referencePanel: "p-a",
      zone: "center",
      hl: { left: 0, top: 0, width: 400, height: 600 },
    });
  });

  it("가장자리 밴드 = 스플릿 + 결과 반쪽 프리뷰", () => {
    // x=410 → A 안 rx=0.9, right 거리 0.1 < 0.2 밴드.
    // hl = A의 오른쪽 절반 (뷰포트 250..450) → host 로컬 left=200.
    expect(computeSessionDropTarget([A, B], HOST, 410, 320, true)).toEqual({
      referencePanel: "p-a",
      zone: "right",
      hl: { left: 200, top: 0, width: 200, height: 600 },
    });
  });

  it("겹치는 그룹은 최소 면적(가장 안쪽/floating)이 이긴다 (S12)", () => {
    const tile = { ref: "p-tile", rect: { left: 50, top: 20, width: 800, height: 600 } };
    const float = { ref: "p-float", rect: { left: 250, top: 120, width: 200, height: 200 } };
    // (350,220) = float 정중앙이자 tile 내부. 면적 40000 < 480000.
    expect(computeSessionDropTarget([tile, float], HOST, 350, 220, true)).toEqual({
      referencePanel: "p-float",
      zone: "center",
      hl: { left: 200, top: 100, width: 200, height: 200 },
    });
  });

  it("빈 그룹(ref null)은 대상에서 제외 — 프리뷰-결과 계약 (S3)", () => {
    // 좌표는 첫 그룹 안이지만 그 그룹은 대표 패널이 없다 → 히트 없음.
    expect(computeSessionDropTarget([{ ref: null, rect: A.rect }, B], HOST, 250, 320, true)).toBeNull();
  });

  it("빈 dock은 host 전체에 기본 배치 (referencePanel null)", () => {
    expect(computeSessionDropTarget([], HOST, 250, 320, false)).toEqual({
      referencePanel: null,
      zone: "center",
      hl: { left: 0, top: 0, width: 800, height: 600 },
    });
  });

  it("비어 있지 않은 dock의 그룹 밖 여백은 null (S7)", () => {
    // A만 있는 dock에서 A 밖(오른쪽 절반) 좌표 → 기본 배치로 새지 않는다.
    expect(computeSessionDropTarget([A], HOST, 700, 320, true)).toBeNull();
  });
});

describe("sameZoneRect", () => {
  it("eps 이내면 같다", () => {
    expect(sameZoneRect(R, { ...R, left: 100.5 })).toBe(true);
  });
  it("width/height만 달라도 다르다 (S4 — left/top만 비교하면 놓친다)", () => {
    expect(sameZoneRect(R, { ...R, width: 150 })).toBe(false);
    expect(sameZoneRect(R, { ...R, height: 90 })).toBe(false);
  });
});
