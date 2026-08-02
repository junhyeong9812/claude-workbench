/**
 * "+ Claude" 저장 세션 피커 — 새 세션 이름 짓기 + 저장된 세션 재개
 * (MainArea에서 순수 이동, P5 F-b).
 *
 * 상태·조회는 `useSessionPicker` 훅이, 표시는 `SessionPicker` 컴포넌트가 갖고,
 * 정렬·분류·세대 가드 같은 규칙은 순수 모듈 `state/sessionCatalog`에 있다.
 * 피커를 여는 트리거(툴바 요청 버스)는 MainArea에 그대로 남는다.
 */
import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SESSION_DRAG_MIME, encodeSessionDrag } from "./sessionDropZone";
import {
  PICKER_GROUPS,
  archBusyUpdate,
  buildSessionSummaries,
  openSessionIds,
  pickerRows,
  type ArchState,
  type ArchiveStatusRow,
  type RawSessionRow,
  type SessionPanelParams,
  type SessionSummary,
} from "../state/sessionCatalog";
import { fmtUnix } from "../utils/time";

export interface SessionPickerController {
  /** null = 피커 닫힘. */
  sessions: SessionSummary[] | null;
  /** 열기/닫기 (툴바 요청 버스·드롭 취소가 쓴다). */
  setPicker: (v: SessionSummary[] | null) => void;
  /** 세션 목록·아카이브 상태를 다시 읽어 피커를 (재)연다. */
  openPicker: () => Promise<void>;
  /** 이 프로젝트의 아카이브가 지금 실행 중인가 (배지). */
  archBusy: boolean;
  /** 열린 세션 제외 + 최신순 (B3-2) — 렌더 시점의 live dock 조회. */
  rows: () => SessionSummary[];
  collapsed: Set<ArchState>;
  toggleGroup: (key: ArchState) => void;
  newName: string;
  setNewName: (v: string) => void;
}

/** 피커가 쓰는 addPanel의 최소 형태 (MainArea가 주입). */
type PickerAddPanel = (
  kind: "claudeterm",
  opts: { loadSessionId: string; project?: string; title: string },
) => unknown;

export function useSessionPicker(deps: {
  /** 피커는 주 surface 전용. */
  isPrimary: boolean;
  activeProject: string | null;
  /** 리마운트 stale 방지 — 호출마다 다시 읽는다. */
  getApi: () => DockviewApi | null;
}): SessionPickerController {
  const { isPrimary, activeProject, getApi } = deps;

  // Saved-session picker for "+ Claude" (null = closed) + the name a "새 세션"
  // would get (B3-4: per-project "Claude N", computed when the picker opens).
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // Mirror of `picker` for the archive-event listener (its closure would
  // otherwise capture a stale snapshot).
  const pickerRef = useRef<SessionSummary[] | null>(null);
  pickerRef.current = picker;
  // 이 프로젝트의 아카이브가 지금 실행 중인지 (picker "아카이브 진행중" 배지).
  const [archBusy, setArchBusy] = useState(false);
  // in_flight 조회 세대 — 늦게 도착한 낡은 응답이 배지를 되돌리지 못하게.
  const archReqRef = useRef(0);
  // Collapsed picker groups (아카이브됨/아카이브 이후 작업/아카이브 없음).
  const [pickerCollapsed, setPickerCollapsed] = useState<Set<ArchState>>(new Set());
  // Which kind the open picker creates/reopens: ACP `claude` or A `claudeterm`.
  const [newName, setNewName] = useState("Claude 1");

  /** Open panels of `kind` (for numbering): empty sessions never persist, so the
   * next number is saved sessions + currently-open panels of that kind + 1. */
  const openKindCount = (kind: string): number =>
    (getApi()?.panels ?? []).filter(
      (p) => (p.params as { kind?: string } | undefined)?.kind === kind,
    ).length;

  // "+ Claude(A)": open the picker — name a new session or reopen a saved
  // (not-already-open) one. Per-project (active project). Sessions are a flat,
  // newest-first list — 새 태스크 = 순수 새 세션 (아카이브 모델, 체인 없음).
  const openPicker = async () => {
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      const myReq = ++archReqRef.current;
      const [raw, statuses, inFlight] = await Promise.all([
        invoke<RawSessionRow[]>("claude_sessions", { project: activeProject }).catch(() => []),
        invoke<ArchiveStatusRow[]>("archive_status", { project: activeProject }).catch(() => []),
        invoke<boolean>("archive_in_flight", { project: activeProject }).catch(() => false),
      ]);
      sessions = buildSessionSummaries(raw, statuses, activeProject);
      const busy = archBusyUpdate(archReqRef.current, myReq, { ok: true, value: inFlight });
      if (busy !== null) setArchBusy(busy);
    }
    setNewName(`Claude ${sessions.length + openKindCount("claudeterm") + 1}`);
    setPicker(sessions); // open-session filtering happens at render
  };

  // 진행중 배지 실시간화: 아카이브 시작/종료 브로드캐스트를 받아 배지를 갱신
  // 하고, 종료 시 picker가 열려 있으면 그룹 분류를 새로 가져온다. payload의
  // raw cwd를 activeProject와 문자열 비교하면 경로 정규화 차이(심링크·슬래시)
  // 에 취약하므로, 이벤트는 트리거로만 쓰고 판정은 백엔드 in_flight 재조회로
  // 한다 (리뷰 F7 — 백엔드가 canonicalize로 동일성을 판정).
  useEffect(() => {
    if (!isPrimary) return; // 피커는 주 surface 전용
    const refresh = () => {
      if (!activeProject) return;
      // started/finished 연속 발생 시 응답 역전으로 낡은 true가 나중에 도착해
      // 배지가 busy에 갇힐 수 있다 — 최신 요청만 반영(post-fix P4).
      const my = ++archReqRef.current;
      void invoke<boolean>("archive_in_flight", { project: activeProject })
        .then((v) => {
          const next = archBusyUpdate(archReqRef.current, my, { ok: true, value: v });
          if (next !== null) setArchBusy(next);
        })
        .catch(() => {
          // 최신 요청이 실패하면 이전 응답도 세대 가드에 막혀 배지가 고착될
          // 수 있다 — 정보성 배지는 미표시가 고착보다 낫다(fail-soft).
          const next = archBusyUpdate(archReqRef.current, my, { ok: false });
          if (next !== null) setArchBusy(next);
        });
    };
    const un1 = listen("mt-archive-started", refresh);
    const un2 = listen("mt-archive-finished", () => {
      refresh();
      if (pickerRef.current !== null) void openPicker();
    });
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  // Picker rows: saved sessions newest-first, excluding already-open ones.
  const rows = (): SessionSummary[] => {
    if (picker == null) return [];
    const open = openSessionIds(
      (getApi()?.panels ?? []).map((p) => p.params as SessionPanelParams | undefined),
    );
    return pickerRows(picker, open);
  };

  const toggleGroup = (key: ArchState) =>
    setPickerCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return {
    sessions: picker,
    setPicker,
    openPicker,
    archBusy,
    rows,
    collapsed: pickerCollapsed,
    toggleGroup,
    newName,
    setNewName,
  };
}

export function SessionPicker({
  ctl,
  addPanel,
  activeProject,
}: {
  ctl: SessionPickerController;
  addPanel: PickerAddPanel;
  activeProject: string | null;
}) {
  const { setPicker, archBusy, newName, setNewName, collapsed, toggleGroup } = ctl;
  // 드래그 직전 실제로 눌린 요소 — dragstart의 e.target은 HTML DnD 표준상
  // draggable 조상(행)이라 내부 버튼 판별이 불가능하다(리뷰 S6 감사, WHATWG
  // dnd). mousedown 캡처로 기록해 dragstart에서 판별한다.
  const dragPressRef = useRef<EventTarget | null>(null);

  const createNewSession = () => {
    const name = newName.trim() || "Claude";
    setPicker(null);
    // Give the new session a stable UUID up front so it's saved in the layout
    // immediately → resumes the same session after restart (create-or-resume in
    // claude_start handles the not-yet-chatted case). #6
    // Pin the session to the current project so its cwd basis is stable (the panel
    // reads `params.project` as sessionCwd; an `activeProject` fallback would shift
    // if the user switches tabs while the session lives — codex P2).
    addPanel("claudeterm", {
      title: name,
      loadSessionId: crypto.randomUUID(),
      project: activeProject ?? undefined,
    });
  };

  return (
    <div className="claude-picker">
      <div className="claude-picker-new-row">
        <input
          className="claude-picker-input"
          value={newName}
          autoFocus
          placeholder="새 세션 이름"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createNewSession();
            else if (e.key === "Escape") setPicker(null);
          }}
        />
        <button className="claude-picker-create" onClick={createNewSession}>
          + 만들기
        </button>
      </div>
      {archBusy && (
        <div className="claude-picker-busy" title="이 프로젝트의 세션 아카이브가 실행 중입니다 (책·요약·지식 추출 — 1~2분)">
          ⏳ 아카이브 진행 중…
        </div>
      )}
      {(() => {
        const rows = ctl.rows();
        if (rows.length === 0) return null;
        const renderRow = (s: SessionSummary) => (
          <div
            key={`${s.project}:${s.id}`}
            className="claude-picker-row"
            draggable
            title="드래그해서 dock의 원하는 위치에 열기 (중앙=탭 · 가장자리=스플릿)"
            onMouseDownCapture={(e) => {
              dragPressRef.current = e.target;
            }}
            onDragStart={(e) => {
              // 삭제 ×에서 시작한 드래그만 취소 (S6) — 행의 주 클릭 면이
              // 버튼(claude-picker-item)이라 버튼 전체를 막으면 드래그
              // 자체가 불가능해진다. dragstart의 e.target은 행 자신이므로
              // mousedown 캡처로 기록한 실제 눌린 요소를 본다(S6 감사).
              // project 미상 행은 드래그 불가 (S8).
              const pressed = dragPressRef.current;
              if (
                (pressed instanceof HTMLElement &&
                  pressed.closest(".claude-tab-x, input")) ||
                !s.project
              ) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.setData(
                SESSION_DRAG_MIME,
                encodeSessionDrag({
                  uuid: s.id,
                  project: s.project,
                  title: s.name || s.title?.slice(0, 24) || s.date,
                  source: "picker",
                }),
              );
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <button
              className="claude-picker-item"
              onClick={() => {
                setPicker(null);
                addPanel("claudeterm", {
                  loadSessionId: s.id,
                  project: s.project,
                  title: s.name || s.title?.slice(0, 24) || s.date,
                });
              }}
            >
              <span className="claude-picker-title">{s.name || "(이름 없음)"}</span>
              <span className="claude-picker-meta">
                {s.title ? `${s.title.slice(0, 40)} · ` : ""}
                {s.date} · 변경 {s.count}
                {s.archivedAt ? ` · 📦 ${fmtUnix(s.archivedAt)}` : ""}
                {s.versions > 0 ? ` · 버전 ${s.versions + 1}` : ""}
              </span>
            </button>
          </div>
        );
        return (
          <>
            <div className="claude-picker-sep">저장된 세션</div>
            {PICKER_GROUPS.map((g) => {
              const members = rows.filter((s) => s.archState === g.key);
              if (members.length === 0) return null;
              const isCollapsed = collapsed.has(g.key);
              return (
                <div key={g.key}>
                  <button
                    className={`claude-picker-group arch-${g.key}`}
                    title={g.hint}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span className="claude-picker-group-caret">{isCollapsed ? "▸" : "▾"}</span>
                    {g.label} ({members.length})
                  </button>
                  {!isCollapsed && members.map(renderRow)}
                </div>
              );
            })}
          </>
        );
      })()}
      <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
        취소
      </button>
    </div>
  );
}
