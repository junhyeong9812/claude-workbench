import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useAppStore } from "../state/store";
import { useSurfaceProject, useSurfaceId } from "../state/surfaceContext";
import type { RunTarget } from "../types";

/**
 * Toolbar "▶ 실행" menu: detects the active project's build/test toolchains
 * (cargo/npm/gradle/...) and runs the chosen command in a fresh terminal panel.
 * A polyglot repo shows one row per tool. Detection is read-only; running just
 * types the command into a terminal (the user sees full output + can re-run).
 */
export function RunMenu() {
  // 표면-로컬(P5): 이 표면의 프로젝트를 감지하고, 실행 요청도 이 표면 origin으로
  // 발행한다 — 각 표면 툴바가 자기 dock에 터미널을 연다.
  const activeProject = useSurfaceProject();
  const surfaceId = useSurfaceId();
  const requestRun = useAppStore((s) => s.requestRun);
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // 드롭다운은 body 포털 + fixed + 뷰포트 클램프(반응형 1차) — 좁은 표면 우측이나
  // `overflow:hidden` 조상(부 표면 셸) 안에서도 잘리거나 화면 밖으로 나가지 않는다.
  // 실측 min-width 260 · 이전 CSS 상한(60vh)을 대체하는 420 상한.
  const pos = useAnchoredPosition(open, btnRef, popRef, {
    fallbackWidth: 260,
    maxHeight: 420,
  });

  // Re-detect whenever the active project changes. Clear the old targets + close
  // the menu *first*, so a click during detection can't run the previous
  // project's command against the new project (codex finding).
  useEffect(() => {
    setTargets([]);
    setOpen(false);
    if (!activeProject) return;
    let alive = true;
    invoke<RunTarget[]>("detect_run_targets", { dir: activeProject })
      .then((t) => {
        if (alive) setTargets(t);
      })
      .catch(() => {
        if (alive) setTargets([]);
      });
    return () => {
      alive = false;
    };
  }, [activeProject]);

  // Close the dropdown on an outside click. 드롭다운이 포털로 body에 있으므로
  // 트리거(ref)뿐 아니라 팝오버(popRef)도 "안쪽"으로 세야 한다.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!activeProject || targets.length === 0) return null;

  const run = (cmd: string, label: string) => {
    requestRun({ project: activeProject, cmd, title: label }, surfaceId);
    setOpen(false);
  };

  return (
    /* data-keep-menu: 이 메뉴가 오버플로("⋯") 안으로 접혔을 때, 트리거를 누르는
       동안 부모 메뉴가 닫히지 않게 한다(닫히면 드롭다운까지 언마운트된다). */
    <div className="run-menu" ref={ref} data-keep-menu="">
      <button
        ref={btnRef}
        className="toolbar-btn"
        title="빌드/테스트 실행"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* 라벨만 별도 span — 아주 좁은 표면에서는 @container 규칙이 이걸 숨겨
            아이콘만 남긴다(반응형 1차). 바깥 span 으로 한 번 더 싸는 이유: 이
            버튼은 inline-flex(gap 5px)라 "▶ " 를 텍스트 노드로 두면 **익명 flex
            아이템**이 하나 더 생겨 넓은 폭 폭이 59.42→61.11 로 늘었다(회귀).
            전체를 한 span 에 담으면 flex 아이템은 하나뿐이고, 안쪽은 평범한
            인라인 흐름이라 "▶ 실행" 과 픽셀 동일하다. */}
        <span>
          ▶<span className="toolbar-label"> 실행</span>
        </span>
      </button>
      {open &&
        createPortal(
        <div
          ref={popRef}
          className="run-dropdown"
          data-popover-layer=""
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            maxHeight: pos?.maxHeight,
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {targets.map((t) => (
            <div key={t.kind} className="run-group">
              <div className="run-group-head">{t.kind}</div>
              {t.test && (
                <button className="run-item" onClick={() => run(t.test!, `test: ${t.kind}`)}>
                  ✓ 테스트 — <code>{t.test}</code>
                </button>
              )}
              {t.build && (
                <button className="run-item" onClick={() => run(t.build!, `build: ${t.kind}`)}>
                  🔨 빌드 — <code>{t.build}</code>
                </button>
              )}
              {!t.test && !t.build && <div className="run-item run-empty">실행 가능한 명령 없음</div>}
            </div>
          ))}
        </div>,
          document.body,
        )}
    </div>
  );
}
