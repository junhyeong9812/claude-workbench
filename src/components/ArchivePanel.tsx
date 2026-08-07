import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errText } from "../utils/error";
import { fmtUnix } from "../utils/time";
import { useAppStore } from "../state/store";
import { SESSION_DRAG_MIME, encodeSessionDrag } from "./sessionDropZone";
import { EffortSelect, ModelSelect } from "./AgentOptionFields";
import { MODEL_CHOICES } from "../state/agentOptions";

/* 추출 모델/강도 선택지는 새 세션 옵션 팝오버와 **같은 어휘**를 쓴다
 * (`state/agentOptions` → `AgentOptionFields`). 여기서 "custom"은 자유 입력
 * (전체 모델명 등), 빈 값은 기본(모델=opus · 강도=xhigh — 백엔드 archive.rs가
 * 채운다)이다. */

/**
 * Archive browser (관찰 → 아카이브 전환 P3): the sidebar tree of archived
 * sessions, grouped by project, each folder named 날짜-요약슬러그-uuid8. A
 * session's 책(book.html) opens in the system browser (self-contained HTML);
 * its 요약/지식 INDEX open in the in-app peek viewer (markdown).
 */
interface ArchiveHistoryItem {
  book_path: string;
  archived_at?: number | null;
  title: string;
  turns: number;
}
interface ArchiveEntry {
  dir: string;
  book_path: string;
  summary_path?: string | null;
  uuid: string;
  title: string;
  date: string;
  turns: number;
  archived_at?: number | null;
  /** 세션 종류 — 없거나 null이면 일반 작업 세션, "prompt"면 프롬프트 정리 세션. */
  kind?: string | null;
  /** 보존된 과거 버전 (최신순) — 내용이 달라진 재아카이브가 만든 것. */
  history: ArchiveHistoryItem[];
}

/** 종류 필터의 선택지. 값은 `ArchiveEntry.kind`와 맞춘다("" = 전체). */
const KIND_FILTERS = [
  { value: "", label: "전체" },
  { value: "session", label: "세션" },
  { value: "prompt", label: "프롬프트" },
] as const;

/** 이 아카이브의 종류 키 — 라벨이 없는(구·일반) 아카이브는 전부 "세션"이다. */
const kindOf = (s: ArchiveEntry): string => s.kind || "session";
interface ArchiveGroup {
  project: string;
  index_path?: string | null;
  sessions: ArchiveEntry[];
}

import { basename as baseName } from "../utils/path";

export function ArchivePanel() {
  const [groups, setGroups] = useState<ArchiveGroup[]>([]);
  // 드래그 직전 실제로 눌린 요소 — dragstart의 e.target은 draggable 행 자신
  // 이라 내부 버튼 판별이 불가능해 mousedown 캡처로 기록한다 (리뷰 S6 감사).
  const dragPressRef = useRef<EventTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 종류 필터 ("" = 전체). 목록은 전량 메모리라 파생 필터 하나로 충분하다.
  const [kindFilter, setKindFilter] = useState("");
  // 과거 버전 목록이 펼쳐진 세션(uuid)들.
  const [versionsOpen, setVersionsOpen] = useState<Set<string>>(new Set());
  const setPeekFile = useAppStore((s) => s.setPeekFile);
  const requestSessionResume = useAppStore((s) => s.requestSessionResume);
  const archiveRoot = useAppStore((s) => s.archiveRoot);
  const archiveModel = useAppStore((s) => s.archiveModel);
  const archiveEffort = useAppStore((s) => s.archiveEffort);
  const setArchiveConfig = useAppStore((s) => s.setArchiveConfig);
  // 설정 폼 (열려 있을 때만 로컬 편집값 유지; 저장 시 store로 확정).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [formRoot, setFormRoot] = useState("");
  const [formModel, setFormModel] = useState("");
  // "직접 입력…" 상태를 값 센티널이 아니라 별도 플래그로 — 큐레이션 값에서
  // 직접 입력으로 전환이 안 되던 UX 결함 방지 (리뷰 G9).
  const [customModel, setCustomModel] = useState(false);
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
    // 백엔드 브로드캐스트도 수신 — 다른 창에서 실행한 아카이브 완료가 이 창의
    // 목록에도 반영된다 (DOM CustomEvent는 창 로컬이라 못 미침).
    const un = listen("mt-archive-finished", load);
    return () => {
      window.removeEventListener("mt-archive-updated", load);
      void un.then((f) => f());
    };
  }, []);

  // 설정 폼 열기: 현재 store 값을 편집 버퍼로 복사.
  const openSettings = () => {
    setFormRoot(archiveRoot ?? "");
    setFormModel(archiveModel ?? "");
    setCustomModel(
      archiveModel !== null && !MODEL_CHOICES.includes(archiveModel as (typeof MODEL_CHOICES)[number]),
    );
    setFormEffort(archiveEffort ?? "");
    setSettingsOpen(true);
  };

  // 저장: 경로는 절대 경로만(빈 값 = 기본), 모델/effort 빈 값 = 기본(opus/xhigh).
  // 단일 setter로 한 번에 저장(경쟁 없음) + 실패 시 폼을 닫지 않고 알린다.
  const saveSettings = () => {
    const root = formRoot.trim();
    if (root !== "" && !root.startsWith("/")) {
      alert("경로는 절대 경로(/로 시작)만 사용할 수 있습니다.");
      return;
    }
    void setArchiveConfig(root === "" ? null : root, formModel, formEffort).then((saved) => {
      if (!saved) {
        alert("설정 저장에 실패했습니다 — 백엔드 로그를 확인하세요.");
        return;
      }
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

  // 필터를 통과한 목록 — 남는 세션이 없는 프로젝트 그룹은 통째로 감춘다(제목만
  // 남은 빈 그룹은 "여기 뭔가 있다"는 거짓 신호다).
  const shown =
    kindFilter === ""
      ? groups
      : groups
          .map((g) => ({ ...g, sessions: g.sessions.filter((s) => kindOf(s) === kindFilter) }))
          .filter((g) => g.sessions.length > 0);

  return (
    <div className="archive-panel">
      <div className="archive-head">
        <span>세션 아카이브</span>
        <span className="archive-head-actions">
          <select
            className="archive-kind-filter"
            value={kindFilter}
            title="종류로 거르기 — 프롬프트 정리 세션은 닫을 때 '프롬프트'로 남습니다"
            aria-label="아카이브 종류 필터"
            onChange={(e) => setKindFilter(e.target.value)}
          >
            {KIND_FILTERS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
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
            <ModelSelect
              value={customModel ? "custom" : formModel}
              defaultLabel="기본 (opus)"
              allowCustom
              onChange={(v) => {
                if (v === "custom") {
                  setCustomModel(true);
                } else {
                  setCustomModel(false);
                  setFormModel(v);
                }
              }}
            />
          </label>
          {customModel && (
            <label className="archive-settings-row">
              <span>모델명</span>
              <input
                value={formModel}
                placeholder="예: claude-opus-4-8"
                spellCheck={false}
                autoFocus
                onChange={(e) => setFormModel(e.target.value)}
              />
            </label>
          )}
          <label className="archive-settings-row">
            <span>effort</span>
            <EffortSelect
              value={formEffort}
              defaultLabel="기본 (xhigh)"
              onChange={setFormEffort}
            />
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
      {!error && groups.length > 0 && shown.length === 0 && (
        <div className="archive-empty">이 종류의 아카이브가 없습니다.</div>
      )}
      <div className="archive-list">
        {shown.map((g) => {
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
                  <div
                    key={s.uuid}
                    className="archive-session"
                    title={`${s.title}\n${s.dir}\n드래그해서 dock의 원하는 위치에 이어서 열기 (중앙=탭 · 가장자리=스플릿)`}
                    draggable
                    onMouseDownCapture={(e) => {
                      dragPressRef.current = e.target;
                    }}
                    onDragStart={(e) => {
                      // 행 안의 버튼(이어서·버전·책·요약)에서 시작한 드래그는
                      // 취소 — 몇 px 움직인 클릭이 드래그로 승격돼 클릭이
                      // 사라지는 충돌 방지 (S6). dragstart의 e.target은 HTML
                      // DnD 표준상 draggable 행 자신이라 내부 버튼 판별이
                      // 안 되므로 mousedown 캡처로 기록한 요소를 본다(감사).
                      // project 미상 행은 드래그 불가 (S8).
                      const pressed = dragPressRef.current;
                      if (
                        (pressed instanceof HTMLElement &&
                          pressed.closest("button, input, a")) ||
                        !g.project
                      ) {
                        e.preventDefault();
                        return;
                      }
                      e.dataTransfer.setData(
                        SESSION_DRAG_MIME,
                        encodeSessionDrag({
                          uuid: s.uuid,
                          project: g.project,
                          title: s.title.slice(0, 24) || s.date,
                          source: "archive",
                        }),
                      );
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <div className="archive-session-title">
                      {s.kind === "prompt" && (
                        <span
                          className="archive-kind"
                          title="프롬프트 정리 세션 — 닫을 때 남은 기록입니다 (지식 추출 없음, 요약 자리에는 그때 쓴 메모)"
                        >
                          프롬프트
                        </span>
                      )}
                      {s.title}
                    </div>
                    <div className="archive-session-meta">
                      <span>
                        {s.date} · {s.turns} turns
                      </span>
                      <span className="archive-session-actions">
                        {s.history.length > 0 && (
                          <button
                            className="archive-btn"
                            title="보존된 과거 버전 — 내용이 달라진 재아카이브가 이전본을 남긴 것"
                            aria-expanded={versionsOpen.has(s.uuid)}
                            onClick={() =>
                              setVersionsOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(s.uuid)) next.delete(s.uuid);
                                else next.add(s.uuid);
                                return next;
                              })
                            }
                          >
                            {versionsOpen.has(s.uuid) ? "▾" : "▸"} 버전 {s.history.length + 1}
                          </button>
                        )}
                        <button
                          className="archive-btn"
                          title="이 세션을 이어서 열기 (Claude resume — 이미 열려 있으면 그 탭으로)"
                          onClick={() =>
                            requestSessionResume({
                              uuid: s.uuid,
                              project: g.project,
                              title: s.title.slice(0, 24) || s.date,
                            })
                          }
                        >
                          이어서
                        </button>
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
                    {versionsOpen.has(s.uuid) &&
                      s.history.map((h, i) => (
                        <div key={h.book_path} className="archive-version-row">
                          <span className="archive-version-label">
                            v{s.history.length - i} · {fmtUnix(h.archived_at) || "시각 미상"} · {h.turns} turns
                          </span>
                          <button
                            className="archive-btn"
                            title="이 버전의 책을 시스템 브라우저로 열기"
                            onClick={() => openExternal(h.book_path)}
                          >
                            책
                          </button>
                        </div>
                      ))}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
