/** Editor autocompletion (A층 — heuristic, no LSP): Ctrl+Space everywhere via
 * basicSetup's completion keymap; sources added here on top of the language
 * packages' own completions (JS/TS/CSS/HTML ship theirs):
 *
 *   1. word completion from the current document (any language),
 *   2. Java/Kotlin keyword completion (legacy modes ship none),
 *   3. tree-based auto-import for Java/Kotlin: project source files are listed
 *      through the existing gitignore-aware `search_files` command and each
 *      file's FQCN is derived from the source-root path convention
 *      (`src/main/java/com/x/Foo.java` → `com.x.Foo`) — no file contents read.
 *      Picking a class inserts the name AND its `import` line (after the last
 *      import / the `package` line) unless already imported or same-package.
 *
 * Version-aware *semantic* completion (JDK APIs per toolchain, typed members)
 * is deliberately out of scope — that is the LSP integration (B층 계획 문서).
 */
import { invoke } from "@tauri-apps/api/core";
import { EditorState, type Extension } from "@codemirror/state";
import {
  completeAnyWord,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

interface FileHit {
  path: string;
  rel: string;
}

const JAVA_KEYWORDS =
  `abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient try var void volatile while yield`.split(
    " ",
  );
const KOTLIN_KEYWORDS =
  `abstract annotation as break by catch class companion const constructor continue crossinline data do else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set sealed super suspend tailrec this throw try typealias val var vararg when where while`.split(
    " ",
  );

const kwOptions = (words: string[]): Completion[] =>
  words.map((w) => ({ label: w, type: "keyword", boost: -10 }));

/** Register a completion source for every language in this editor state. */
const globalSource = (
  source: (ctx: CompletionContext) => CompletionResult | Promise<CompletionResult | null> | null,
): Extension => EditorState.languageData.of(() => [{ autocomplete: source }]);

// ---- tree-based class index (Java/Kotlin) ----

/** Derive a FQCN from a source path by the source-root convention. Returns null
 * for files outside a recognizable root (no guessing — a wrong import is worse
 * than none). */
export function fqcnFromPath(rel: string): { name: string; fqcn: string } | null {
  const m = /(?:^|\/)src\/(?:main|test)\/(?:java|kotlin)\/(.+)\.(java|kt)$/.exec(rel);
  const inner = m?.[1] ?? /(?:^|\/)(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(rel)?.[1] ?? null;
  if (!inner) return null;
  const parts = inner.split("/");
  const name = parts[parts.length - 1];
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) return null; // classes only, by convention
  return { name, fqcn: parts.join(".") };
}

export interface ClassIndex {
  at: number;
  classes: { name: string; fqcn: string }[];
  truncated: boolean;
}
const indexCache = new Map<string, ClassIndex>();
const INDEX_TTL_MS = 30_000;
const SEARCH_CAP = 500; // backend SEARCH_LIMIT — a bigger project's index is partial

/** List the project's Java/Kotlin classes via the gitignore-aware file finder
 * (backend `search_files`), cached briefly per project. Shared with the import
 * linter (cmLint.ts). */
export async function classIndex(project: string): Promise<ClassIndex> {
  const hit = indexCache.get(project);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit;
  const [java, kt] = await Promise.all([
    invoke<FileHit[]>("search_files", { root: project, query: "*.java" }).catch(() => []),
    invoke<FileHit[]>("search_files", { root: project, query: "*.kt" }).catch(() => []),
  ]);
  const classes: { name: string; fqcn: string }[] = [];
  for (const f of [...java, ...kt]) {
    const c = fqcnFromPath(f.rel);
    if (c) classes.push(c);
  }
  const idx: ClassIndex = {
    at: Date.now(),
    classes,
    truncated: java.length >= SEARCH_CAP || kt.length >= SEARCH_CAP,
  };
  indexCache.set(project, idx);
  return idx;
}

/** Blank out `/* … *​/` block contents (newlines kept) so header regexes don't
 * read commented-out `package`/`import` lines as real ones — offsets computed on
 * the masked text stay valid for the original document. */
export function maskBlockComments(doc: string): string {
  return doc.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Insert `import` for `fqcn` if the document doesn't already have it and the
 * class isn't in the file's own package. Returns the changes (or none). */
export function importInsertion(
  doc: string,
  fqcn: string,
  kotlin: boolean,
): { from: number; insert: string } | null {
  if (!fqcn.includes(".")) return null; // default package — not importable
  doc = maskBlockComments(doc); // a commented-out header line is not a header
  const pkg = fqcn.slice(0, fqcn.lastIndexOf("."));
  const filePkg = /^\s*package\s+([\w.]+)/m.exec(doc)?.[1] ?? null;
  if (filePkg === pkg) return null; // same package — no import needed
  const esc = fqcn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\s*import\\s+${esc}\\b`, "m").test(doc)) return null; // already imported
  if (new RegExp(`^\\s*import\\s+${pkg.replace(/\./g, "\\.")}\\.\\*`, "m").test(doc)) return null;
  const line = kotlin ? `import ${fqcn}\n` : `import ${fqcn};\n`;
  // After the last import; else after the package line; else at the top.
  let at = 0;
  const imports = [...doc.matchAll(/^\s*import\s+[^\n]*\n/gm)];
  if (imports.length > 0) {
    const last = imports[imports.length - 1];
    at = (last.index ?? 0) + last[0].length;
  } else {
    const pkgLine = /^\s*package\s+[^\n]*\n/m.exec(doc);
    at = pkgLine ? (pkgLine.index ?? 0) + pkgLine[0].length : 0;
    if (pkgLine) return { from: at, insert: `\n${line}` };
  }
  return { from: at, insert: line };
}

/** Async source: project class names with auto-import on apply (Java/Kotlin). */
function classSource(project: string, kotlin: boolean) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
    // Identifiers of 2+ chars, or an explicit Ctrl+Space.
    if (!word || (word.text.length < 2 && !ctx.explicit)) return null;
    const idx = await classIndex(project);
    if (idx.classes.length === 0) return null;
    const options: Completion[] = idx.classes.map((c) => ({
      label: c.name,
      detail: c.fqcn.slice(0, c.fqcn.lastIndexOf(".")),
      type: "class",
      apply: (view, _completion, from, to) => {
        const ins = importInsertion(view.state.doc.toString(), c.fqcn, kotlin);
        // The cursor shifts by the import's length only when the import lands
        // BEFORE the completion point (the normal header-above-body case).
        const shift = ins && ins.from <= from ? ins.insert.length : 0;
        view.dispatch({
          changes: [{ from, to, insert: c.name }, ...(ins ? [ins] : [])],
          selection: { anchor: from + c.name.length + shift },
        });
      },
    }));
    return { from: word.from, options, validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
  };
}

/** Completion extensions for one editor: word completion everywhere, plus
 * keyword + tree auto-import sources for Java/Kotlin. (Ctrl+Space is already
 * bound by basicSetup's completion keymap.) */
export function completionExts(path: string, project: string | null): Extension[] {
  const exts: Extension[] = [globalSource(completeAnyWord)];
  const java = /\.java$/i.test(path);
  const kotlin = /\.kts?$/i.test(path);
  if (java || kotlin) {
    const kws = kwOptions(java ? JAVA_KEYWORDS : KOTLIN_KEYWORDS);
    exts.push(
      globalSource((ctx) => {
        const word = ctx.matchBefore(/[a-z]{2,}/);
        if (!word) return null;
        return { from: word.from, options: kws, validFor: /^[a-z]*$/ };
      }),
    );
    if (project) exts.push(globalSource(classSource(project, kotlin)));
  }
  return exts;
}
