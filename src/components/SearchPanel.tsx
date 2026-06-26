import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ContentHit, FileHit } from "../types";

type Mode = "files" | "content";

/**
 * Project-wide search overlay (opened with Ctrl+F). Two modes toggled in place:
 *  - **파일명**: match the query against every path (glob if it has `*?[`, else
 *    a case-insensitive substring).
 *  - **내용**: literal, case-insensitive grep across file contents.
 * Both honor `.gitignore` (handled in the Rust `search_*` commands). Selecting a
 * result opens it in the file peek viewer (content hits jump to the line).
 */
export function SearchPanel({
  root,
  onClose,
  onOpen,
}: {
  root: string;
  onClose: () => void;
  onOpen: (path: string, line?: number) => void;
}) {
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [content, setContent] = useState<ContentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input as soon as the panel mounts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search whenever the query or mode changes. A stale request can't
  // clobber a newer one: we tag each run and ignore results from outdated runs.
  const runId = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFiles([]);
      setContent([]);
      setLoading(false);
      return;
    }
    const id = ++runId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        if (mode === "files") {
          const hits = await invoke<FileHit[]>("search_files", { root, query: q });
          if (runId.current === id) setFiles(hits);
        } else {
          const hits = await invoke<ContentHit[]>("search_content", { root, query: q });
          if (runId.current === id) setContent(hits);
        }
      } catch (err) {
        console.error("search failed", err);
        if (runId.current === id) {
          setFiles([]);
          setContent([]);
        }
      } finally {
        if (runId.current === id) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, mode, root]);

  // Reset the highlighted row when the result set changes.
  const count = mode === "files" ? files.length : content.length;
  useEffect(() => {
    setSel(0);
  }, [mode, query, count]);

  const openAt = (i: number) => {
    if (mode === "files") {
      const hit = files[i];
      if (hit && !hit.is_dir) onOpen(hit.path);
    } else {
      const hit = content[i];
      if (hit) onOpen(hit.path, hit.line);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, count - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openAt(sel);
    }
  };

  const placeholder = mode === "files" ? "파일명 (예: store.ts, *.rs)" : "파일 내용 검색";
  const hint = useMemo(
    () =>
      loading
        ? "검색 중…"
        : query.trim()
          ? `${count}건${count >= 500 ? "+ (상위 500)" : ""}`
          : "",
    [loading, query, count],
  );

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="search-head">
          <div className="search-modes">
            <button
              className={`search-mode ${mode === "files" ? "active" : ""}`}
              onClick={() => setMode("files")}
            >
              파일명
            </button>
            <button
              className={`search-mode ${mode === "content" ? "active" : ""}`}
              onClick={() => setMode("content")}
            >
              내용
            </button>
          </div>
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
          />
          <span className="search-count">{hint}</span>
          <span className="search-x" title="닫기 (Esc)" onClick={onClose}>
            ×
          </span>
        </div>

        <div className="search-results">
          {mode === "files"
            ? files.map((h, i) => (
                <div
                  key={h.path}
                  className={`search-row ${i === sel ? "sel" : ""} ${h.is_dir ? "is-dir" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => openAt(i)}
                >
                  <span className="search-row-icon">{h.is_dir ? "📁" : "📄"}</span>
                  <span className="search-row-path">{h.rel}</span>
                </div>
              ))
            : content.map((h, i) => (
                <div
                  key={`${h.path}:${h.line}:${i}`}
                  className={`search-row ${i === sel ? "sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => openAt(i)}
                >
                  <span className="search-row-loc">
                    {h.rel}:{h.line}
                  </span>
                  <span className="search-row-text">{h.text}</span>
                </div>
              ))}
          {!loading && query.trim() && count === 0 && (
            <div className="search-empty">결과 없음</div>
          )}
        </div>

        <div className="search-foot">↑↓ 이동 · Enter 열기 · Esc 닫기</div>
      </div>
    </div>
  );
}
