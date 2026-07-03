import { describe, expect, it } from "vitest";
import { fqcnFromPath, importInsertion } from "./cmComplete";

describe("fqcnFromPath", () => {
  it("derives a FQCN from the maven/gradle source-root convention", () => {
    expect(fqcnFromPath("src/main/java/com/acme/Foo.java")).toEqual({
      name: "Foo",
      fqcn: "com.acme.Foo",
    });
    expect(fqcnFromPath("app/src/test/kotlin/com/acme/BarTest.kt")).toEqual({
      name: "BarTest",
      fqcn: "com.acme.BarTest",
    });
  });

  it("falls back to a bare java/kotlin dir root", () => {
    expect(fqcnFromPath("java/com/x/Y.java")).toEqual({ name: "Y", fqcn: "com.x.Y" });
  });

  it("returns null outside a recognizable root or for non-class names", () => {
    expect(fqcnFromPath("scripts/Build.java")).toBeNull(); // no source root
    expect(fqcnFromPath("src/main/java/com/acme/package-info.java")).toBeNull(); // lowercase
  });
});

describe("importInsertion", () => {
  const doc = `package com.app;\n\nimport com.acme.Old;\n\nclass A {}\n`;

  it("inserts after the last import", () => {
    const ins = importInsertion(doc, "com.acme.Foo", false);
    expect(ins).not.toBeNull();
    expect(ins!.insert).toBe("import com.acme.Foo;\n");
    // right after the existing import line
    expect(doc.slice(0, ins!.from).endsWith("import com.acme.Old;\n")).toBe(true);
  });

  it("inserts after the package line when there are no imports", () => {
    const noImports = `package com.app;\n\nclass A {}\n`;
    const ins = importInsertion(noImports, "com.acme.Foo", false);
    expect(ins!.insert).toBe("\nimport com.acme.Foo;\n");
    expect(noImports.slice(0, ins!.from).endsWith("package com.app;\n")).toBe(true);
  });

  it("skips already-imported, wildcard-covered, and same-package classes", () => {
    expect(importInsertion(doc, "com.acme.Old", false)).toBeNull();
    expect(importInsertion(`import com.acme.*;\nclass A {}`, "com.acme.Foo", false)).toBeNull();
    expect(importInsertion(doc, "com.app.Sibling", false)).toBeNull();
  });

  it("omits the semicolon for kotlin", () => {
    const ins = importInsertion(doc, "com.acme.Foo", true);
    expect(ins!.insert).toBe("import com.acme.Foo\n");
  });
});
