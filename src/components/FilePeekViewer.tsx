import { useEffect, useRef, useState } from "react";
import { errText } from "../utils/error";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { useAppStore } from "../state/store";
import { langFor, fileName } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { MarkdownText } from "./TimelineView";
import { isMarkdownPath } from "./markdown";
import { handleScrollKey } from "./scrollKeys";

/**
 * Read-only file peek viewer (P1): opens as an overlay over the main area; the
 * folder tree drives which file it shows (Enter to open, ↑/↓ to follow). For a
 * markdown file it renders the same 뷰모드 as the change-detail pane (`MarkdownText`
 * — marked+DOMPurify) and `v` toggles to the raw CodeMirror source; other files
 * always show raw source. `Esc` closes; `Ctrl+E` opens it in the editor (P2);
 * `Ctrl+←` returns focus to the tree.
 */
export function FilePeekViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Markdown files default to 뷰모드 (rendered); `v` toggles to raw. Non-markdown
  // files ignore this and always show the CodeMirror source.
  const [markdown, setMarkdown] = useState(true);
  const md = isMarkdownPath(path);
  const showRaw = !md || !markdown;

  // Reset to 뷰모드 when the peeked file changes (follows the tree cursor).
  useEffect(() => {
    setMarkdown(true);
  }, [path]);

  // Read the file text into state — the viewer renders it either as markdown
  // (뷰모드) or via CodeMirror (raw), so the text lives here, not only in CM.
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setText(null);
    invoke<string>("acp_read_file", { path })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(errText(e, "읽기 실패"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

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
    return () => view.destroy();
  }, [showRaw, text, theme, path]);

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
