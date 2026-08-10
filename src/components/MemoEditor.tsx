import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { langFor } from "./cmLang";
import { cmThemeExt } from "./cmTheme";
import { ModelSelect } from "./AgentOptionFields";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";
import {
  defaultMemoPath,
  loadTidyModel,
  normalizeMemoRel,
  saveTidyModel,
  tidyShrank,
} from "../state/memoTools";
import {
  MEMO_SAVE_DELAY,
  clearStash,
  clearUndo,
  getUndo,
  makeAutoSaver,
  registerMemoSaver,
  setUndo,
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
  /** [저장하기]의 기준 디렉토리 (프로젝트 루트의 절대 경로). 주지 않으면 그
   * 버튼을 아예 내지 않는다 — 어디에 저장되는지 모르는 저장 버튼은 위험하다. */
  projectRoot?: string;
}

/** `memo_export`의 결과 — "이미 있다"는 오류가 아니라 확인 턱이 필요한 정상 결과. */
export type MemoExportResult =
  | { status: "saved"; path: string }
  | { status: "exists"; path: string };

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
  projectRoot,
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
  // 비동기 응답이 "지금도 같은 메모인가"를 물을 수 있게 하는 최신 대상.
  const storeKeyRef = useRef(storeKey);
  storeKeyRef.current = storeKey;

  // ---- 툴바([저장하기] · [메모 정리]) ----
  // 자동 저장 경로에는 손대지 않는다: 여기서 본문을 바꿀 때도 CodeMirror
  // 트랜잭션으로 넣어 **평범한 편집과 같은 길**(updateListener → saver.schedule)을
  // 타게 한다. 툴바가 따로 디스크에 쓰면 유실 방어선이 둘로 갈린다.
  //
  // 본문을 실제로 읽어 에디터가 선 뒤에만 툴바를 낸다. 읽기 전(또는 읽기 실패로
  // 에디터가 없을 때)의 "현재 본문"은 빈 문자열이라, 그때 [저장하기]가 눌리면
  // **빈 파일이 멀쩡한 파일을 덮는다** — 자동 저장이 빈 에디터를 안 만드는 이유와
  // 같은 실패 모드다(리뷰 P2-4).
  const [loaded, setLoaded] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // 덮어쓰기 확인 턱 — 값이 있으면 "이미 있다"는 답을 받은 상대 경로다.
  const [overwriteRel, setOverwriteRel] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [tidyModel, setTidyModel] = useState(() => loadTidyModel());
  const [tidyBusy, setTidyBusy] = useState(false);
  const [tidyErr, setTidyErr] = useState<string | null>(null);
  const [tidyResult, setTidyResult] = useState<string | null>(null);
  // 정리 요청의 **세대**. 요청은 수십 초가 걸리고 그 사이 사용자가 다른 메모로
  // 옮겨 가거나 다시 실행할 수 있다 — 늦게 도착한 옛 응답이 지금 화면의
  // 미리보기가 되면, 사용자는 자기가 보고 있는 것이 무엇의 결과인지 알 수 없다.
  const tidyGenRef = useRef(0);
  // 그 요청이 출발할 때의 본문. [적용] 시점에 본문이 달라져 있으면 결과는 이미
  // 낡은 것이라 적용하지 않는다(그 사이의 편집을 통째로 지우게 된다).
  const tidySourceRef = useRef<string | null>(null);
  // 적용 직전 본문 — **1회** 되돌리기의 전부(스택이 아니다). 값의 정본은 모듈
  // 맵(`projectMemo`의 undo)이고 여기 state는 버튼을 그리기 위한 사본이다:
  // 탭 전환으로 이 컴포넌트가 언마운트돼도 되돌릴 길이 남아 있어야 한다.
  const [undoText, setUndoText] = useState<string | null>(() => getUndo(storeKey));
  // [적용]이 넣은 본문. 이후 문서가 이 값과 달라지는 순간이 "일반 편집 시작"이고,
  // 그때 되돌리기를 만료시킨다 — 옛 본문이 그 뒤의 작업을 통째로 지우지 않게.
  const appliedRef = useRef<string | null>(null);
  // updateListener는 에디터를 만들 때 한 번만 묶인다 — 최신 만료 로직을 재생성
  // 없이 부르기 위한 상자.
  const expireUndoRef = useRef<(next: string) => void>(() => {});
  expireUndoRef.current = (next: string) => {
    if (undoText === null) return;
    if (appliedRef.current !== null && next === appliedRef.current) return; // 적용 그 자체
    clearUndo(storeKey);
    appliedRef.current = null;
    setUndoText(null);
  };

  /** 본문을 통째로 갈아 끼운다 (정리 [적용]·[되돌리기]).
   *
   * 잠금 중에는 **우리가** 거절한다 — CodeMirror의 `readOnly`는 편집 명령과
   * contenteditable 입력을 막을 뿐, 프로그램이 직접 넣는 트랜잭션은 그대로
   * 적용된다. 닫는 중(아카이브 동봉 대기)에 본문이 바뀌면 동봉된 것과 화면이
   * 어긋나므로 여기서 막는다. */
  const replaceDoc = (next: string): boolean => {
    const view = viewRef.current;
    if (!view || readOnly) return false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    return true;
  };

  /** 저장 요청 1회. `overwrite`가 false인데 파일이 있으면 아무것도 쓰지 않고
   * 확인 턱으로 돌아온다. */
  const runExport = (rel: string, overwrite: boolean) => {
    if (!projectRoot) return;
    setSaveBusy(true);
    setSaveErr(null);
    invoke<MemoExportResult>("memo_export", {
      root: projectRoot,
      rel,
      text: latestRef.current,
      overwrite,
    })
      .then((res) => {
        if (res.status === "exists") {
          setOverwriteRel(rel);
          return;
        }
        setOverwriteRel(null);
        setSaveOpen(false);
        setNote(`저장됨 → ${rel}`);
      })
      .catch((e) => setSaveErr(errText(e)))
      .finally(() => setSaveBusy(false));
  };

  const submitSave = () => {
    const check = normalizeMemoRel(savePath);
    if (!check.ok) {
      setSaveErr(check.reason);
      setOverwriteRel(null);
      return;
    }
    runExport(check.rel, false);
  };

  const runTidy = () => {
    const gen = ++tidyGenRef.current;
    const key = storeKey;
    const source = latestRef.current;
    tidySourceRef.current = source;
    setTidyBusy(true);
    setTidyErr(null);
    setTidyResult(null);
    saveTidyModel(tidyModel);
    /** 이 응답이 아직 이 화면의 것인가 (세대·대상이 그대로인가). */
    const current = () => tidyGenRef.current === gen && storeKeyRef.current === key;
    invoke<string>("memo_tidy", { text: source, model: tidyModel || null })
      .then((res) => {
        if (!current()) return; // 낡은 응답 — 조용히 버린다
        setTidyResult(res);
      })
      // 실패는 무해하다 — 메모는 그대로고 사유만 남는다.
      .catch((e) => {
        if (!current()) return;
        setTidyErr(errText(e));
      })
      .finally(() => {
        if (current()) setTidyBusy(false);
      });
  };

  const applyTidy = () => {
    if (tidyResult === null) return;
    const before = latestRef.current;
    // 정리를 돌린 뒤 사용자가 이어서 썼다면 이 결과는 그 편집을 모른다 —
    // 적용하면 방금 쓴 글이 통째로 사라진다. 다시 실행하게 한다.
    if (tidySourceRef.current !== null && tidySourceRef.current !== before) {
      setTidyErr("정리 이후 메모가 편집됐습니다 — 다시 실행하세요.");
      setTidyResult(null);
      return;
    }
    if (!replaceDoc(tidyResult)) {
      setTidyErr("지금은 메모를 바꿀 수 없습니다.");
      return;
    }
    setUndo(storeKey, before);
    appliedRef.current = tidyResult;
    setUndoText(before);
    setTidyResult(null);
    setTidyOpen(false);
    setNote("정리 결과를 적용했습니다 — 다음 편집을 시작하기 전까지 [되돌리기]할 수 있습니다");
  };

  const undoTidy = () => {
    if (undoText === null) return;
    if (!replaceDoc(undoText)) return;
    clearUndo(storeKey);
    appliedRef.current = null;
    setUndoText(null);
    setNote("직전 본문으로 되돌렸습니다");
  };

  // 대상이 바뀌면 툴바 상태도 그 메모의 것이 아니다. 되돌리기만은 **버리지 않고
  // 그 메모의 버퍼를 다시 읽는다** — 버퍼는 storeKey별로 살아 있고, 다른 메모의
  // 본문이 이 메모에 부어지는 사고는 키가 갈려 있어 일어나지 않는다.
  useEffect(() => {
    setLoaded(false);
    setSaveOpen(false);
    setSaveErr(null);
    setOverwriteRel(null);
    setNote(null);
    setTidyOpen(false);
    setTidyErr(null);
    setTidyResult(null);
    // 진행 중이던 요청은 이 메모의 것이 아니다 — 세대를 올려 응답을 무효화하고
    // busy도 내린다(내리지 않으면 [정리 실행]이 영영 잠긴다).
    tidyGenRef.current += 1;
    tidySourceRef.current = null;
    setTidyBusy(false);
    appliedRef.current = null;
    setUndoText(getUndo(storeKey));
  }, [storeKey]);

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
    // 에디터를 **다시 만드는 모든 경로**에서 툴바를 내린다. storeKey 변경뿐
    // 아니라 [재시도]·[새로고침](reloads)도 여기로 오는데, 그때 이전 본문이
    // latestRef에 남아 있으면 새 본문이 도착하기 전의 [저장하기]가 **낡은 글**을
    // 파일로 찍어 낸다. 값도 함께 비워 그 창을 없앤다.
    setLoaded(false);
    latestRef.current = "";

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
                  // 적용 뒤 첫 일반 편집 = 되돌리기 만료 (그 뒤의 작업을 옛
                  // 본문이 통째로 지우지 않게).
                  expireUndoRef.current(next);
                }
              }),
            ],
          }),
        });
        viewRef.current.focus();
        // 본문이 손에 들어온 뒤에야 툴바를 낸다 (아래 `loaded` 참조).
        setLoaded(true);
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
        {loaded && projectRoot && (
          <button
            className="memo-tool"
            title="메모를 프로젝트 안의 파일로 저장합니다"
            onClick={() => {
              setSaveErr(null);
              setOverwriteRel(null);
              setNote(null);
              if (!saveOpen) setSavePath(defaultMemoPath());
              setSaveOpen((v) => !v);
            }}
          >
            저장하기
          </button>
        )}
        {loaded && (
          <button
            className="memo-tool"
            title="AI가 메모의 구조·중복만 정리합니다 (내용은 그대로 · 적용 전에 미리 봅니다)"
            onClick={() => {
              setTidyErr(null);
              setNote(null);
              setTidyOpen((v) => !v);
            }}
          >
            정리
          </button>
        )}
        {undoText !== null && (
          <button
            className="memo-tool"
            title="정리 적용 직전의 본문으로 돌아갑니다 — 1회, 다음 편집을 시작하면 사라집니다 (앱을 다시 켜도 사라집니다)"
            onClick={undoTidy}
          >
            되돌리기
          </button>
        )}
        {actions}
      </div>
      {note && <div className="memo-note">{note}</div>}
      {saveOpen && (
        <div className="memo-save">
          <span className="memo-save-root" title={projectRoot}>
            프로젝트 루트 기준
          </span>
          <input
            className="memo-save-path"
            value={savePath}
            spellCheck={false}
            autoFocus
            aria-label="저장할 상대 경로"
            onChange={(e) => {
              setSavePath(e.target.value);
              setSaveErr(null);
              setOverwriteRel(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !saveBusy && overwriteRel === null) submitSave();
              if (e.key === "Escape") setSaveOpen(false);
            }}
          />
          {overwriteRel === null ? (
            <button className="memo-retry" disabled={saveBusy} onClick={submitSave}>
              {saveBusy ? "저장 중…" : "저장"}
            </button>
          ) : (
            <>
              <span className="memo-save-warn">이미 있는 파일입니다</span>
              <button
                className="memo-retry"
                disabled={saveBusy}
                onClick={() => runExport(overwriteRel, true)}
              >
                덮어쓰기
              </button>
            </>
          )}
          <button className="memo-retry" onClick={() => setSaveOpen(false)}>
            취소
          </button>
          {saveErr && <span className="memo-save-err">{saveErr}</span>}
        </div>
      )}
      {tidyOpen && (
        <div className="memo-tidy">
          <div className="memo-tidy-bar">
            <span>모델</span>
            <ModelSelect
              value={tidyModel}
              defaultLabel="CLI 기본"
              ariaLabel="정리에 쓸 모델"
              onChange={setTidyModel}
            />
            <button className="memo-retry" disabled={tidyBusy} onClick={runTidy}>
              {tidyBusy ? "정리 중…" : "정리 실행"}
            </button>
            <button className="memo-retry" onClick={() => setTidyOpen(false)}>
              닫기
            </button>
            {tidyErr && <span className="memo-save-err">정리 실패: {tidyErr}</span>}
          </div>
          {tidyResult !== null && (
            <>
              <div className="memo-tidy-preview">{tidyResult}</div>
              <div className="memo-tidy-foot">
                {tidyShrank(latestRef.current, tidyResult) ? (
                  <span className="memo-tidy-shrink">
                    내용이 크게 줄었습니다 — 절단 가능성. 적용 전에 확인하세요
                  </span>
                ) : (
                  <span className="memo-save-warn">미리보기 — 적용해야 메모가 바뀝니다</span>
                )}
                <button className="memo-retry" disabled={!!readOnly} onClick={applyTidy}>
                  적용
                </button>
                <button className="memo-retry" onClick={() => setTidyResult(null)}>
                  버리기
                </button>
              </div>
            </>
          )}
        </div>
      )}
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
