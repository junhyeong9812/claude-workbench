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

  it("flags a wildcard on a nonexistent project package", () => {
    const out = unresolvedImports("import com.acme.nothere.*;", IDX);
    expect(out).toHaveLength(1);
  });

  it("stays silent on an empty or truncated index (no false claims)", () => {
    const doc = "import com.acme.Missing;";
    expect(unresolvedImports(doc, idx([]))).toHaveLength(0);
    expect(unresolvedImports(doc, idx(["com.acme.Foo"], true))).toHaveLength(0);
  });
});
