import { describe, expect, it } from "vitest";
import {
  decodePayload,
  dropDisallowed,
  encodePayload,
  parentDir,
  resolveDropDir,
} from "./treeDnd";

describe("resolveDropDir", () => {
  it("폴더 행 → 그 폴더, 파일 행 → 부모, 빈 영역 → 루트", () => {
    expect(resolveDropDir({ path: "/p/src", is_dir: true }, "/p")).toBe("/p/src");
    expect(resolveDropDir({ path: "/p/src/a.ts", is_dir: false }, "/p")).toBe("/p/src");
    expect(resolveDropDir(null, "/p")).toBe("/p");
  });
});

describe("dropDisallowed", () => {
  const file = { path: "/p/src/a.ts", isDir: false };
  const dir = { path: "/p/src", isDir: true };

  it("정상 이동 허용", () => {
    expect(dropDisallowed(file, "/p/lib")).toBeNull();
    expect(dropDisallowed(dir, "/p/lib")).toBeNull();
    // 중첩 폴더를 루트로 — 부모가 아니므로 허용.
    expect(dropDisallowed({ path: "/p/x/deep", isDir: true }, "/p")).toBeNull();
  });

  it("자기 자신·자기 하위·같은 부모 금지", () => {
    expect(dropDisallowed(dir, "/p/src")).toBeTruthy(); // 자기 자신 위
    expect(dropDisallowed(dir, "/p/src/sub")).toBeTruthy(); // 자기 하위
    expect(dropDisallowed(file, "/p/src")).toBeTruthy(); // 같은 부모 (파일 행/부모 폴더 위)
  });

  it("이름 접두가 같은 형제 폴더는 하위로 오인하지 않음", () => {
    // /p/src2는 /p/src의 하위가 아니다 — "/" 경계 필수.
    expect(dropDisallowed(dir, "/p/src2")).toBeNull();
  });

  it("루트 직속 항목을 루트로 → 같은 부모 금지", () => {
    expect(dropDisallowed({ path: "/p/top.txt", isDir: false }, "/p")).toBeTruthy();
  });
});

describe("payload 직렬화", () => {
  it("왕복 보존 + 이물 파싱은 null", () => {
    const p = { path: "/p/a", isDir: true };
    expect(decodePayload(encodePayload(p))).toEqual(p);
    expect(decodePayload("not-json")).toBeNull();
    expect(decodePayload(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(decodePayload(JSON.stringify({ path: "", isDir: false }))).toBeNull();
  });
});

describe("parentDir", () => {
  it("루트 직속은 /", () => {
    expect(parentDir("/a")).toBe("/");
    expect(parentDir("/a/b/c")).toBe("/a/b");
  });
});
