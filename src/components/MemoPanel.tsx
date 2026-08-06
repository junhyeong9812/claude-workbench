import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";
import { MEMO_SAVE_DELAY, makeAutoSaver } from "../state/projectMemo";

export interface MemoParams {
  kind?: "memo";
  title?: string;
  /** 이 메모가 딸린 프로젝트 경로 (저장 키). */
  project?: string;
}

/**
 * 프로젝트 메모장 — 프로젝트당 롱폼 스크래치 문서 하나.
 *
 * 에디터 구성은 기존 CodeMirror 표면(EditorPanel/StudyFileView)의 최소 조합이다:
 * `basicSetup + cmThemeExt + langFor("memo.md")`. 여기에 `lineWrapping`을 더한다
 * (롱폼 산문에 가로 스크롤은 못 쓴다). **completion/lint는 붙이지 않는다** —
 * 자동완성 소스 둘이 Java/Kotlin 전용이고 트리 인덱스를 위해 프로젝트 전체를
 * 훑으며, lint는 Lezer 에러 + Java import 검사라 마크다운엔 비용만 든다.
 *
 * 저장은 **자동**이다(Ctrl+S 명시 저장인 EditorPanel과 다른 점). 그래서 유실
 * 창을 세 경로로 막는다 — 디바운스 1s + blur + 언마운트 flush. 특히 언마운트가
 * 핵심이다: dockview는 비활성 탭의 패널을 언마운트하므로(onlyWhenVisible) 탭을
 * 전환하면 CodeMirror state가 통째로 사라지고, 디바운스 창 안이었다면 마지막
 * 편집이 증발한다. 규칙과 그 테스트는 `state/projectMemo`가 소유한다.
 */
export function MemoPanel(props: IDockviewPanelProps<MemoParams>) {
  const project = props.params.project;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const themeComp = useRef(new Compartment());

  // Switch the CodeMirror theme live when the app theme changes (EditorPanel 선례).
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(cmThemeExt(theme)) });
  }, [theme]);

  // 탭이 활성화되면 커서를 에디터로 (열자마자 바로 쓸 수 있게).
  useEffect(() => {
    const d = props.api.onDidActiveChange(() => {
      if (props.api.isActive) viewRef.current?.focus();
    });
    return () => d.dispose();
  }, [props.api]);

  useEffect(() => {
    if (!project) {
      setErr("메모를 열 프로젝트가 없습니다");
      return;
    }
    let cancelled = false;
    setErr(null);

    // 저장 실패는 조용히 넘기지 않는다 — 자동 저장은 사용자가 결과를 볼 수 있는
    // 유일한 자리가 상태 줄뿐이다(명시 저장 버튼이 없다).
    const saver = makeAutoSaver<string>((text) => {
      invoke("memo_write", { project, text })
        .then(() => {
          if (!cancelled) setStatus(`저장됨 ${new Date().toLocaleTimeString()}`);
        })
        .catch((e) => {
          if (!cancelled) setStatus(`저장 실패: ${errText(e)}`);
        });
    }, MEMO_SAVE_DELAY);

    invoke<string>("memo_read", { project })
      .then((text) => {
        if (cancelled || !hostRef.current) return;
        viewRef.current = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              themeComp.current.of(cmThemeExt(useAppStore.getState().theme)),
              ...langFor("memo.md"),
              // 롱폼 산문 — 긴 줄은 가로 스크롤 대신 접는다.
              EditorView.lineWrapping,
              // 포커스를 잃는 순간 즉시 저장 (디바운스 창을 기다리지 않는다).
              EditorView.domEventHandlers({
                blur: () => {
                  saver.flush();
                  return false;
                },
              }),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  saver.schedule(u.state.doc.toString());
                  setStatus("편집 중…");
                }
              }),
            ],
          }),
        });
        viewRef.current.focus();
      })
      .catch((e) => {
        if (!cancelled) setErr(`메모를 읽지 못했습니다 — ${errText(e)}`);
      });

    return () => {
      // 언마운트(탭 전환·패널 닫기·프로젝트 전환) — 대기 중인 편집을 먼저 흘려
      // 보내고 나서 뷰를 버린다. 순서가 뒤집히면 destroy가 doc을 가져가 버린다.
      saver.flush();
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [project]);

  return (
    <div className="memo-panel">
      <div className="memo-head">
        <span className="memo-title">메모</span>
        <span className="memo-path">{project}</span>
        <span className="memo-status">{status}</span>
      </div>
      {err ? <div className="memo-err">{err}</div> : <div className="memo-body" ref={hostRef} />}
    </div>
  );
}
