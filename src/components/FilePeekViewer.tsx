import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { useAppStore } from "../state/store";
import { langFor, fileName } from "./cmLang";
import { ViewModeToggle } from "./ViewModeToggle";
import { cmThemeExt } from "./cmTheme";
import { MarkdownText } from "./TimelineView";
import { isMarkdownPath } from "./markdown";
import { handleScrollKey } from "./scrollKeys";
import { useFileText } from "../hooks/useFileText";
import type { DroppedFileView } from "./droppedFiles";

/**
 * Read-only file peek viewer (P1): opens as an overlay over the main area; the
 * folder tree drives which file it shows (Enter to open, ↑/↓ to follow). For a
 * markdown file it renders the same 뷰모드 as the change-detail pane (`MarkdownText`
 * — marked+DOMPurify) and `v` toggles to the raw CodeMirror source; other files
 * always show raw source. `Esc` closes; `Ctrl+E` opens it in the editor (P2);
 * `Ctrl+←` returns focus to the tree.
 *
 * `memory` 소스(작업 영역 OS 드롭 — workarea-drop-view): 디스크 경로 없이
 * 메모리 텍스트/이미지 데이터 URL을 표시한다. 이때 파일 읽기·Ctrl+E(에디터)
 * 는 비활성이고, 여러 파일이면 `tabs`로 전환한다. 완전 읽기 전용.
 */
/** 소스는 디스크 경로 XOR 메모리 콘텐츠 — 둘 다 없거나 둘 다 있는 호출을
 * 타입에서 차단한다(리뷰 W4). 탭 스트립은 메모리(다중 드롭) 분기 전용. */
type PeekSource =
  | { path: string; memory?: undefined; tabs?: undefined }
  | {
      path?: undefined;
      /** 드롭된 파일의 메모리 콘텐츠 (경로 없음 — 읽기 전용 표시만). */
      memory: DroppedFileView;
      /** 다중 드롭 탭 스트립 — 첫 파일 활성, 클릭으로 전환. */
      tabs?: { names: string[]; active: number; onSelect: (i: number) => void };
    };

export function FilePeekViewer({
  path,
  onClose,
  line,
  memory,
  tabs,
}: PeekSource & {
  onClose: () => void;
  /** 1-based line to jump to (content-search result); forces raw source view. */
  line?: number;
}) {
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const theme = useAppStore((s) => s.theme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The viewer renders the text either as markdown (뷰모드) or via CodeMirror
  // (raw), so the text lives in state (the shared read hook), not only in CM.
  // 메모리 소스면 디스크 읽기를 건너뛴다(null path).
  const { text: fileText, err } = useFileText(memory ? null : (path ?? null));
  const text = memory ? (memory.text ?? null) : fileText;
  /** 문법·마크다운 판별 기준 이름 — 디스크 경로 또는 드롭 파일명. */
  const nameForLang = memory ? memory.name : (path ?? "");
  const isImage = memory?.imageUrl != null;
  // Markdown files default to 뷰모드 (rendered); `v` toggles to raw. Non-markdown
  // files ignore this and always show the CodeMirror source. A line jump forces
  // raw so the target line is actually visible.
  const [markdown, setMarkdown] = useState(line == null);
  const md = !isImage && isMarkdownPath(nameForLang);
  const showRaw = !md || !markdown;
  // 이미지 실제 디코드 실패(<img> 로드 실패) 표시 — 탭/소스 전환 시 초기화
  // (리뷰 W2 + 감사: 정상 이미지에 실패 표시가 남지 않게).
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => {
    setImgErr(false);
  }, [memory?.imageUrl]);

  // Reset 뷰모드 when the peeked file (or jump target) changes.
  useEffect(() => {
    setMarkdown(line == null);
  }, [path, line, memory?.name]);

  // Build the read-only CodeMirror view only when showing raw source (the host
  // div is only mounted then). Rebuilds on text/path/theme change.
  useEffect(() => {
    if (isImage || !showRaw || text == null || !hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          cmThemeExt(theme),
          ...langFor(nameForLang),
        ],
      }),
    });
    // Jump to the search-result line: select it and center it in view.
    if (line != null) {
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const ln = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: ln.from, head: ln.to },
        effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
      });
    }
    return () => view.destroy();
  }, [showRaw, text, theme, path, line, isImage, nameForLang]);

  return (
    <div
      className="peek-viewer"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          // Return focus to the tree so navigation can continue (the peek is an
          // overlay; once closed there's nothing focusable left here).
          document.getElementById("folder-tree")?.focus();
          return;
        }
        if (e.ctrlKey && e.key === "ArrowLeft") {
          // Ctrl+← hands focus back to the tree (mirror of Ctrl+→ in the tree).
          e.preventDefault();
          e.stopPropagation();
          document.getElementById("folder-tree")?.focus();
          return;
        }
        if (e.ctrlKey && (e.key === "e" || e.key === "E")) {
          e.preventDefault();
          e.stopPropagation();
          if (path && !memory) {
            // 드롭된 메모리 파일은 디스크 경로가 없다 — 에디터 열기 비활성.
            // P5 경계: 전역 peek 오버레이(앱-전역 단일 인프라) → primary editor.
            // 표면-지역화는 드래그 자유분할(P6)에서 함께.
            requestEditorOpen(path);
            onClose();
          }
          return;
        }
        if (md && (e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey) {
          // 뷰모드 ↔ 원본 (same shortcut as the change-detail pane).
          e.preventDefault();
          setMarkdown((v) => !v);
          return;
        }
        // ↑/↓/PageUp/PageDown/Home/End scroll the focused content — the markdown
        // container in 뷰모드, the CodeMirror scroller in raw (mirrors 변경상세).
        const scroller = showRaw
          ? (hostRef.current?.querySelector<HTMLElement>(".cm-scroller") ?? null)
          : bodyRef.current;
        handleScrollKey(e, scroller, { homeEnd: true });
      }}
    >
      <div className="peek-head">
        <span className="peek-title">{memory ? memory.name : fileName(path ?? "")}</span>
        <span className="peek-path">{memory ? "드롭된 파일 — 읽기 전용" : path}</span>
        {md && <ViewModeToggle markdown={markdown} onToggle={() => setMarkdown((v) => !v)} />}
        <span className="peek-hint">
          {md ? "v 뷰/원본 · " : ""}↑↓ 스크롤 · Ctrl+← 트리 · Esc 닫기
          {memory ? "" : " · Ctrl+E 에디터"}
        </span>
        <span className="peek-x" title="닫기 (Esc)" onClick={onClose}>
          ×
        </span>
      </div>
      {tabs && tabs.names.length > 1 && (
        <div className="peek-tabs">
          {tabs.names.map((n, i) => (
            <button
              key={`${i}:${n}`}
              className={`peek-tab${i === tabs.active ? " peek-tab-active" : ""}`}
              title={n}
              onClick={() => tabs.onSelect(i)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {err ? (
        <div className="peek-err">{err}</div>
      ) : isImage ? (
        <div className="peek-body peek-img-body" ref={bodyRef}>
          {imgErr ? (
            <div className="peek-err">이미지를 표시할 수 없습니다 (손상되었거나 미지원 형식)</div>
          ) : (
            <img
              className="peek-img"
              src={memory!.imageUrl}
              alt={memory!.name}
              onError={() => setImgErr(true)}
            />
          )}
        </div>
      ) : showRaw ? (
        <div className="peek-body" ref={hostRef} />
      ) : (
        <div className="peek-body peek-md" ref={bodyRef}>
          {text != null && <MarkdownText text={text} />}
        </div>
      )}
    </div>
  );
}
