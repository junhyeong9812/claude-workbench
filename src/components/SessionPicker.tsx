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
  EMPTY_EXTERNAL,
  PICKER_GROUPS,
  adoptable,
  archBusyUpdate,
  buildSessionSummaries,
  externalRows,
  liveBadge,
  openSessionIds,
  pickerLoadOutcome,
  pickerRows,
  type ArchState,
  type ArchiveStatusRow,
  type ExternalListing,
  type ExternalSessionRow,
  type RawSessionRow,
  type SessionPanelParams,
  type SessionSummary,
} from "../state/sessionCatalog";
import { fmtAgo, fmtUnix } from "../utils/time";
import { useAppStore } from "../state/store";
import { AgentOptionsPopover } from "./AgentOptionsPopover";
import { loadAgentOptions, spawnOptionFields, type AgentOptions } from "../state/agentOptions";

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
  /** 터미널에서 연 세션(앱 스냅샷 없음) — 열린 것 제외 + 최신순. */
  externals: () => ExternalSessionRow[];
  /** 사용자가 삭제해 숨긴 외부 세션 — 토글로 펼쳐 다시 열 수 있다. */
  hiddenExternals: () => ExternalSessionRow[];
  /** 숨긴 세션을 펼쳐 보고 있는가 (피커를 열 때마다 접힌 상태로 시작). */
  showHidden: boolean;
  toggleHidden: () => void;
  collapsed: Set<ArchState>;
  toggleGroup: (key: ArchState) => void;
  newName: string;
  setNewName: (v: string) => void;
}

/** 피커가 쓰는 addPanel의 최소 형태 (MainArea가 주입). */
type PickerAddPanel = (
  kind: "claudeterm",
  opts: {
    loadSessionId: string;
    project?: string;
    title: string;
    spawnCwd?: string;
    adoptPending?: boolean;
  },
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
  // 터미널에서 연 세션(외부) + 삭제로 숨긴 것들. 피커를 열 때마다 새로 조회한다
  // — live 판정은 지금 이 순간의 프로세스 상태라서 캐시하면 틀린 값을 보여준다.
  const [external, setExternal] = useState<ExternalListing>(EMPTY_EXTERNAL);
  // 숨김 섹션은 접힌 채로 시작한다(peek). 삭제한 세션이 목록을 다시 채우지
  // 않는 것이 이 기능의 요점이므로, 상태를 세션 간에 남기지 않는다.
  const [showHidden, setShowHidden] = useState(false);
  // 피커 조회 세대. archReqRef와 **분리**한다: 아카이브 이벤트 리스너가
  // archReqRef를 올리므로 공유하면 이벤트 하나가 사용자의 피커 열기를 통째로
  // 취소해 버린다.
  const loadReqRef = useRef(0);
  // 렌더 시점의 activeProject — await 도중 사용자가 프로젝트를 바꿨는지
  // 비동기 클로저가 볼 수 있는 유일한 창(클로저가 붙든 값은 호출 시점 것이다).
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  /** Open panels of `kind` (for numbering): empty sessions never persist, so the
   * next number is saved sessions + currently-open panels of that kind + 1. */
  const openKindCount = (kind: string): number =>
    (getApi()?.panels ?? []).filter(
      (p) => (p.params as { kind?: string } | undefined)?.kind === kind,
    ).length;

  // "+ Claude(A)": open the picker — name a new session or reopen a saved
  // (not-already-open) one. Per-project (active project). Sessions are a flat,
  // newest-first list — 새 태스크 = 순수 새 세션 (아카이브 모델, 체인 없음).
  const openPicker = async (attempt = 0): Promise<void> => {
    const myReq = ++loadReqRef.current;
    // 이 조회가 어느 프로젝트 것인지 고정 — 응답을 여기에 묶는다.
    const project = activeProject;
    let sessions: SessionSummary[] = [];
    let extRows: ExternalListing = EMPTY_EXTERNAL;
    if (project) {
      const myArch = ++archReqRef.current;
      const [raw, statuses, inFlight, ext] = await Promise.all([
        invoke<RawSessionRow[]>("claude_sessions", { project }).catch(() => []),
        invoke<ArchiveStatusRow[]>("archive_status", { project }).catch(() => []),
        invoke<boolean>("archive_in_flight", { project }).catch(() => false),
        // 실패는 섹션 미표시 — 외부 세션은 부가 기능이라 피커 자체를 막지 않는다.
        invoke<ExternalListing>("claude_external_sessions", { project }).catch(
          () => EMPTY_EXTERNAL,
        ),
      ]);
      switch (pickerLoadOutcome(loadReqRef.current, myReq, project, activeProjectRef.current)) {
        case "stale":
          return; // 더 새 조회가 이미 돌고 있다
        case "switched":
          // 조회하는 사이 프로젝트가 바뀌었다. 남의 프로젝트 목록을 보여주느니
          // 새 프로젝트로 한 번 다시 조회한다(1회 제한 — 사용자가 계속 전환하면
          // 전환이 멎은 뒤의 조회가 이긴다).
          if (attempt === 0) await openPicker(1);
          return;
        case "apply":
          break;
      }
      sessions = buildSessionSummaries(raw, statuses, project);
      extRows = ext;
      const busy = archBusyUpdate(archReqRef.current, myArch, { ok: true, value: inFlight });
      if (busy !== null) setArchBusy(busy);
    }
    setExternal(extRows);
    setShowHidden(false);
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

  /** 지금 패널에 열려 있는 세션 id — 외부 목록에서 제외한다. */
  const openIds = () =>
    openSessionIds(
      (getApi()?.panels ?? []).map((p) => p.params as SessionPanelParams | undefined),
    );

  const externals = (): ExternalSessionRow[] =>
    picker == null ? [] : externalRows(external.sessions, openIds());

  const hiddenExternals = (): ExternalSessionRow[] =>
    picker == null ? [] : externalRows(external.hidden, openIds());

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
    externals,
    hiddenExternals,
    showHidden,
    toggleHidden: () => setShowHidden((v) => !v),
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
  // 옵션 팝오버(에이전트·모델·강도). 닫혀 있는 것이 기본이고, "+ 만들기"는
  // 마지막 설정을 그대로 재사용한다 — 옵션을 바꾸고 싶을 때만 ▾를 연다.
  const [optsOpen, setOptsOpen] = useState(false);

  /** `opts` 미지정 = 마지막 설정 상속(보통 클릭). */
  const createNewSession = (opts?: AgentOptions) => {
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
      ...spawnOptionFields(opts ?? loadAgentOptions("claude")),
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
        <button
          className="claude-picker-create"
          title="마지막에 고른 에이전트·모델·강도로 새 세션을 만듭니다"
          onClick={() => createNewSession()}
        >
          + 만들기
        </button>
        <button
          className={`claude-picker-create${optsOpen ? " claude-picker-create-on" : ""}`}
          title="에이전트 · 모델 · 강도 고르기"
          aria-label="새 세션 옵션"
          aria-haspopup="dialog"
          aria-expanded={optsOpen}
          onClick={() => setOptsOpen((v) => !v)}
        >
          ▾
        </button>
      </div>
      {optsOpen && (
        <AgentOptionsPopover
          onClose={() => setOptsOpen(false)}
          onStart={(_agent, opts) => {
            setOptsOpen(false);
            createNewSession(opts);
          }}
        />
      )}
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
      {(() => {
        // 터미널에서 연 세션 — 전사는 있는데 앱 스냅샷이 없는 것들. 붙이면(adopt)
        // 스냅샷이 생겨 다음 조회부터 "저장된 세션"으로 넘어간다.
        const ext = ctl.externals();
        // 삭제로 숨긴 것들 — 기본은 안 보이고, 토글로 펼쳐서 다시 열 수 있다.
        const hidden = ctl.hiddenExternals();
        if (ext.length === 0 && hidden.length === 0) return null;
        const renderExtRow = (s: ExternalSessionRow, isHidden: boolean) => {
          const badge = liveBadge(s);
          const can = adoptable(s);
          return (
            <div
              key={`ext:${s.uuid}`}
              className={`claude-picker-row${isHidden ? " claude-picker-row-hidden" : ""}`}
              // 이유 설명은 행에 건다 — 비활성 버튼은 마우스 이벤트를 받지
              // 않아 tooltip이 안 뜨는 브라우저가 있고, 그러면 "왜 못 누르지"
              // 를 알 길이 없어진다.
              title={
                badge
                  ? badge.hint
                  : `${s.cwd}\n클릭하면 이 세션을 이어서 엽니다${
                      isHidden ? " (숨김이 풀립니다)" : ""
                    }`
              }
            >
              <button
                className="claude-picker-item"
                disabled={!can}
                onClick={() => {
                  if (!can) return;
                  // 스폰 디렉토리는 전사의 원 cwd다(CLI가 거기서만 resume한다).
                  // 앱이 보는 프로젝트 경로와 문자열이 다르면 — 같은 디렉토리를
                  // 심링크 등으로 다르게 부르는 경우 — 한 번 확인받는다.
                  if (
                    activeProject &&
                    s.cwd !== activeProject &&
                    !window.confirm(
                      `이 세션은 다음 디렉토리에서 시작됐습니다:\n${s.cwd}\n\n` +
                        `현재 프로젝트(${activeProject})와 경로 표기가 다릅니다. ` +
                        `원래 디렉토리에서 이어 열까요?`,
                    )
                  ) {
                    return;
                  }
                  setPicker(null);
                  addPanel("claudeterm", {
                    loadSessionId: s.uuid,
                    project: activeProject ?? s.cwd,
                    spawnCwd: s.cwd,
                    // 인수는 이 클릭 한 번뿐 — 패널이 세션을 열면서 지운다.
                    adoptPending: true,
                    title: s.title.slice(0, 24) || "외부 세션",
                  });
                }}
              >
                <span className="claude-picker-title">{s.title || "(제목 없음)"}</span>
                <span className="claude-picker-meta">
                  {fmtAgo(s.modified)}
                  {badge ? <span className="claude-picker-badge"> · {badge.label}</span> : null}
                  {isHidden ? <span className="claude-picker-badge"> · 숨김</span> : null}
                </span>
              </button>
            </div>
          );
        };
        return (
          <>
            {ext.length > 0 && (
              <div
                className="claude-picker-sep"
                title="이 프로젝트에서 터미널로 직접 연 claude 세션입니다. 클릭하면 앱 탭으로 이어서 엽니다(--resume)."
              >
                외부 세션 ({ext.length})
              </div>
            )}
            {ext.map((s) => renderExtRow(s, false))}
            {hidden.length > 0 && (
              <button
                className="claude-picker-group"
                aria-expanded={ctl.showHidden}
                title="삭제한 세션입니다 — 전사는 그대로 남아 있어서 여기서 다시 열 수 있습니다. 다시 열면 숨김이 풀립니다."
                onClick={ctl.toggleHidden}
              >
                <span className="claude-picker-group-caret">{ctl.showHidden ? "▾" : "▸"}</span>
                숨긴 세션 {hidden.length}개 {ctl.showHidden ? "접기" : "보기"}
              </button>
            )}
            {ctl.showHidden && hidden.map((s) => renderExtRow(s, true))}
          </>
        );
      })()}
      {activeProject && (
        <>
          <div className="claude-picker-sep">프로젝트</div>
          <button
            className="claude-picker-item"
            title="이 프로젝트의 메모장 (자동 저장 · 프로젝트당 1개). 툴바 ▤ 메모와 같은 탭을 엽니다."
            onClick={() => {
              // 여는 실행부는 MainArea가 소유한다(dockview api가 거기 있다) —
              // 피커는 툴바 버튼과 **같은** 요청 버스를 두드릴 뿐이라 두 진입점이
              // 갈라질 수 없다. 닫기는 그 소비자가 한다.
              useAppStore.getState().requestMemo();
            }}
          >
            <span className="claude-picker-title">▤ 메모장</span>
            <span className="claude-picker-meta">이 프로젝트의 메모 (세션 아님)</span>
          </button>
        </>
      )}
      <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
        취소
      </button>
    </div>
  );
}
