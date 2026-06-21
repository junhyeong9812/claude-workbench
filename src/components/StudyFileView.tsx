import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { useAppStore } from "../state/store";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";

/** Read-only CodeMirror view of one file for a study viewer tab (theme-aware). */
export function StudyFileView({ path }: { path: string }) {
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
        if (!cancelled) setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "읽기 실패"));
      });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [path, theme]);

  if (err) return <div className="study-view-err">{err}</div>;
  return <div className="study-view-body" ref={hostRef} />;
}
