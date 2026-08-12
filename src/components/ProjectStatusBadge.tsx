import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "../hooks/useAnchoredPosition";
import { useAppStore } from "../state/store";
import { findSessionPanel } from "../state/surfaceRegistry";
import {
  useClaudeStatus,
  projectAttention,
  hasProjectAttention,
  projectOfSession,
  labelOfSession,
  type SessionStatus,
} from "../state/claudeStatus";

/**
 * Per-project session-status badge (멀티프로젝트 B1).
 *
 * Rolls the per-session attention `entries` (claudeStatus) up to the **project**
 * that owns each session (`projectOfSession`) and shows one compact badge when
 * `project` has any live session: a count + a ▾ that expands the in-progress
 * Claude sessions (label · status). A running rectangle-border motion plays while
 * any session is actively **working** — the "진행 중" cue. Nothing renders when the
 * project is all-idle (mirrors the toolbar roll-up's `shouldShowRollup`).
 *
 * This is a pure derivation over the existing status store — no new poll, no
 * backend touch, and the per-session badges/roll-up are untouched (additive). It
 * is mounted both on each project tab (ProjectTabs) and on the secondary surface
 * header (App), so **each surface shows its own project's roll-up** (P5 소유) — the
 * store is per-window, so the count reflects this window's sessions.
 */

const STATUS_TEXT: Record<SessionStatus, string> = {
  blocked: "입력 대기",
  working: "진행 중",
  idle: "대기",
};

/** Priority kind for the badge tint (blocked > done-unseen > working). */
function badgeKind(r: {
  blocked: number;
  doneUnseen: number;
}): "blocked" | "done" | "working" {
  if (r.blocked > 0) return "blocked";
  if (r.doneUnseen > 0) return "done";
  return "working";
}

export function ProjectStatusBadge({ project }: { project: string }) {
  const entries = useClaudeStatus((s) => s.entries);
  const requestFocusSession = useAppStore((s) => s.requestFocusSession);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // F1: 포털 드롭다운의 fixed 좌표(트리거 rect 기준 계산 + 뷰포트 클램프). null =
  // 아직 미계측(첫 레이아웃 패스 전) → visibility:hidden 으로 깜빡임 방지.
  // 계산·구독은 useAnchoredPosition 단일 출처(반응형 1차 인프라 C) — 기본값이
  // 이 배지가 쓰던 값(gap/margin 4 · maxHeight 260 · minHeight 80 · fallback
  // 200×260)과 같아 동작은 그대로다.
  const pos = useAnchoredPosition(open, btnRef, popRef);

  const roll = projectAttention(entries, project, projectOfSession, labelOfSession);
  const active = hasProjectAttention(roll);

  // Close the dropdown on outside click / Escape. Also fold it when the project
  // goes quiet (no active sessions) so a stale list can't linger. 포털 pop은
  // rootRef 밖(document.body)에 있으므로 popRef도 함께 검사한다(F1).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!active && open) setOpen(false);
  }, [active, open]);

  if (!active) return null;

  const kind = badgeKind(roll);
  const running = roll.working > 0;
  const total = roll.sessions.length;
  const title =
    `진행 중 세션 ${total}개` +
    (roll.working ? ` · 작업 ${roll.working}` : "") +
    (roll.blocked ? ` · 입력대기 ${roll.blocked}` : "") +
    (roll.doneUnseen ? ` · 완료(미확인) ${roll.doneUnseen}` : "") +
    " — 클릭해 목록 열기";

  return (
    <div className="tab-status" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`tab-status-badge is-${kind}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={(e) => {
          // Don't let the surrounding project tab activate/switch on a badge click.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="tab-status-count">{total}</span>
        <span className="tab-status-caret" aria-hidden="true">
          ▾
        </span>
        {/* Running rectangle-border motion — masked conic ring, center punched
            out so the count stays readable. Only mounted while working. */}
        {running && (
          <span className="tab-status-ring" aria-hidden="true">
            <span className="tab-status-spin" />
          </span>
        )}
      </button>
      {/* F1(codex P2-1 + P2-3): 드롭다운을 body 포털 + position:fixed 레이어로 띄운다.
          배지가 보조 표면 조상 `.dual-secondary{overflow:hidden}`에 클리핑돼 secondary
          헤더에서 사실상 안 열리던 문제와, left:0 고정이라 우측 탭·하단 표면에서 화면
          밖으로 나가던 문제를 함께 해소한다(좌표 = useAnchoredPosition). */}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="tab-status-pop"
            role="menu"
            aria-label={`${project} 진행 중 세션`}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              maxHeight: pos?.maxHeight,
              // 계측 전(pos=null)엔 숨겨 좌상단 깜빡임 방지 — useLayoutEffect가
              // paint 전에 좌표를 채운다.
              visibility: pos ? "visible" : "hidden",
            }}
          >
            {roll.sessions.map((s) => {
              const skind =
                s.status === "blocked" ? "blocked" : s.unseen ? "done" : "working";
              const label = s.label?.trim() || s.uuid.slice(0, 8);
              const statusText = s.status === "blocked" || s.status === "working"
                ? STATUS_TEXT[s.status]
                : s.unseen
                  ? "완료 · 미확인"
                  : STATUS_TEXT.idle;
              return (
                <button
                  key={s.uuid}
                  type="button"
                  role="menuitem"
                  className="tab-status-row"
                  title={`${label} — ${statusText}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    // F2(codex P2-2): 이 세션 패널이 이 창 어느 표면 dock에도 없으면
                    // (비활성 프로젝트 — primary MainArea가 activeProject로 key돼 그
                    // dock이 마운트 안 됨) 먼저 그 프로젝트를 primary로 활성화해 dock을
                    // 띄운다. 그래야 뒤이은 requestFocusSession의 findSessionPanel이
                    // 패널을 찾는다. 이미 어느 표면(primary·secondary)에 열려 있으면
                    // 활성화를 건너뛴다 — 부 표면 세션을 괜히 primary로 끌어오지 않는다.
                    if (!findSessionPanel(s.uuid)) {
                      const st = useAppStore.getState();
                      if (st.projects.some((p) => p.path === project)) st.setActive(project);
                      else void st.addProject(project);
                    }
                    requestFocusSession(s.uuid);
                  }}
                >
                  <span className={`tab-status-dot is-${skind}`} aria-hidden="true" />
                  <span className="tab-status-row-name">{label}</span>
                  <span className="tab-status-row-state">{statusText}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
