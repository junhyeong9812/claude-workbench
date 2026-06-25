import { useEffect, useRef } from "react";

/**
 * Git history viewer (Phase 1 — layout skeleton). A peek-style overlay over the
 * main area (like FilePeekViewer), NOT a dockview tab. Opened from the Git panel
 * for a repo root. Three regions:
 *   left  — commit history tree (navigable, B-later)
 *   right top    — the selected commit's changed files
 *   right bottom — the focused file's diff
 * Phase 1 lays out the regions with placeholders; commit data, keyboard nav,
 * branch selection, the changed-files command, and diffs land in later phases.
 */
export function GitHistoryViewer(props: { root: string; onClose: () => void }) {
  const base = props.root.split("/").pop() || props.root;
  const ref = useRef<HTMLDivElement>(null);
  // Take focus on open so Esc/keyboard nav work without a click first (peek pattern).
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="git-history-viewer"
      ref={ref}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="git-history-head">
        <span className="git-history-title">📜 {base}</span>
        <span className="git-history-path" title={props.root}>
          {props.root}
        </span>
        <span className="git-history-hint">히스토리 (레이아웃 — 데이터는 다음 단계)</span>
        <span className="git-history-x" title="닫기 (Esc)" onClick={props.onClose}>
          ✕
        </span>
      </div>
      <div className="git-history-body">
        {/* Left: commit history tree */}
        <div className="git-history-commits">
          <div className="git-history-region-head">커밋 히스토리</div>
          <div className="git-history-region-body git-history-placeholder">
            커밋 트리가 여기에 표시됩니다 (↑/↓로 탐색 — 다음 단계)
          </div>
        </div>
        {/* Right: changed files (top) + diff (bottom) */}
        <div className="git-history-right">
          <div className="git-history-files">
            <div className="git-history-region-head">변경 파일</div>
            <div className="git-history-region-body git-history-placeholder">
              선택한 커밋의 변경 파일이 여기에 표시됩니다
            </div>
          </div>
          <div className="git-history-diff">
            <div className="git-history-region-head">파일 diff</div>
            <div className="git-history-region-body git-history-placeholder">
              변경 파일을 선택하면 diff가 여기에 표시됩니다
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
