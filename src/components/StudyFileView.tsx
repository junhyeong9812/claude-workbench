import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { useAppStore } from "../state/store";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";

/**
 * CodeMirror view of one file for a study viewer tab. Read-only in viewer mode;
 * in editor mode it is editable with Ctrl+S save (atomic `write_file`).
 */
export function StudyFileView({ path, editable = false }: { path: string; editable?: boolean }) {
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
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

  if (err) return <div className="study-view-err">{err}</div>;
  return (
    <>
      <div className="study-view-body" ref={hostRef} />
      {editable && <div className="study-edit-status">{status || "편집 가능 · Ctrl+S 저장"}</div>}
    </>
  );
}
