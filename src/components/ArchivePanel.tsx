import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";

/**
 * Archive browser (관찰 → 아카이브 전환 P3): the sidebar tree of archived
 * sessions, grouped by project, each folder named 날짜-요약슬러그-uuid8. A
 * session's 책(book.html) opens in the system browser (self-contained HTML);
 * its 요약/지식 INDEX open in the in-app peek viewer (markdown).
 */
interface ArchiveEntry {
  dir: string;
  book_path: string;
  summary_path?: string | null;
  uuid: string;
  title: string;
  date: string;
  turns: number;
}
interface ArchiveGroup {
  project: string;
  index_path?: string | null;
  sessions: ArchiveEntry[];
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function ArchivePanel() {
  const [groups, setGroups] = useState<ArchiveGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setPeekFile = useAppStore((s) => s.setPeekFile);
  const archiveRoot = useAppStore((s) => s.archiveRoot);
  const setArchiveRoot = useAppStore((s) => s.setArchiveRoot);

  const load = () => {
    setError(null);
    invoke<ArchiveGroup[]>("archive_list")
      .then(setGroups)
      .catch((e) => setError(errText(e)));
  };
  useEffect(load, []);
  // 아카이브 완료(ClaudeTermPanel) 시 즉시 반영 — 탭이 이미 열려 있어도 새 세션이
  // 수동 새로고침 없이 나타난다.
  useEffect(() => {
    window.addEventListener("mt-archive-updated", load);
    return () => window.removeEventListener("mt-archive-updated", load);
  }, []);

  // 저장 경로 변경(기본 = 앱 데이터 폴더). 빈 값 = 기본으로 복귀. 절대 경로만
  // 허용하고, 저장 완료를 기다린 뒤 재조회한다(새 루트로 읽기 보장).
  const changeRoot = () => {
    const next = window.prompt(
      "아카이브 저장 경로 — 절대 경로 (비우면 기본: 앱 데이터 폴더/archive)",
      archiveRoot ?? "",
    );
    if (next === null) return; // 취소
    const trimmed = next.trim();
    if (trimmed !== "" && !trimmed.startsWith("/")) {
      alert("절대 경로(/로 시작)만 사용할 수 있습니다.");
      return;
    }
    void setArchiveRoot(trimmed === "" ? null : trimmed).then(load);
  };

  const toggle = (project: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });

  const openExternal = (path: string) => {
    invoke("archive_open_path", { path }).catch((e) => alert(`열기 실패: ${errText(e)}`));
  };

  return (
    <div className="archive-panel">
      <div className="archive-head">
        <span>세션 아카이브</span>
        <span className="archive-head-actions">
          <button
            className="archive-btn"
            title={`저장 경로 변경 (현재: ${archiveRoot ?? "기본 — 앱 데이터 폴더/archive"})`}
            onClick={changeRoot}
          >
            경로
          </button>
          <button className="archive-refresh" title="다시 읽기" onClick={load}>
            ↻
          </button>
        </span>
      </div>
      {error && <div className="archive-error">{error}</div>}
      {!error && groups.length === 0 && (
        <div className="archive-empty">
          아직 아카이브가 없습니다.
          <br />
          Claude 세션의 <b>종료(아카이브)</b> 버튼으로 만듭니다.
        </div>
      )}
      <div className="archive-list">
        {groups.map((g) => {
          const closed = collapsed.has(g.project);
          return (
            <div key={g.project} className="archive-project">
              <div
                className="archive-project-head"
                title={g.project}
                onClick={() => toggle(g.project)}
              >
                <span className="timeline-date-caret">{closed ? "▸" : "▾"}</span>{" "}
                {baseName(g.project)}
                <span className="archive-count">{g.sessions.length}</span>
                {g.index_path && (
                  <button
                    className="archive-btn"
                    title="지식 인덱스 보기 (issues/methods/domain)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPeekFile(g.index_path!);
                    }}
                  >
                    지식
                  </button>
                )}
              </div>
              {!closed &&
                g.sessions.map((s) => (
                  <div key={s.uuid} className="archive-session" title={`${s.title}\n${s.dir}`}>
                    <div className="archive-session-title">{s.title}</div>
                    <div className="archive-session-meta">
                      <span>
                        {s.date} · {s.turns} turns
                      </span>
                      <span className="archive-session-actions">
                        <button
                          className="archive-btn"
                          title="책(book.html)을 시스템 브라우저로 열기 — 처음부터 단계별 넘겨보기"
                          onClick={() => openExternal(s.book_path)}
                        >
                          책
                        </button>
                        <button
                          className="archive-btn"
                          title={s.summary_path ? "세션 요약 보기" : "요약 없음 (추출 실패/생략)"}
                          disabled={!s.summary_path}
                          onClick={() => s.summary_path && setPeekFile(s.summary_path)}
                        >
                          요약
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
