import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { langFor, fileName } from "./cmLang";

export interface EditorParams {
  kind?: "editor";
  title?: string;
  /** Absolute path of the file being edited. */
  path?: string;
}

/**
 * Editor panel (P2): an editable CodeMirror 6 view for one file, hosted as a
 * dockview panel — so multiple files / splits are just dockview panels (IDE-like).
 * `basicSetup` brings bracket auto-close, auto-indent, and bracket matching.
 * `Ctrl+S` (or the button) saves via `write_file`; the tab title shows ● dirty.
 */
export function EditorPanel(props: IDockviewPanelProps<EditorParams>) {
  const path = props.params.path;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  // Bumped on every doc change — captured at save start so a late-resolving save
  // only marks the tab clean if no further edits happened meanwhile (codex P2 E2).
  const versionRef = useRef(0);

  const baseTitle = (props.params.title as string) ?? (path ? fileName(path) : "Editor");

  // Reflect dirty state in the dockview tab title.
  useEffect(() => {
    props.api.setTitle(`${dirty ? "● " : ""}${baseTitle}`);
  }, [dirty, baseTitle, props.api]);

  const save = (): boolean => {
    const view = viewRef.current;
    if (!view || !path) return true;
    const content = view.state.doc.toString();
    const savedVersion = versionRef.current;
    invoke("write_file", { path, content })
      .then(() => {
        // Only mark clean if no edits happened after this save started.
        if (versionRef.current === savedVersion) setDirty(false);
        setStatus("저장됨");
      })
      .catch((e) =>
        setStatus(
          `저장 실패: ${typeof e === "string" ? e : ((e as { message?: string })?.message ?? e)}`,
        ),
      );
    return true;
  };
  // Keep a stable ref so the CodeMirror keymap calls the latest `save`.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!path) {
      setErr("열 파일이 없습니다");
      return;
    }
    let cancelled = false;
    setErr(null);
    invoke<string>("acp_read_file", { path })
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        viewRef.current = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup, // bracket close, indent-on-input, bracket matching, etc.
              oneDark,
              ...langFor(path),
              keymap.of([{ key: "Mod-s", preventDefault: true, run: () => saveRef.current() }]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  versionRef.current++;
                  setDirty(true);
                  setStatus("");
                }
              }),
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
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [path]);

  return (
    <div className="editor-panel">
      <div className="editor-head">
        <span className="editor-title">
          {baseTitle}
          {dirty ? " ●" : ""}
        </span>
        <span className="editor-path">{path}</span>
        <span className="editor-status">{status}</span>
        <button className="editor-save" onClick={() => save()} disabled={!path}>
          저장 (Ctrl+S)
        </button>
      </div>
      {err ? <div className="editor-err">{err}</div> : <div className="editor-body" ref={hostRef} />}
    </div>
  );
}
