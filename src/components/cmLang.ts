import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { kotlin } from "@codemirror/legacy-modes/mode/clike";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";

/** A CodeMirror language extension for a path's extension (empty if unknown).
 * Shared by the read-only peek viewer and the editor. */
export function langFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: ext === "jsx" })];
    case "py":
      return [python()];
    case "rs":
      return [rust()];
    case "java":
      return [java()];
    case "kt":
    case "kts":
      // No official CM6 package for Kotlin — the legacy clike stream mode gives
      // solid highlighting (smart indent is weaker than the Lezer grammars).
      return [StreamLanguage.define(kotlin)];
    case "json":
      return [json()];
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    case "md":
    case "markdown":
      return [markdown()];
    default:
      return [];
  }
}

/** Last path segment, for tab/title display. */
export const fileName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
