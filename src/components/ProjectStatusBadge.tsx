import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/store";
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

  const roll = projectAttention(entries, project, projectOfSession, labelOfSession);
  const active = hasProjectAttention(roll);

  // Close the dropdown on outside click / Escape. Also fold it when the project
  // goes quiet (no active sessions) so a stale list can't linger.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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
        type="button"
        className={`tab-status-badge is-${kind}${running ? " is-running" : ""}`}
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
      {open && (
        <div className="tab-status-pop" role="menu" aria-label={`${project} 진행 중 세션`}>
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
                  requestFocusSession(s.uuid);
                }}
              >
                <span className={`tab-status-dot is-${skind}`} aria-hidden="true" />
                <span className="tab-status-row-name">{label}</span>
                <span className="tab-status-row-state">{statusText}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
