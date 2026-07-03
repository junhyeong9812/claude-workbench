import { describe, expect, it } from "vitest";
import { unresolvedImports } from "./cmLint";
import type { ClassIndex } from "./cmComplete";

const idx = (classes: string[], truncated = false): ClassIndex => ({
  at: 0,
  truncated,
  classes: classes.map((fqcn) => ({ fqcn, name: fqcn.split(".").pop()! })),
});

const IDX = idx(["com.acme.Foo", "com.acme.util.Str", "com.acme.Bar"]);

describe("unresolvedImports", () => {
  it("flags a project-internal import missing from the index", () => {
    const doc = `package com.app;\nimport com.acme.Missing;\nclass A {}`;
    const out = unresolvedImports(doc, IDX);
    expect(out).toHaveLength(1);
    expect(out[0].fqcn).toBe("com.acme.Missing");
    expect(doc.slice(out[0].from, out[0].to)).toBe("com.acme.Missing");
  });

  it("accepts resolvable class, wildcard-on-existing-package, and static member imports", () => {
    const doc = [
      "import com.acme.Foo;",
      "import com.acme.util.*;",
      "import static com.acme.Bar.baz;",
    ].join("\n");
    expect(unresolvedImports(doc, IDX)).toHaveLength(0);
  });

  it("never judges external-library imports", () => {
    const doc = `import org.springframework.web.Client;\nimport java.util.List;`;
    expect(unresolvedImports(doc, IDX)).toHaveLength(0);
  });

  it("stays silent on wildcards and unknown subpackages (classpath unknowable)", () => {
    // wildcard — never judged
    expect(unresolvedImports("import com.acme.nothere.*;", IDX)).toHaveLength(0);
    // same-org external artifact: package not in the index → no claim
    expect(unresolvedImports("import com.acme.sdk.External;", IDX)).toHaveLength(0);
  });

  it("ignores imports inside block comments", () => {
    const doc = `package com.app;\n/*\nimport com.acme.Missing;\n*/\nclass A {}`;
    expect(unresolvedImports(doc, IDX)).toHaveLength(0);
  });

  it("a /* inside a line comment does not swallow the rest of the file", () => {
    const doc = `// note /*\nimport com.acme.Missing;\nclass A {}`;
    expect(unresolvedImports(doc, IDX)).toHaveLength(1); // still judged
  });

  it("flags a static import whose parent class is missing", () => {
    const out = unresolvedImports("import static com.acme.Missing.CONSTANT;", IDX);
    expect(out).toHaveLength(1);
    expect(out[0].fqcn).toBe("com.acme.Missing.CONSTANT");
  });

  it("stays silent on lowercase class names (not in the convention index)", () => {
    expect(unresolvedImports("import com.acme.lowercaseclass;", IDX)).toHaveLength(0);
  });

  it("stays silent on an empty or truncated index (no false claims)", () => {
    const doc = "import com.acme.Missing;";
    expect(unresolvedImports(doc, idx([]))).toHaveLength(0);
    expect(unresolvedImports(doc, idx(["com.acme.Foo"], true))).toHaveLength(0);
  });
});
