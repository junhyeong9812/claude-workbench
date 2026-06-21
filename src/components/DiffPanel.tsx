import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";

/** Fixed line metrics for diff virtualization (must match .diff-line CSS). */
const LINE_H = 18;
const OVERSCAN = 24;

export interface DiffParams {
  kind?: "diff";
  title?: string;
  cwd?: string;
  /** File diff: path (+ staged). */
  path?: string;
  staged?: boolean;
  /** Commit diff: hash. */
  hash?: string;
}

const errText = (e: unknown): string =>
  typeof e === "string" ? e : ((e as { message?: string })?.message ?? "diff 실패");

/** Class for a unified-diff line (color: + green, − red, hunk cyan, meta dim). */
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
    l.startsWith("similarity ") ||
    l.startsWith("commit ") ||
    l.startsWith("Author:") ||
    l.startsWith("Date:")
  )
    return "diff-meta";
  if (l.startsWith("+")) return "diff-add";
  if (l.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

/**
 * Diff viewer panel: renders a unified diff (a changed file, staged or not, or a
 * whole commit via `git show`) with red/green coloring. Opened from the Git panel.
 */
export function DiffPanel(props: IDockviewPanelProps<DiffParams>) {
  const { cwd, path, staged, hash } = props.params;
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  const lines = useMemo(() => (text ? text.split("\n") : []), [text]);

  // Measure the scroll viewport so only visible lines render (large-diff virtualization).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const load = useCallback(() => {
    setText(null);
    setErr(null);
    const p = hash
      ? invoke<string>("git_show", { cwd, hash })
      : invoke<string>("git_diff", { cwd, path, staged: !!staged });
    let cancelled = false;
    p.then((t) => {
      if (!cancelled) setText(t);
    }).catch((e) => {
      if (!cancelled) setErr(errText(e));
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, path, staged, hash]);

  useEffect(() => load(), [load]);

  const start = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + viewH) / LINE_H) + OVERSCAN);

  return (
    <div className="diff-panel">
      <div className="diff-head">
        <span className="diff-title">{props.params.title ?? "diff"}</span>
        <button className="git-btn" title="새로고침" onClick={() => load()}>
          ↻
        </button>
      </div>
      {err ? (
        <div className="diff-empty">{err}</div>
      ) : text === null ? (
        <div className="diff-empty">불러오는 중…</div>
      ) : text.trim() === "" ? (
        <div className="diff-empty">변경 내용이 없습니다.</div>
      ) : (
        <div
          className="diff-body"
          ref={bodyRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {/* spacer = total height; only the visible window is rendered */}
          <div style={{ height: lines.length * LINE_H, position: "relative" }}>
            <div style={{ position: "absolute", top: start * LINE_H, left: 0, right: 0 }}>
              {lines.slice(start, end).map((l, i) => (
                <div key={start + i} className={`diff-line ${lineClass(l)}`}>
                  {l || " "}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
