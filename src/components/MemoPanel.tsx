import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";
import {
  MEMO_SAVE_DELAY,
  clearStash,
  makeAutoSaver,
  stashMemo,
  takeStash,
  type AutoSaver,
} from "../state/projectMemo";

/** `memo_read`의 반환 — 본문 + 낙관적 잠금 base(파일 없으면 null). */
interface MemoDoc {
  text: string;
  hash: string | null;
}

/** `memo_write`의 반환. 충돌은 오류가 아니라 정상 결과다(사용자 선택이 필요). */
type MemoSaveResult =
  | { status: "saved"; hash: string }
  | { status: "conflict"; hash: string | null };

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
  // 아직 디스크에 못 들어간 편집이 있는가 (저장 실패·충돌 포함).
  const [dirty, setDirty] = useState(false);
  // 다른 창이 먼저 썼다 — 저장이 거부된 상태.
  const [conflict, setConflict] = useState(false);
  // 읽기를 다시 태우는 트리거 (재시도·새로고침 버튼) — effect의 deps라 bump하면
  // 에디터가 디스크 기준으로 다시 만들어진다.
  const [reloads, setReloads] = useState(0);
  const themeComp = useRef(new Compartment());
  // 낙관적 잠금의 base — 이 편집이 출발한 디스크 해시(파일 없으면 null).
  const baseHashRef = useRef<string | null>(null);
  // 마지막으로 편집된 본문 — 늦게 도착한 저장 성공이 그 뒤의 편집을 clean으로
  // 지워 버리지 않게 하는 판정 기준.
  const latestRef = useRef("");
  // 버튼(덮어쓰기)이 현재 saver에 닿기 위한 손잡이.
  const saverRef = useRef<AutoSaver<string> | null>(null);

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
    setConflict(false);

    // 저장 실패는 조용히 넘기지 않는다 — 자동 저장은 사용자가 결과를 볼 수 있는
    // 유일한 자리가 상태 줄뿐이다(명시 저장 버튼이 없다). 그리고 **실패는 반드시
    // reject로 끝난다** — 그래야 saver가 그 값을 dirty로 붙들고 있는다(P2-2).
    const saver = makeAutoSaver<string>(async (text) => {
      let res: MemoSaveResult;
      try {
        res = await invoke<MemoSaveResult>("memo_write", {
          project,
          text,
          baseHash: baseHashRef.current,
        });
      } catch (e) {
        if (!cancelled) setStatus(`저장 실패: ${errText(e)} — 다시 시도합니다`);
        throw e;
      }
      if (res.status === "conflict") {
        // 디스크가 그 사이 바뀌었다. base를 지금 디스크 값으로 갱신해 두면
        // [덮어쓰기]가 곧바로 성공할 수 있다 — 사용자가 막다른 길에 갇히지 않게.
        baseHashRef.current = res.hash;
        if (!cancelled) {
          setConflict(true);
          setStatus("다른 창에서 수정됨 — 저장되지 않았습니다");
        }
        throw new Error("memo conflict");
      }
      baseHashRef.current = res.hash;
      if (!cancelled) {
        setConflict(false);
        setStatus(`저장됨 ${new Date().toLocaleTimeString()}`);
        // 저장 중 새 편집이 들어왔으면 아직 dirty다 (saver의 seq 규칙과 동일).
        if (latestRef.current === text) setDirty(false);
      }
    }, MEMO_SAVE_DELAY);
    saverRef.current = saver;

    invoke<MemoDoc>("memo_read", { project })
      .then(({ text: diskText, hash }) => {
        if (cancelled || !hostRef.current) return;
        baseHashRef.current = hash;
        // 지난 마운트에서 저장에 실패한 편집이 있으면 되살린다 — 디스크보다 새
        // 내용일 때만(같으면 결국 저장됐거나 무의미하다).
        const stashed = takeStash(project);
        const recovered = stashed !== undefined && stashed !== diskText;
        const text = recovered ? stashed! : diskText;
        latestRef.current = text;
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
                  void saver.flush();
                  return false;
                },
              }),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  const next = u.state.doc.toString();
                  latestRef.current = next;
                  saver.schedule(next);
                  setDirty(true);
                  setStatus("편집 중…");
                }
              }),
            ],
          }),
        });
        viewRef.current.focus();
        if (recovered) {
          // 되살린 편집은 아직 디스크에 없다 — 곧바로 저장 큐에 올린다.
          saver.schedule(text);
          setDirty(true);
          setStatus("저장하지 못했던 편집을 복구했습니다");
        }
      })
      .catch((e) => {
        // 읽기 실패 = **에디터를 만들지 않는다**. 빈 에디터를 띄우면 한 글자만
        // 쳐도 그 빈 기반이 멀쩡한 파일을 덮어쓴다 (리뷰 P2-4). 재시도만 준다.
        if (!cancelled) setErr(`메모를 읽지 못했습니다 — ${errText(e)}`);
      });

    return () => {
      // 언마운트(탭 전환·패널 닫기·프로젝트 전환) — 대기 중인 편집을 먼저 흘려
      // 보내고 나서 뷰를 버린다. 순서가 뒤집히면 destroy가 doc을 가져가 버린다.
      //
      // 저장이 실패할 수도 있는데 그때는 알려 줄 화면이 이미 없다. 그래서 값을
      // 먼저 stash에 넣어 두고, 저장이 실제로 성공하면 지운다 (P2-2).
      const leftover = saver.peek();
      if (leftover !== undefined) stashMemo(project, leftover);
      void saver.flush().then(() => {
        if (!saver.pending()) clearStash(project);
      });
      cancelled = true;
      if (saverRef.current === saver) saverRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [project, reloads]);

  return (
    <div className="memo-panel">
      <div className="memo-head">
        <span className="memo-title">메모{dirty ? " ●" : ""}</span>
        <span className="memo-path">{project}</span>
        <span className="memo-status">{status}</span>
      </div>
      {conflict && (
        <div className="memo-conflict">
          <span>이 메모가 다른 창에서 수정됐습니다. 지금 편집분은 아직 저장되지 않았습니다.</span>
          <button
            className="memo-retry"
            title="지금 편집분으로 디스크를 덮어씁니다 (다른 창의 수정은 사라집니다)"
            onClick={() => void saverRef.current?.flush()}
          >
            덮어쓰기
          </button>
          <button
            className="memo-retry"
            title="디스크 내용을 다시 읽어옵니다 (지금 편집분은 버려집니다)"
            onClick={() => {
              if (window.confirm("지금 편집분을 버리고 디스크 내용을 다시 읽을까요?")) {
                if (project) clearStash(project);
                setReloads((n) => n + 1);
              }
            }}
          >
            새로고침
          </button>
        </div>
      )}
      {err ? (
        <div className="memo-err">
          {err}
          <button className="memo-retry" onClick={() => setReloads((n) => n + 1)}>
            재시도
          </button>
        </div>
      ) : (
        <div className="memo-body" ref={hostRef} />
      )}
    </div>
  );
}
