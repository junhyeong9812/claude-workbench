/**
 * codex 세션 탭 — PTY 터미널(왼쪽) + rollout 전사 타임라인(오른쪽).
 *
 * **터미널은 여전히 [`TerminalPanel`] 그대로다.** 이 컴포넌트는 그것을 감싸기만
 * 한다(props 그대로 전달). 작업②가 codexterm을 TerminalPanel로 푼 이유 —
 * "ClaudeTermPanel을 안 지나는 것이 격리의 구조적 보장" — 은 그대로 살아 있고,
 * 터미널 쪽 코드는 이번에 한 줄도 바뀌지 않았다(스폰·릴레이·스냅샷·리사이즈·
 * 닫기 전부 공용 경로). 타임라인은 그 옆에 붙는 **읽기 전용 컬럼**이다.
 *
 * claude 탭과 나란한 어휘를 쓰되(우측 고정폭 컬럼·접기·상세 뷰어), 데이터는
 * [`useCodexTimeline`]이 따로 공급한다. claude의 타임라인 이벤트·스냅샷·배지
 * 배선은 여기 없다(붙일 자리도 없다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { TerminalPanel, type TerminalParams } from "./TerminalPanel";
import { ItemDetail, TimelineView } from "./TimelineView";
import { useCodexTimeline, type CodexTimelineStatus } from "../hooks/useCodexTimeline";

/** 상태별 한 단어 배지. `matched` 외에는 전부 "전사 없음"이고 이유만 다르다. */
const STATUS_BADGE: Record<CodexTimelineStatus, string> = {
  matched: "",
  searching: "전사 찾는 중",
  contested: "전사 미확정",
  ambiguous: "전사 미확정",
  lost: "전사 소실",
  unavailable: "전사 없음",
  error: "오류",
};

const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`);

/** 전사 파일명을 짧게 — `rollout-` 접두와 `.jsonl`을 떼면 `<시각>-<uuid>`가 남는다.
 *
 * **이걸 화면에 띄우는 이유**: 매칭은 추론이라 틀릴 수 있고(같은 폴더·같은 시각),
 * TUI 안에서 `/new`를 하면 타임라인이 옛 대화에 고착된다. 어느 파일을 보고 있는지
 * 적어 두지 않으면 그 두 경우가 **화면에서 구별되지 않는다**(리뷰 #5). */
export function shortTranscriptName(path: string | null): string | null {
  if (!path) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
}

export function CodexTermPanel(props: IDockviewPanelProps<TerminalParams>) {
  // TerminalPanel이 세션을 만든 뒤 `updateParameters`로 심는 값이라, 최초 렌더엔
  // 없다 — 파라미터 변경 이벤트로 따라간다(재부착 탭은 처음부터 들고 있다).
  const [sessionId, setSessionId] = useState<number | null>(props.params.sessionId ?? null);
  useEffect(() => {
    const d = props.api.onDidParametersChange((p) => {
      const next = (p as TerminalParams).sessionId;
      setSessionId(next ?? null);
    });
    return () => d.dispose();
  }, [props.api]);

  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(380);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 접힌 동안에는 폴링도 멈춘다 — 안 보는 화면 때문에 전사를 계속 읽지 않는다.
  const tl = useCodexTimeline({ sessionId, enabled: !collapsed });

  const selectedItem = useMemo(
    () => (selectedId ? (tl.items.find((i) => i.tool_call_id === selectedId) ?? null) : null),
    [tl.items, selectedId],
  );

  // 스플리터 드래그 — mousemove마다 setState하면 프레임이 떨어지므로 rAF로 합친다
  // (claudeterm의 같은 패턴). 언마운트 시 리스너·pending rAF를 반드시 푼다.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    let raf = 0;
    let lastX = 0;
    let moved = false;
    const commit = () => setWidth(Math.max(240, Math.min(rect.width - 240, rect.right - lastX)));
    const onMove = (ev: MouseEvent) => {
      lastX = ev.clientX;
      moved = true;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        commit();
      });
    };
    const teardown = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanup.current = null;
    };
    const onUp = () => {
      if (moved) commit();
      teardown();
    };
    dragCleanup.current = teardown;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const badge = STATUS_BADGE[tl.status];
  const transcript = shortTranscriptName(tl.path);
  const ctxPct =
    tl.ctxWindow > 0 ? Math.min(100, Math.round((tl.ctxTokens / tl.ctxWindow) * 100)) : null;
  // 진단 줄: 모델·강도·토큰·컨텍스트 + 파싱 이상(있을 때만). claude 탭의 게이지
  // 자리에 대응하되 새 게이지 CSS를 만들지 않고 한 줄 텍스트로 둔다.
  const diag = [
    tl.model,
    tl.effort,
    tl.tokenTotal.input || tl.tokenTotal.output
      ? `↑${fmt(tl.tokenTotal.input)} ↓${fmt(tl.tokenTotal.output)}`
      : null,
    ctxPct != null ? `컨텍스트 ${ctxPct}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // 미지 레코드·미파싱 줄은 **조용히 넘기지 않는다** — codex가 스키마를 바꾸면
  // 타임라인이 이유 없이 얇아지는데, 그 이유를 여기서 읽을 수 있어야 한다.
  const parseNote = [
    tl.badLines > 0 ? `읽지 못한 줄 ${tl.badLines}` : null,
    tl.skipped.length > 0
      ? `미지원 레코드 ${tl.skipped.map(([k, n]) => `${k}×${n}`).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const detail = (
    <div className="codexterm-pane codexterm-viewer-pane" style={{ flex: "0 0 460px" }}>
      <div className="codexterm-pane-head">
        <span className="codexterm-pane-head-title">
          {selectedItem ? selectedItem.title || selectedItem.kind : `Q${selectedTurn}`}
        </span>
        <span
          className="codexterm-x"
          title="닫기"
          onClick={() => {
            setSelectedId(null);
            setSelectedTurn(null);
          }}
        >
          ✕
        </span>
      </div>
      <div className="codexterm-viewer-body">
        {selectedItem ? (
          // markdown={false}: codex의 도구 출력은 터미널 텍스트이고 패치는 unified
          // diff라, 마크다운으로 렌더하면 오히려 원문이 뭉개진다.
          <ItemDetail item={selectedItem} markdown={false} />
        ) : selectedTurn != null ? (
          <pre className="codexterm-qa">
            {`질문:\n${tl.turns.get(selectedTurn) ?? ""}\n\n답변:\n${
              tl.answers.get(selectedTurn) || "(없음)"
            }`}
          </pre>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="codexterm" ref={containerRef}>
      {/* 터미널은 언제나 마운트된 채다 — 언마운트하면 PTY에서 떨어진다. */}
      <div className="codexterm-pane codexterm-term-pane">
        <TerminalPanel {...props} />
      </div>
      {(selectedItem != null || selectedTurn != null) && !collapsed && detail}
      {collapsed ? (
        <button className="codexterm-expand" title="타임라인 펼치기" onClick={() => setCollapsed(false)}>
          ◀ 타임라인
        </button>
      ) : (
        <>
          <div className="codexterm-splitter" title="드래그로 크기 조절" onMouseDown={startDrag} />
          <div className="codexterm-pane codexterm-timeline-pane" style={{ flex: `0 0 ${width}px` }}>
            <div className="codexterm-pane-head">
              <span className="codexterm-pane-head-title">
                타임라인{badge && ` · ${badge}`}
                {!tl.alive && " · 세션 종료"}
              </span>
              <span className="codexterm-x" title="타임라인 접기" onClick={() => setCollapsed(true)}>
                ▶
              </span>
            </div>
            {transcript && (
              <div className="codexterm-file" title={tl.path ?? undefined}>
                {transcript}
              </div>
            )}
            {diag && <div className="codexterm-diag">{diag}</div>}
            {tl.note && <div className="codexterm-note">{tl.note}</div>}
            {parseNote && <div className="codexterm-note">{parseNote}</div>}
            <div className="codexterm-timeline">
              <TimelineView
                items={tl.items}
                turns={tl.turns}
                answers={tl.answers}
                dates={tl.dates}
                selectedId={selectedId}
                selectedTurn={selectedTurn}
                selectedScope="codex"
                scope="codex"
                followBottom
                sessionCwd={props.params.cwd ?? undefined}
                onSelect={(it) => {
                  setSelectedId(it.tool_call_id);
                  setSelectedTurn(null);
                }}
                onSelectTurn={(turn) => {
                  setSelectedTurn(turn);
                  setSelectedId(null);
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
