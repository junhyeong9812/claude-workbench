import { useEffect, useRef, useState, type ReactNode } from "react";
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
  registerMemoSaver,
  stashMemo,
  takeStash,
  type AutoSaver,
} from "../state/projectMemo";

/** 편집 잠금 확장 — 키 입력과 프로그램 편집을 둘 다 막는다. */
const readOnlyExts = (ro: boolean) =>
  ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];

/** 메모 읽기의 반환 — 본문 + 낙관적 잠금 base(파일 없으면 null). */
export interface MemoDoc {
  text: string;
  hash: string | null;
}

/** 메모 저장의 반환. 충돌은 오류가 아니라 정상 결과다(사용자 선택이 필요). */
export type MemoSaveResult =
  | { status: "saved"; hash: string }
  | { status: "conflict"; hash: string | null };

export interface MemoEditorProps {
  /** 저장 대상의 식별자 — 이 값이 바뀌면 에디터를 다시 만든다. stash(저장 못 한
   * 편집의 임시 보관)의 키이기도 하다. */
  storeKey: string;
  /** 헤더에 보여 줄 부제 (프로젝트 경로 · 세션 설명 등). */
  subtitle?: string;
  /** 헤더 오른쪽 끝에 붙는 버튼들 ([보내기] 등). */
  actions?: ReactNode;
  read: (key: string) => Promise<MemoDoc>;
  write: (key: string, text: string, baseHash: string | null) => Promise<MemoSaveResult>;
  /** 본문이 바뀔 때마다(최초 로드 포함) 호출 — 부모가 현재 본문을 알아야 하는
   * 경우([보내기])의 창구. */
  onText?: (text: string) => void;
  /** 저장 손잡이를 부모에게 넘긴다(언마운트 시 null). */
  onHandle?: (h: MemoHandle | null) => void;
  /** 편집을 잠근다 (본문은 그대로 보인다). 저장기는 그대로 살아 있다 — 잠금은
   * **새 입력을 막는 것**이지 대기 중인 저장을 버리는 것이 아니다. */
  readOnly?: boolean;
  /** 잠긴 이유 — 헤더에 그대로 보여 준다(왜 안 써지는지 모르는 것이 최악). */
  readOnlyNote?: string;
}

/** 부모가 잡을 수 있는 저장 손잡이. */
export interface MemoHandle {
  /**
   * 대기 중인 편집을 지금 저장하고 **성공 여부를 돌려준다**.
   *
   * `flushAllMemos`(창 종료용)와 다른 점이 계약의 전부다: 저기는 개별 실패를
   * 삼키고 타임아웃도 정상 resolve로 끝난다 — 닫기 전에 그걸 기다리면 "저장이
   * 안 됐는데 저장된 줄 알고" 편집 **이전** 본문을 아카이브에 동봉하게 된다
   * (리뷰 #4). 여기서는 flush 뒤에도 값이 dirty로 남아 있으면 `false`다.
   */
  flush(): Promise<boolean>;
}

/**
 * 롱폼 메모 에디터 — **자동 저장과 그 유실 방어선의 단일 출처**.
 *
 * 프로젝트 메모장(`MemoPanel`)과 프롬프트 정리 세션의 초안이 이 컴포넌트를
 * 공유한다. 저장 위치만 다르고(앱 데이터 vs 정리 스크래치) 계약은 글자 그대로
 * 같아야 하기 때문이다 — 복제해 두면 한쪽만 고쳐지는 것이 정확히 유실이 생기는
 * 방식이다.
 *
 * 에디터 구성은 기존 CodeMirror 표면(EditorPanel/StudyFileView)의 최소 조합이다:
 * `basicSetup + cmThemeExt + langFor("memo.md")` + `lineWrapping`(롱폼 산문에
 * 가로 스크롤은 못 쓴다). **completion/lint는 붙이지 않는다** — 자동완성 소스 둘이
 * Java/Kotlin 전용이고 트리 인덱스를 위해 프로젝트 전체를 훑으며, lint는 Lezer
 * 에러 + Java import 검사라 마크다운엔 비용만 든다.
 *
 * 저장은 **자동**이다(Ctrl+S 명시 저장인 EditorPanel과 다른 점). 그래서 유실 창을
 * 세 경로로 막는다 — 디바운스 1s + blur + 언마운트 flush. 특히 언마운트가
 * 핵심이다: dockview는 비활성 탭의 패널을 언마운트하므로(onlyWhenVisible) 탭을
 * 전환하면 CodeMirror state가 통째로 사라지고, 디바운스 창 안이었다면 마지막
 * 편집이 증발한다. 규칙과 그 테스트는 `state/projectMemo`가 소유한다.
 */
export function MemoEditor({
  storeKey,
  subtitle,
  actions,
  read,
  write,
  onText,
  onHandle,
  readOnly,
  readOnlyNote,
}: MemoEditorProps) {
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
  // 편집 잠금은 Compartment로 갈아 끼운다 — 에디터를 다시 만들면 커서·스크롤·
  // 대기 중인 저장이 함께 날아간다.
  const roComp = useRef(new Compartment());
  // 에디터는 본문을 비동기로 읽은 **뒤에** 만들어지므로, 그 시점의 최신 잠금
  // 상태를 ref로 읽는다(생성 인자로 준 prop은 그 사이 낡을 수 있다).
  const readOnlyRef = useRef(!!readOnly);
  readOnlyRef.current = !!readOnly;
  // 낙관적 잠금의 base — 이 편집이 출발한 디스크 해시(파일 없으면 null).
  const baseHashRef = useRef<string | null>(null);
  // 마지막으로 편집된 본문 — 늦게 도착한 저장 성공이 그 뒤의 편집을 clean으로
  // 지워 버리지 않게 하는 판정 기준.
  const latestRef = useRef("");
  // 버튼(덮어쓰기)이 현재 saver에 닿기 위한 손잡이.
  const saverRef = useRef<AutoSaver<string> | null>(null);
  // 최신 콜백을 effect 재실행 없이 부르기 위한 상자 (부모가 인라인 함수를 넘겨도
  // 에디터가 매 렌더 재생성되지 않게 한다).
  const cbRef = useRef({ read, write, onText, onHandle });
  cbRef.current = { read, write, onText, onHandle };

  // Switch the CodeMirror theme live when the app theme changes (EditorPanel 선례).
  const theme = useAppStore((s) => s.theme);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(cmThemeExt(theme)) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: roComp.current.reconfigure(readOnlyExts(!!readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    if (!storeKey) {
      setErr("메모를 열 대상이 없습니다");
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
        res = await cbRef.current.write(storeKey, text, baseHashRef.current);
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
    // 닫기 경로가 "저장됐는가"를 실제로 확인할 수 있는 손잡이 (리뷰 #4).
    cbRef.current.onHandle?.({
      flush: async () => {
        await saver.flush();
        return !saver.pending();
      },
    });
    // 창 종료는 React cleanup을 거치지 않는다 — 닫기 핸들러가 직접 이 저장기를
    // 붙잡을 수 있게 창 레지스트리에 올린다 (리뷰 P1).
    const unregister = registerMemoSaver(saver);

    cbRef.current
      .read(storeKey)
      .then(({ text: diskText, hash }) => {
        if (cancelled || !hostRef.current) return;
        baseHashRef.current = hash;
        // 지난 마운트에서 저장에 실패한 편집이 있으면 되살린다 — 디스크보다 새
        // 내용일 때만(같으면 결국 저장됐거나 무의미하다).
        const stashed = takeStash(storeKey);
        const recovered = stashed !== undefined && stashed !== diskText;
        const text = recovered ? stashed! : diskText;
        latestRef.current = text;
        cbRef.current.onText?.(text);
        viewRef.current = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              themeComp.current.of(cmThemeExt(useAppStore.getState().theme)),
              ...langFor("memo.md"),
              roComp.current.of(readOnlyExts(readOnlyRef.current)),
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
                  cbRef.current.onText?.(next);
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
      unregister();
      cbRef.current.onHandle?.(null);
      const leftover = saver.peek();
      if (leftover !== undefined) stashMemo(storeKey, leftover);
      void saver.flush().then(() => {
        if (!saver.pending()) clearStash(storeKey);
      });
      cancelled = true;
      if (saverRef.current === saver) saverRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, reloads]);

  return (
    <div className="memo-editor">
      <div className="memo-head">
        <span className="memo-title">메모{dirty ? " ●" : ""}</span>
        {subtitle && <span className="memo-path">{subtitle}</span>}
        {readOnly && readOnlyNote && <span className="memo-locked">{readOnlyNote}</span>}
        <span className="memo-status">{status}</span>
        {actions}
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
                clearStash(storeKey);
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
