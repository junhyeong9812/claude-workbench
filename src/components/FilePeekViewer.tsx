import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";

/**
 * Read-only file peek viewer (P1): a CodeMirror 6 editor in read-only mode that
 * shows the file at `path`, syntax-highlighted by extension. Opens as an overlay
 * over the main area; the folder tree drives which file it shows (Enter to open,
 * ↑/↓ to follow). `Esc` closes it.
 */

/** A CodeMirror language extension for a path's extension (empty if unknown). */
function langFor(path: string): Extension[] {
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

const fileName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function FilePeekViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Rebuild the CodeMirror view whenever the path changes (peek follows the tree
  // cursor). The view is read-only — this is a viewer, not the editor (P2).
  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    setErr(null);
    invoke<string>("acp_read_file", { path })
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        view = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              oneDark,
              ...langFor(path),
            ],
          }),
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "읽기 실패"));
        }
      });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [path]);

  return (
    <div
      className="peek-viewer"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{fileName(path)}</span>
        <span className="peek-path">{path}</span>
        <span className="peek-hint">Esc 닫기 · Ctrl+E 에디터(예정)</span>
        <span className="peek-x" title="닫기 (Esc)" onClick={onClose}>
          ×
        </span>
      </div>
      {err ? <div className="peek-err">{err}</div> : <div className="peek-body" ref={hostRef} />}
    </div>
  );
}
