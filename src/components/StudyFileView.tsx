import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { useAppStore } from "../state/store";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";

const isMarkdown = (p: string): boolean => /\.(md|markdown|mdx)$/i.test(p);
const isImage = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(p);
const isPdf = (p: string): boolean => /\.pdf$/i.test(p);

/** Rendered-markdown viewer (viewer mode only). */
function MarkdownView({ path }: { path: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<string>("acp_read_file", { path })
      .then((text) => {
        // marked is not a sanitizer — purify before injecting (codex SF-2).
        if (!cancelled) setHtml(DOMPurify.sanitize(marked.parse(text, { async: false }) as string));
      })
      .catch((e) => {
        if (!cancelled) setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "읽기 실패"));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (err) return <div className="study-view-err">{err}</div>;
  if (html == null) return <div className="study-md study-md-loading">불러오는 중…</div>;
  return <div className="study-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * CodeMirror view of one file for a study viewer tab. Read-only in viewer mode;
 * in editor mode it is editable with Ctrl+S save (atomic `write_file`).
 */
export function StudyFileView({ path, editable = false }: { path: string; editable?: boolean }) {
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Viewer mode renders markdown as formatted HTML; editor mode edits the source.
  const renderMarkdown = !editable && isMarkdown(path);
  // Images/PDF are always shown as media (not editable as text).
  const renderMedia = isImage(path) || isPdf(path);

  useEffect(() => {
    if (renderMarkdown || renderMedia) return; // CodeMirror not used for rendered/media views

    let cancelled = false;
    let view: EditorView | null = null;
    setErr(null);
    setStatus("");
    invoke<string>("acp_read_file", { path })
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        const exts = [basicSetup, cmThemeExt(theme), ...langFor(path)];
        if (editable) {
          exts.push(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: (v) => {
                  invoke("write_file", { path, content: v.state.doc.toString() })
                    .then(() => {
                      setStatus("저장됨");
                      window.setTimeout(() => setStatus(""), 1500);
                    })
                    .catch((e) =>
                      setStatus(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "저장 실패")),
                    );
                  return true;
                },
              },
            ]),
          );
        } else {
          exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
        }
        view = new EditorView({ parent: hostRef.current, state: EditorState.create({ doc: text, extensions: exts }) });
      })
      .catch((e) => {
        if (!cancelled) setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "읽기 실패"));
      });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [path, theme, editable]);

  if (isImage(path))
    return (
      <div className="study-media">
        <img src={convertFileSrc(path)} alt={path} />
      </div>
    );
  if (isPdf(path)) return <iframe className="study-media-pdf" title={path} src={convertFileSrc(path)} />;
  if (renderMarkdown) return <MarkdownView path={path} />;
  if (err) return <div className="study-view-err">{err}</div>;
  return (
    <>
      <div className="study-view-body" ref={hostRef} />
      {editable && <div className="study-edit-status">{status || "편집 가능 · Ctrl+S 저장"}</div>}
    </>
  );
}
