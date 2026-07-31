import { describe, expect, it } from "vitest";
import {
  decodeSessionDrag,
  encodeSessionDrag,
  resolveDropZone,
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
    const p = { uuid: "u-1", project: "/home/x/proj", title: "작업 A" };
    expect(decodeSessionDrag(encodeSessionDrag(p))).toEqual(p);
  });
  it("손상/외부 payload는 null", () => {
    expect(decodeSessionDrag("not-json")).toBeNull();
    expect(decodeSessionDrag("{}")).toBeNull();
    expect(decodeSessionDrag(JSON.stringify({ uuid: "", project: "p", title: "t" }))).toBeNull();
    expect(decodeSessionDrag(JSON.stringify({ uuid: 1, project: "p", title: "t" }))).toBeNull();
    expect(decodeSessionDrag(JSON.stringify(null))).toBeNull();
  });
});
