import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { Markdown, isMarkdownPath } from "./markdown";
import { handleScrollKey } from "./scrollKeys";

/** Fixed diff-line metrics for virtualization (must match .diff-line CSS: 18px). */
const LINE_H = 18;
const OVERSCAN = 24;

/** Class for a unified-diff line (mirrors DiffPanel.lineClass). */
function lineClass(l: string): string {
  if (l.startsWith("@@")) return "diff-hunk";
  if (
    l.startsWith("+++") ||
    l.startsWith("---") ||
    l.startsWith("diff ") ||
    l.startsWith("index ") ||
    l.startsWith("new file") ||
    l.startsWith("deleted file") ||
    l.startsWith("rename ") ||
    l.startsWith("similarity ")
  )
    return "diff-meta";
  if (l.startsWith("+")) return "diff-add";
  if (l.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

type Mode = "diff" | "content";

/**
 * Peek-style view of one file in one commit (opened from the commit-files
 * sidebar). Like the change-detail viewer: opens over the main area, closes on
 * Esc/✕. Two modes — the commit's per-file diff (default), or the file's full
 * content at that commit ("원본"); a markdown file renders as HTML or raw.
 * The diff is virtualized (only the visible window of lines is in the DOM) so a
 * huge file diff stays responsive.
 */
export function CommitFileView(props: {
  root: string;
  commit: string;
  path: string;
  onClose: () => void;
}) {
  const { root, commit, path } = props;
  const [mode, setMode] = useState<Mode>("diff");
  const [asHtml, setAsHtml] = useState(true);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const isMd = isMarkdownPath(path);

  // NOTE: intentionally does NOT auto-focus — the commit-files sidebar keeps focus
  // so ↑/↓ keep browsing files (this view updates live). Click this view to focus
  // it (then Esc closes it); while the sidebar holds focus, Esc closes everything.

  // Load diff or content for the current (file, mode). Re-runs when either changes.
  useEffect(() => {
    let alive = true;
    setNote("");
    setText("");
    const cmd = mode === "diff" ? "git_commit_file_diff" : "git_commit_file_content";
    invoke<string>(cmd, { cwd: root, hash: commit, path })
      .then((t) => alive && setText(t))
      .catch((e) => alive && setNote(errText(e)));
    return () => {
      alive = false;
    };
  }, [root, commit, path, mode]);

  // Measure the scroll viewport + reset scroll on new content (so a deep scroll into
  // a previous file can't leave a shorter diff blank — mirrors DiffPanel).
  useEffect(() => {
    setScrollTop(0);
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, mode]);

  const diffLines = useMemo(
    () => (mode === "diff" ? text.split("\n") : []),
    [mode, text],
  );
  const base = path.split("/").pop() || path;

  const end = Math.min(diffLines.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);
  const start = Math.max(0, Math.min(Math.floor(scrollTop / LINE_H) - OVERSCAN, end));

  return (
    <div
      className="commit-file-view"
      ref={ref}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
          return;
        }
        // Ctrl+← : hand focus back to the commit-files sidebar (Ctrl+→ comes here).
        if (e.key === "ArrowLeft" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          document.querySelector<HTMLElement>(".commit-files")?.focus();
          return;
        }
        // ↑/↓/PageUp/PageDown scroll the body so a long file is readable while the
        // view holds focus (the sidebar's ↑/↓ browse files; this view scrolls).
        if (handleScrollKey(e, bodyRef.current)) return;
      }}
    >
      <div className="commit-file-view-head">
        <span className="commit-file-view-title" title={path}>
          {base}
        </span>
        <span className="commit-file-view-sub" title={`${commit}\n${path}`}>
          {commit.slice(0, 8)} · {path}
        </span>
        <span className="commit-file-view-spacer" />
        <button
          className={`git-btn${mode === "diff" ? " active" : ""}`}
          title="이 커밋의 변경 diff"
          onClick={() => setMode("diff")}
        >
          diff
        </button>
        <button
          className={`git-btn${mode === "content" ? " active" : ""}`}
          title="이 커밋 시점의 파일 원본"
          onClick={() => setMode("content")}
        >
          원본
        </button>
        {mode === "content" && isMd && (
          <button
            className="git-btn"
            title={asHtml ? "원본 텍스트로 보기" : "HTML로 보기"}
            onClick={() => setAsHtml((v) => !v)}
          >
            {asHtml ? "txt" : "html"}
          </button>
        )}
        <span className="commit-file-view-x" title="닫기 (Esc)" onClick={props.onClose}>
          ✕
        </span>
      </div>
      <div
        className="commit-file-view-body"
        ref={bodyRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {note && <div className="git-clean">{note}</div>}
        {!note && mode === "diff" && (
          // spacer = total height; only the visible window of lines is rendered.
          <div className="commit-file-diff" style={{ height: diffLines.length * LINE_H, position: "relative" }}>
            <div style={{ position: "absolute", top: start * LINE_H, left: 0, right: 0 }}>
              {diffLines.slice(start, end).map((l, i) => (
                <div key={start + i} className={`diff-line ${lineClass(l)}`}>
                  {l || " "}
                </div>
              ))}
            </div>
          </div>
        )}
        {!note && mode === "content" && isMd && asHtml && (
          <Markdown className="commit-file-md" text={text} blockMedia />
        )}
        {!note && mode === "content" && !(isMd && asHtml) && (
          <pre className="commit-file-raw">{text}</pre>
        )}
      </div>
    </div>
  );
}
