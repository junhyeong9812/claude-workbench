/** One Claude session's change timeline (B3/B4). The right side of a Claude
 * tab splits into a **list (top)** of every tool call grouped by turn, and a
 * **viewer (bottom)** that shows the clicked item's content — a file diff
 * (이전→이후) for edits, the written/output text, or, for a read, the file
 * itself (fetched on demand). Presentational; the owning ClaudePanel feeds it
 * the items/turns it accumulated for *its* session. */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TimelineItem {
  turn: number;
  session_id: string;
  tool_call_id: string;
  seq: number;
  kind: string;
  title: string;
  locations: string[];
  project_label: string | null;
  diffs: { path: string; old_text: string | null; new_text: string }[];
  content_text: string | null;
  raw_input: unknown;
  agent_status: string;
  write_status: string;
  revision: number;
}

const KIND_ICON: Record<string, string> = {
  read: "📖",
  edit: "✎",
  delete: "🗑",
  move: "↪",
  search: "🔍",
  execute: "▶",
  think: "💭",
  fetch: "🌐",
  other: "•",
};

const AGENT_BADGE: Record<string, string> = {
  pending: "…",
  in_progress: "▶",
  completed: "✓",
  failed: "✗",
  canceled: "⊘",
};

export function TimelineView({
  items,
  turns,
  answers,
}: {
  items: TimelineItem[];
  turns: Map<number, string>;
  answers: Map<number, string>;
}) {
  // The item whose content is shown in the bottom viewer (B4).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Every turn shows, even one with no tool calls (a plain Q&A): derive the
  // turn list from the union of prompts, answers, and items (B3).
  const turnNos = [
    ...new Set<number>([...turns.keys(), ...answers.keys(), ...items.map((it) => it.turn)]),
  ].sort((a, b) => a - b);

  const selected = items.find((it) => it.tool_call_id === selectedId) ?? null;

  return (
    <div className="timeline-wrap">
      <div className="timeline-list">
        {turnNos.length === 0 && (
          <div className="timeline-empty">Claude에게 질문하면 여기에 쌓입니다.</div>
        )}
        {turnNos.map((turn) => {
          const turnItems = items.filter((it) => it.turn === turn).sort((a, b) => a.seq - b.seq);
          const prompt = turns.get(turn);
          const answer = answers.get(turn);
          return (
            <div key={turn} className="timeline-turn">
              <div className="timeline-turn-head" title={prompt ?? ""}>
                <span className="timeline-turn-q">Q{turn}</span>
                {prompt ?? "(질문)"}
              </div>
              {answer && (
                <div className="timeline-answer" title={answer}>
                  {answer.length > 140 ? `${answer.slice(0, 140)}…` : answer}
                </div>
              )}
              {turnItems.map((it) => (
                <div
                  key={it.tool_call_id}
                  className={`timeline-item ts-${it.agent_status} ${
                    selectedId === it.tool_call_id ? "timeline-item-sel" : ""
                  }`}
                  title={it.locations.join("\n")}
                  onClick={() => setSelectedId(it.tool_call_id)}
                >
                  <span className="timeline-icon">{KIND_ICON[it.kind] ?? "•"}</span>
                  <span className="timeline-title">{it.title || it.kind}</span>
                  {it.project_label && <span className="timeline-label">{it.project_label}</span>}
                  {it.diffs.length > 0 && <span className="timeline-diff">±{it.diffs.length}</span>}
                  {it.write_status === "written" && <span className="timeline-write">💾</span>}
                  {it.write_status === "write_failed" && (
                    <span className="timeline-write timeline-write-fail">⚠</span>
                  )}
                  <span className={`timeline-status ts-${it.agent_status}`}>
                    {AGENT_BADGE[it.agent_status] ?? ""}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="timeline-viewer">
        {selected ? (
          <ItemDetail item={selected} />
        ) : (
          <div className="timeline-viewer-empty">
            타임라인 항목을 클릭하면 변경 내용·파일이 여기에 표시됩니다.
          </div>
        )}
      </div>
    </div>
  );
}

/** The viewer body for the selected item (B4): the tool input (명령/경로), file
 * diffs (이전→이후), its text content (read result, output, 작성 내용), and — for
 * a read with no inline content — the file itself, fetched on demand. */
function ItemDetail({ item }: { item: TimelineItem }) {
  const rawInput = item.raw_input != null ? JSON.stringify(item.raw_input, null, 2) : null;
  const firstPath = item.locations[0] ?? null;
  const hasContent = item.content_text != null && item.content_text !== "";
  // A read (or any location-only item) with no diff/content: show the file.
  const needsFile = item.diffs.length === 0 && !hasContent && firstPath != null;

  const [fileText, setFileText] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFileText(null);
    setFileErr(null);
    if (needsFile && firstPath) {
      invoke<string>("acp_read_file", { path: firstPath })
        .then((t) => {
          if (!cancelled) setFileText(t);
        })
        .catch((e) => {
          if (!cancelled) setFileErr(typeof e === "string" ? e : (e?.message ?? "읽기 실패"));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [item.tool_call_id, needsFile, firstPath]);

  return (
    <div className="timeline-detail">
      <div className="timeline-detail-head">
        {KIND_ICON[item.kind] ?? "•"} {item.title || item.kind}
      </div>
      {rawInput != null && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">입력</div>
          <pre className="timeline-detail-text">{rawInput}</pre>
        </div>
      )}
      {item.diffs.map((d, i) => (
        <div key={i} className="timeline-diff-block">
          <div className="timeline-detail-path">{d.path}</div>
          {d.old_text != null && d.old_text !== "" && (
            <pre className="timeline-diff-old">{d.old_text}</pre>
          )}
          <pre className="timeline-diff-new">{d.new_text}</pre>
        </div>
      ))}
      {hasContent && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-label">내용</div>
          <pre className="timeline-detail-text">{item.content_text}</pre>
        </div>
      )}
      {needsFile && (
        <div className="timeline-diff-block">
          <div className="timeline-detail-path">{firstPath}</div>
          {fileText != null && <pre className="timeline-detail-text">{fileText}</pre>}
          {fileErr != null && <div className="timeline-detail-empty">{fileErr}</div>}
          {fileText == null && fileErr == null && (
            <div className="timeline-detail-empty">불러오는 중…</div>
          )}
        </div>
      )}
    </div>
  );
}
