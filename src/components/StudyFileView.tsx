import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { PdfView } from "./PdfView";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { useAppStore } from "../state/store";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { isMarkdownPath, Markdown } from "./markdown";

const isImage = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(p);
const isPdf = (p: string): boolean => /\.pdf$/i.test(p);
/** Known binary/compiled file types — not previewable as text. */
const isBinary = (p: string): boolean =>
  /\.(class|jar|war|ear|zip|gz|tgz|tar|rar|7z|exe|dll|so|o|a|lib|bin|dat|pyc|pyo|wasm|node|woff2?|ttf|otf|eot|mp[34]|m4a|mov|avi|mkv|wav|flac|ogg|webm|db|sqlite3?|jks|keystore|p12|pfx|kotlin_module|kotlin_builtins)$/i.test(
    p,
  );

/** Rendered-markdown viewer (viewer mode only). Owns the file fetch + loading/error
 * UX; the marked+DOMPurify render is delegated to the shared `Markdown` (media
 * allowed here so local `.md` images show — see `.study-md img` styling). */
function MarkdownView({ path }: { path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<string>("acp_read_file", { path })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "읽기 실패"));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (err) return <div className="study-view-err">{err}</div>;
  if (text == null) return <div className="study-md study-md-loading">불러오는 중…</div>;
  return <Markdown text={text} className="study-md" />;
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
  const renderMarkdown = !editable && isMarkdownPath(path);
  // Images/PDF/binary are shown as media/placeholder, never read as text.
  const renderMedia = isImage(path) || isPdf(path) || isBinary(path);

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
  if (isPdf(path)) return <PdfView path={path} />;
  if (isBinary(path))
    return <div className="study-view-note">바이너리 파일이라 미리볼 수 없습니다.<br />{path.split("/").pop()}</div>;
  if (renderMarkdown) return <MarkdownView path={path} />;
  if (err) return <div className="study-view-note">미리볼 수 없는 파일입니다 (바이너리이거나 읽기 실패).</div>;
  return (
    <>
      <div className="study-view-body" ref={hostRef} />
      {editable && <div className="study-edit-status">{status || "편집 가능 · Ctrl+S 저장"}</div>}
    </>
  );
}
