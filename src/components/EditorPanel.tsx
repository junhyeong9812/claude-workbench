import { useEffect, useRef, useState } from "react";
import { errText } from "../utils/error";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { langFor, fileName } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { useAppStore } from "../state/store";

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
  const themeComp = useRef(new Compartment());

  // Switch the CodeMirror theme live when the app theme changes.
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(cmThemeExt(theme)) });
  }, [theme]);

  // Focus the editor whenever this panel becomes active (covers reopening an
  // already-open file via Ctrl+E — the panel is re-activated, not recreated).
  useEffect(() => {
    const d = props.api.onDidActiveChange(() => {
      if (props.api.isActive) viewRef.current?.focus();
    });
    return () => d.dispose();
  }, [props.api]);

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
          `저장 실패: ${errText(e)}`,
        ),
      );
    return true;
  };
  // Keep a stable ref so the CodeMirror keymap calls the latest `save`.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Dev mode 확인: save the file, then ask the project's dev Claude session to
  // review it (typos, missing imports, indentation/format, context) — review
  // only, no edits (the user is the writer). Save is awaited so Claude reads the
  // flushed file, not stale bytes.
  const [reviewing, setReviewing] = useState(false);
  const confirmReview = async () => {
    const view = viewRef.current;
    if (!view || !path) return;
    const content = view.state.doc.toString();
    const savedVersion = versionRef.current;
    setReviewing(true);
    try {
      await invoke("write_file", { path, content });
      if (versionRef.current === savedVersion) setDirty(false);
      setStatus("저장됨 — Claude 검토 요청");
    } catch (e) {
      setStatus(`저장 실패: ${errText(e)}`);
      setReviewing(false);
      return;
    }
    const project = useAppStore.getState().activeProject;
    if (project) {
      const prompt =
        `방금 \`${path}\` 를 편집·저장했어. 그 파일을 읽고 검토해줘 — ` +
        `오타·빠진 import·들여쓰기/포맷·맥락 적합성 위주로. ` +
        `직접 수정하지 말고 무엇을 어떻게 고치면 되는지 지적·설명만 해줘.`;
      useAppStore.getState().requestDevReview({ project, prompt, editorPanelId: props.api.id });
    }
    setReviewing(false);
  };

  // Generate a unit test mirroring this source file: compute the conventional
  // test path (backend), then ask the dev Claude session to create it there.
  // An explicit generation action (Claude writes the test), unlike 확인 (review).
  const genTest = async () => {
    if (!path) return;
    const project = useAppStore.getState().activeProject;
    if (!project) return;
    let testPath: string | null = null;
    try {
      testPath = await invoke<string | null>("mirror_test_path", { src: path });
    } catch {
      /* unsupported language → let Claude pick the path */
    }
    const where = testPath ? `\`${testPath}\` 에` : "프로젝트 컨벤션에 맞는 위치에";
    const prompt =
      `\`${path}\` 의 단위 테스트를 ${where} 생성해줘. ` +
      `프로젝트의 기존 테스트 컨벤션·프레임워크를 따르고, 파일을 실제로 만들어줘(필요하면 디렉토리도). ` +
      `핵심 동작·경계조건 위주로.`;
    useAppStore.getState().requestDevReview({ project, prompt, editorPanelId: props.api.id });
  };

  useEffect(() => {
    if (!path) {
      setErr("열 파일이 없습니다");
      return;
    }
    let cancelled = false;
    setErr(null);
    // Editor cap: only files small enough to edit comfortably (512KB). Bigger
    // files are view-only — the backend errors here and we point to the viewer.
    invoke<string>("acp_read_file", { path, maxBytes: 512 * 1024 })
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        viewRef.current = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup, // bracket close, indent-on-input, bracket matching, etc.
              themeComp.current.of(cmThemeExt(useAppStore.getState().theme)),
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
        // Ctrl+E should land the cursor in the editor, not just open the tab.
        viewRef.current.focus();
      })
      .catch((e) => {
        if (!cancelled) {
          const msg = errText(e, "읽기 실패");
          setErr(`이 파일은 에디터로 열 수 없습니다 — ${msg} (트리에서 Enter로 뷰어로 보세요).`);
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
        <button
          className="editor-review"
          title="저장하고 Claude에게 검토 요청 (오타·import·들여쓰기·맥락 — 지적만)"
          onClick={() => void confirmReview()}
          disabled={!path || reviewing}
        >
          {reviewing ? "검토 요청 중…" : "✓ 확인 (Claude 검토)"}
        </button>
        <button
          className="editor-review"
          title="이 파일의 단위 테스트를 미러 경로에 Claude가 생성"
          onClick={() => void genTest()}
          disabled={!path}
        >
          🧪 테스트 생성
        </button>
      </div>
      {err ? <div className="editor-err">{err}</div> : <div className="editor-body" ref={hostRef} />}
    </div>
  );
}
