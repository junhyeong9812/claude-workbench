/**
 * 우측 단발성 타임라인 peek — 한 세션의 타임라인만 보여주는 임시 dock 패널.
 *
 * Claude 탭 툴바의 "⧉ 타임라인" 버튼이 자기 오른쪽에 붙인다(state/timelinePeek).
 * 데이터는 소유 패널과 같은 공급부(useClaudeTimeline)를 uuid로 구독하므로, 원
 * Claude 탭이 **백그라운드 탭이어도**(언마운트) 라이브로 이어진다 — 이벤트는
 * 창 전역 브로드캐스트고 숫자 id↔uuid 매핑은 패널 언마운트보다 오래 산다.
 *
 * 단발성: 레이아웃에 남더라도 복원 직후 제거된다(timelinePeek.closePeekPanels).
 */
import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { TimelineView } from "./TimelineView";
import { useClaudeTimeline } from "../hooks/useClaudeTimeline";
import { PEEK_KIND } from "../state/timelinePeek";

export interface TimelinePeekParams {
  kind?: typeof PEEK_KIND;
  /** 보여줄 세션의 uuid. */
  uuid?: string;
  /** 세션의 프로젝트(cwd) — 스냅샷 시드 조회용. */
  project?: string;
  /** 세션 표시 이름(헤더). */
  title?: string;
  /** 이 peek를 연 Claude 탭의 패널 id — 그 탭이 닫히면 헤더에 알린다. */
  sourcePanelId?: string;
}

export function TimelinePeekPanel(props: IDockviewPanelProps<TimelinePeekParams>) {
  const uuid = props.params.uuid ?? null;
  const project = props.params.project ?? null;
  const { items, turns, answers, dates, subagents, ended } = useClaudeTimeline({ uuid, project });
  // peek는 읽기 전용 — 선택은 행 강조(스크롤 앵커)만 한다. 변경 상세 뷰어는 원
  // Claude 탭 소유(범위 절제: spec ④ "타임라인만 표시").
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);

  // 원 Claude 탭이 닫혔는지. PTY 종료 브로드캐스트(claude-session-closed)는 강제
  // 종료·claude 자체 종료에서만 오고, **탭 닫기(claude_detach → DetachAct::Close,
  // runtime.rs)는 이벤트를 내지 않는다** — 그래서 가장 흔한 경로를 덮으려면 dock
  // 패널의 존재 여부까지 봐야 한다. 둘 다 "기존 신호"라 백엔드 변경은 없다.
  const sourceId = props.params.sourcePanelId ?? null;
  const [sourceGone, setSourceGone] = useState(false);
  useEffect(() => {
    if (!sourceId) return;
    const containerApi = props.containerApi;
    // 마운트 시점 재확인 — 언마운트(탭 전환) 중 사라진 경우를 복구한다.
    setSourceGone(!containerApi.getPanel(sourceId));
    const d = containerApi.onDidRemovePanel((p) => {
      if (p.id === sourceId) setSourceGone(true);
    });
    return () => d.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  const note = ended ? "세션 종료" : sourceGone ? "원본 탭 닫힘" : null;

  return (
    <div className="claudeterm">
      <div className="claudeterm-pane claudeterm-peek-pane">
        <div className="claudeterm-pane-head">
          <span className="claudeterm-pane-head-title">
            타임라인 — {props.params.title ?? "세션"}
          </span>
          {note && (
            <span
              className="claudeterm-peek-ended"
              title={
                ended
                  ? "이 세션의 claude 프로세스가 종료되었습니다 — 마지막 상태를 보여줍니다"
                  : "이 타임라인을 연 Claude 탭이 닫혔습니다 (세션은 살아 있을 수 있습니다)"
              }
            >
              {note}
            </span>
          )}
          <span className="claudeterm-viewer-x" title="닫기" onClick={() => props.api.close()}>
            ×
          </span>
        </div>
        <div className="claudeterm-timeline">
          {uuid ? (
            <TimelineView
              items={items}
              turns={turns}
              answers={answers}
              dates={dates}
              subagents={subagents}
              selectedId={selectedId}
              selectedTurn={selectedTurn}
              selectedScope="live"
              scope="live"
              followBottom
              sessionCwd={project ?? undefined}
              onSelect={(it) => {
                setSelectedId(it.tool_call_id);
                setSelectedTurn(null);
              }}
              onSelectTurn={(turn) => {
                setSelectedTurn(turn);
                setSelectedId(null);
              }}
            />
          ) : (
            <div className="claudeterm-peek-empty">세션 정보를 찾을 수 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
