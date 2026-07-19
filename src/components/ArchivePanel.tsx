import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";

/** 추출 모델 선택지 — claude CLI에 목록 명령이 없어 별칭을 큐레이션한다.
 * "custom"은 자유 입력(전체 모델명 등). null(기본) = opus. */
const MODEL_CHOICES = ["opus", "sonnet", "haiku"] as const;
const EFFORT_CHOICES = ["xhigh", "high", "medium", "low"] as const;

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
  const archiveModel = useAppStore((s) => s.archiveModel);
  const archiveEffort = useAppStore((s) => s.archiveEffort);
  const setArchiveExtraction = useAppStore((s) => s.setArchiveExtraction);
  // 설정 폼 (열려 있을 때만 로컬 편집값 유지; 저장 시 store로 확정).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [formRoot, setFormRoot] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formEffort, setFormEffort] = useState("");

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

  // 설정 폼 열기: 현재 store 값을 편집 버퍼로 복사.
  const openSettings = () => {
    setFormRoot(archiveRoot ?? "");
    setFormModel(archiveModel ?? "");
    setFormEffort(archiveEffort ?? "");
    setSettingsOpen(true);
  };

  // 저장: 경로는 절대 경로만(빈 값 = 기본), 모델/effort 빈 값 = 기본(opus/xhigh).
  // 저장 완료를 기다린 뒤 재조회한다(새 루트로 읽기 보장).
  const saveSettings = () => {
    const root = formRoot.trim();
    if (root !== "" && !root.startsWith("/")) {
      alert("경로는 절대 경로(/로 시작)만 사용할 수 있습니다.");
      return;
    }
    void Promise.all([
      setArchiveRoot(root === "" ? null : root),
      setArchiveExtraction(formModel, formEffort),
    ]).then(() => {
      setSettingsOpen(false);
      load();
    });
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
            title={`아카이브 설정 (경로: ${archiveRoot ?? "기본"} · 모델: ${archiveModel ?? "opus"} · effort: ${archiveEffort ?? "xhigh"})`}
            onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
          >
            설정
          </button>
          <button className="archive-refresh" title="다시 읽기" onClick={load}>
            ↻
          </button>
        </span>
      </div>
      {settingsOpen && (
        <div className="archive-settings">
          <label className="archive-settings-row">
            <span>경로</span>
            <input
              value={formRoot}
              placeholder="기본: 앱 데이터 폴더/archive"
              spellCheck={false}
              onChange={(e) => setFormRoot(e.target.value)}
            />
          </label>
          <label className="archive-settings-row">
            <span>모델</span>
            <select
              value={MODEL_CHOICES.includes(formModel as (typeof MODEL_CHOICES)[number]) || formModel === "" ? formModel : "custom"}
              onChange={(e) => setFormModel(e.target.value === "custom" ? formModel || " " : e.target.value)}
            >
              <option value="">기본 (opus)</option>
              {MODEL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="custom">직접 입력…</option>
            </select>
          </label>
          {!MODEL_CHOICES.includes(formModel as (typeof MODEL_CHOICES)[number]) && formModel !== "" && (
            <label className="archive-settings-row">
              <span>모델명</span>
              <input
                value={formModel}
                placeholder="예: claude-opus-4-8"
                spellCheck={false}
                onChange={(e) => setFormModel(e.target.value)}
              />
            </label>
          )}
          <label className="archive-settings-row">
            <span>effort</span>
            <select value={formEffort} onChange={(e) => setFormEffort(e.target.value)}>
              <option value="">기본 (xhigh)</option>
              {EFFORT_CHOICES.map((ef) => (
                <option key={ef} value={ef}>
                  {ef}
                </option>
              ))}
            </select>
          </label>
          <div className="archive-settings-foot">
            <button className="archive-btn" onClick={() => setSettingsOpen(false)}>
              취소
            </button>
            <button className="archive-btn" onClick={saveSettings}>
              저장
            </button>
          </div>
        </div>
      )}
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
