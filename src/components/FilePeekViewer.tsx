import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { useAppStore } from "../state/store";
import { langFor, fileName } from "./cmLang";
import { cmThemeExt } from "./cmTheme";

/**
 * Read-only file peek viewer (P1): a CodeMirror 6 editor in read-only mode that
 * shows the file at `path`, syntax-highlighted by extension. Opens as an overlay
 * over the main area; the folder tree drives which file it shows (Enter to open,
 * ↑/↓ to follow). `Esc` closes it; `Ctrl+E` opens it in the editor (P2).
 */
export function FilePeekViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const theme = useAppStore((s) => s.theme);
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
              cmThemeExt(theme),
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
  }, [path, theme]);

  return (
    <div
      className="peek-viewer"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.ctrlKey && (e.key === "e" || e.key === "E")) {
          e.preventDefault();
          e.stopPropagation();
          requestEditorOpen(path);
          onClose();
        }
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{fileName(path)}</span>
        <span className="peek-path">{path}</span>
        <span className="peek-hint">Esc 닫기 · Ctrl+E 에디터로 열기</span>
        <span className="peek-x" title="닫기 (Esc)" onClick={onClose}>
          ×
        </span>
      </div>
      {err ? <div className="peek-err">{err}</div> : <div className="peek-body" ref={hostRef} />}
    </div>
  );
}
