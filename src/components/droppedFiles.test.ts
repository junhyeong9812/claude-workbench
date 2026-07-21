import { describe, expect, it } from "vitest";
import {
  classifyDrops,
  decodeStrict,
  DROP_MAX_BYTES,
  DROP_MAX_FILES,
  extOf,
} from "./droppedFiles";

describe("decodeStrict", () => {
  it("유효 UTF-8은 디코드, 바이너리는 null (무음 mojibake 금지)", () => {
    expect(decodeStrict(new TextEncoder().encode("한글 ok").buffer as ArrayBuffer)).toBe("한글 ok");
    // 0xFF 0xFE — UTF-8로 무효.
    expect(decodeStrict(new Uint8Array([0xff, 0xfe, 0x00]).buffer as ArrayBuffer)).toBeNull();
    // 빈 파일은 빈 문자열(유효).
    expect(decodeStrict(new ArrayBuffer(0))).toBe("");
  });
});

describe("classifyDrops", () => {
  it("확장자로 텍스트/이미지 분류, 드롭 순서 보존", () => {
    const out = classifyDrops([
      { name: "README.md", size: 100 },
      { name: "shot.PNG", size: 100 },
      { name: "noext", size: 100 },
    ]);
    expect(out.map((o) => o.kind)).toEqual(["text", "image", "text"]);
    expect(out[0].name).toBe("README.md");
  });

  it("크기 상한 초과는 too-large — 무음 스킵이 아니라 사유 분류", () => {
    const out = classifyDrops([{ name: "big.log", size: DROP_MAX_BYTES + 1 }]);
    expect(out[0].kind).toBe("too-large");
  });

  it("개수 상한 초과분은 over-limit", () => {
    const files = Array.from({ length: DROP_MAX_FILES + 2 }, (_, i) => ({
      name: `f${i}.txt`,
      size: 1,
    }));
    const out = classifyDrops(files);
    expect(out.filter((o) => o.kind === "over-limit")).toHaveLength(2);
    expect(out[DROP_MAX_FILES - 1].kind).toBe("text");
  });

  it("숨김파일(.gitignore)은 확장자 없음으로 텍스트", () => {
    expect(extOf(".gitignore")).toBe("");
    expect(classifyDrops([{ name: ".gitignore", size: 1 }])[0].kind).toBe("text");
  });
});
