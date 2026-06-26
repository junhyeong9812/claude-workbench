import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { useAppStore } from "../state/store";
import { langFor, fileName } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { MarkdownText } from "./TimelineView";
import { isMarkdownPath } from "./markdown";
import { handleScrollKey } from "./scrollKeys";
import { useFileText } from "../hooks/useFileText";

/**
 * Read-only file peek viewer (P1): opens as an overlay over the main area; the
 * folder tree drives which file it shows (Enter to open, ↑/↓ to follow). For a
 * markdown file it renders the same 뷰모드 as the change-detail pane (`MarkdownText`
 * — marked+DOMPurify) and `v` toggles to the raw CodeMirror source; other files
 * always show raw source. `Esc` closes; `Ctrl+E` opens it in the editor (P2);
 * `Ctrl+←` returns focus to the tree.
 */
export function FilePeekViewer({
  path,
  onClose,
  line,
}: {
  path: string;
  onClose: () => void;
  /** 1-based line to jump to (content-search result); forces raw source view. */
  line?: number;
}) {
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The viewer renders the text either as markdown (뷰모드) or via CodeMirror
  // (raw), so the text lives in state (the shared read hook), not only in CM.
  const { text, err } = useFileText(path);
  // Markdown files default to 뷰모드 (rendered); `v` toggles to raw. Non-markdown
  // files ignore this and always show the CodeMirror source. A line jump forces
  // raw so the target line is actually visible.
  const [markdown, setMarkdown] = useState(line == null);
  const md = isMarkdownPath(path);
  const showRaw = !md || !markdown;

  // Reset 뷰모드 when the peeked file (or jump target) changes.
  useEffect(() => {
    setMarkdown(line == null);
  }, [path, line]);

  // Build the read-only CodeMirror view only when showing raw source (the host
  // div is only mounted then). Rebuilds on text/path/theme change.
  useEffect(() => {
    if (!showRaw || text == null || !hostRef.current) return;
    const view = new EditorView({
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
    // Jump to the search-result line: select it and center it in view.
    if (line != null) {
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const ln = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: ln.from, head: ln.to },
        effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
      });
    }
    return () => view.destroy();
  }, [showRaw, text, theme, path, line]);

  return (
    <div
      className="peek-viewer"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          // Return focus to the tree so navigation can continue (the peek is an
          // overlay; once closed there's nothing focusable left here).
          document.getElementById("folder-tree")?.focus();
          return;
        }
        if (e.ctrlKey && e.key === "ArrowLeft") {
          // Ctrl+← hands focus back to the tree (mirror of Ctrl+→ in the tree).
          e.preventDefault();
          e.stopPropagation();
          document.getElementById("folder-tree")?.focus();
          return;
        }
        if (e.ctrlKey && (e.key === "e" || e.key === "E")) {
          e.preventDefault();
          e.stopPropagation();
          requestEditorOpen(path);
          onClose();
          return;
        }
        if (md && (e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey) {
          // 뷰모드 ↔ 원본 (same shortcut as the change-detail pane).
          e.preventDefault();
          setMarkdown((v) => !v);
          return;
        }
        // ↑/↓/PageUp/PageDown/Home/End scroll the focused content — the markdown
        // container in 뷰모드, the CodeMirror scroller in raw (mirrors 변경상세).
        const scroller = showRaw
          ? (hostRef.current?.querySelector<HTMLElement>(".cm-scroller") ?? null)
          : bodyRef.current;
        handleScrollKey(e, scroller, { homeEnd: true });
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{fileName(path)}</span>
        <span className="peek-path">{path}</span>
        {md && (
          <button
            className="claudeterm-viewmode-btn"
            title="뷰모드 ↔ 원본 (단축키 v)"
            onClick={() => setMarkdown((v) => !v)}
          >
            {markdown ? "원본 보기" : "뷰모드 보기"}
          </button>
        )}
        <span className="peek-hint">
          {md ? "v 뷰/원본 · " : ""}↑↓ 스크롤 · Ctrl+← 트리 · Esc 닫기 · Ctrl+E 에디터
        </span>
        <span className="peek-x" title="닫기 (Esc)" onClick={onClose}>
          ×
        </span>
      </div>
      {err ? (
        <div className="peek-err">{err}</div>
      ) : showRaw ? (
        <div className="peek-body" ref={hostRef} />
      ) : (
        <div className="peek-body peek-md" ref={bodyRef}>
          {text != null && <MarkdownText text={text} />}
        </div>
      )}
    </div>
  );
}
