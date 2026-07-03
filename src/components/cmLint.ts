/** Editor red-squiggle diagnostics (A층 — heuristic, no LSP):
 *
 *   1. syntax errors from the Lezer parse tree — languages with a real parser
 *      (Java/TS/JS/Python/Rust/CSS/HTML/JSON) mark error nodes; legacy stream
 *      modes (Kotlin 등) produce none, so the linter is a no-op there.
 *   2. unresolved PROJECT-INTERNAL imports (Java/Kotlin): an `import` whose
 *      package belongs to the project's own package roots (from the tree class
 *      index) but names a class the index doesn't contain. External-library
 *      imports are never judged — we can't see the classpath without LSP, and
 *      a false red line is worse than none. A truncated index (>500 files)
 *      also disables this check entirely.
 *
 * Typed/semantic diagnostics (JDK APIs, member types) are the LSP integration
 * (B층 계획 문서 — toolchain 해결 계층 포함).
 */
import { linter, type Diagnostic } from "@codemirror/lint";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { classIndex, maskBlockComments, type ClassIndex } from "./cmComplete";

/** Lezer error nodes → diagnostics. Zero-width error nodes are widened one char
 * so the squiggle is visible. */
const syntaxLinter = linter((view) => {
  const diags: Diagnostic[] = [];
  const docLen = view.state.doc.length;
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (!node.type.isError) return;
      const from = node.from;
      const to = node.to > from ? node.to : Math.min(from + 1, docLen);
      diags.push({ from, to, severity: "error", message: "구문 오류 (파서가 이해하지 못한 지점)" });
    });
  return diags;
});

/** Pure resolver — exported for unit tests. Returns the doc ranges of class
 * imports whose package EXISTS in the project index but whose class doesn't
 * (the typo'd-neighbor case). Anything in a package the index doesn't contain —
 * external libraries, unknown subpackages, even same-org artifacts — is never
 * judged: without the classpath a missed squiggle is safer than a false one. */
export function unresolvedImports(
  doc: string,
  idx: ClassIndex,
): { from: number; to: number; fqcn: string }[] {
  if (idx.classes.length === 0 || idx.truncated) return []; // can't judge — stay silent
  doc = maskBlockComments(doc); // commented-out imports are not imports
  const known = new Set(idx.classes.map((c) => c.fqcn));
  const pkgs = new Set(idx.classes.map((c) => c.fqcn.slice(0, c.fqcn.lastIndexOf("."))));
  const out: { from: number; to: number; fqcn: string }[] = [];
  for (const m of doc.matchAll(/^[ \t]*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?[ \t]*$/gm)) {
    const spec = m[1];
    if (spec.endsWith(".*")) continue; // wildcard — package contents unknowable enough; no claim
    // static member import (`import static com.x.Foo.bar`): the class is the parent.
    const cls = /^[A-Z]/.test(spec.split(".").pop() ?? "")
      ? spec
      : spec.slice(0, spec.lastIndexOf("."));
    const pkg = cls.slice(0, cls.lastIndexOf("."));
    if (!pkg || !pkgs.has(pkg)) continue; // package not in the index — external, silent
    if (!known.has(cls)) {
      const start = (m.index ?? 0) + m[0].indexOf(spec);
      out.push({ from: start, to: start + spec.length, fqcn: spec });
    }
  }
  return out;
}

/** Async import linter (Java/Kotlin) over the cached tree class index. */
const importLinter = (project: string): Extension =>
  linter(async (view) => {
    const idx = await classIndex(project);
    return unresolvedImports(view.state.doc.toString(), idx).map((u) => ({
      from: u.from,
      to: u.to,
      severity: "error" as const,
      message: `프로젝트에서 찾을 수 없는 임포트: ${u.fqcn} (외부 라이브러리는 검사하지 않음)`,
    }));
  });

/** Lint extensions for one editor: syntax squiggles everywhere, plus the
 * project-internal import check for Java/Kotlin when a project root is known. */
export function lintExts(path: string, project: string | null): Extension[] {
  const exts: Extension[] = [syntaxLinter];
  if (project && /\.(java|kts?)$/i.test(path)) exts.push(importLinter(project));
  return exts;
}
