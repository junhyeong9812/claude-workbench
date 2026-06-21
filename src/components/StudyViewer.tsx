import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/store";
import { StudyFileView } from "./StudyFileView";
import { ContextMenu, copyText } from "./ContextMenu";

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * A study viewer: multi-tab read-only file view for one side. Tabs are MRU
 * ordered (active first) so recent ones stay visible; the rest overflow and are
 * reachable via the ▾ dropdown.
 *
 * Keyboard (mouse-free): the viewer root is focusable (Ctrl+←/→ lands here).
 * Alt+←/→ cycles tabs in stable order; Alt+↓ opens the overflow dropdown where
 * ↑/↓ highlight and Enter opens (Esc closes).
 */
export function StudyViewer({ side, focusId }: { side: "left" | "right"; focusId?: string }) {
  const tabs = useAppStore((s) => s.studyTabs[side]);
  const active = useAppStore((s) => s.studyActive[side]);
  const mode = useAppStore((s) => s.studyMode[side]);
  const setStudyActive = useAppStore((s) => s.setStudyActive);
  const closeStudyTab = useAppStore((s) => s.closeStudyTab);
  const cycleStudyTab = useAppStore((s) => s.cycleStudyTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Focus the menu when it opens (so ↑/↓/Enter work without the mouse).
  useEffect(() => {
    if (menuOpen) menuRef.current?.focus();
  }, [menuOpen]);

  const openMenu = () => {
    setMenuIdx(Math.max(0, tabs.indexOf(active ?? "")));
    setMenuOpen(true);
  };
  const closeMenu = () => {
    setMenuOpen(false);
    rootRef.current?.focus();
  };

  const onRootKey = (e: React.KeyboardEvent) => {
    if (!e.altKey) return; // Ctrl/plain handled elsewhere (column nav / textarea)
    if (e.key === "ArrowRight") {
      e.preventDefault();
      cycleStudyTab(side, 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      cycleStudyTab(side, -1);
    } else if (e.key === "ArrowDown" && tabs.length > 0) {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMenuIdx((i) => Math.min(tabs.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMenuIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = tabs[menuIdx];
      if (p) setStudyActive(side, p);
      closeMenu();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  };

  if (tabs.length === 0) {
    return (
      <div className="study-viewer study-viewer-empty" id={focusId} tabIndex={0}>
        사이드바에서 파일을 열면 탭으로 표시됩니다.
      </div>
    );
  }

  return (
    <div className="study-viewer" id={focusId} tabIndex={0} ref={rootRef} onKeyDown={onRootKey}>
      <div className="study-tabs">
        <div className="study-tabs-list">
          {tabs.map((p) => (
            <div
              key={p}
              className={`study-tab${p === active ? " active" : ""}`}
              title={p}
              onClick={() => setStudyActive(side, p)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, path: p });
              }}
            >
              <span className="study-tab-name">{basename(p)}</span>
              <span
                className="study-tab-x"
                title="닫기"
                onClick={(e) => {
                  e.stopPropagation();
                  closeStudyTab(side, p);
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
        {tabs.length > 1 && (
          <div className="study-tabs-more">
            <button className="git-mini" title="모든 탭 (Alt+↓)" onClick={() => (menuOpen ? closeMenu() : openMenu())}>
              ▾ {tabs.length}
            </button>
            {menuOpen && (
              <div className="study-tabs-menu" ref={menuRef} tabIndex={-1} onKeyDown={onMenuKey} onBlur={() => setMenuOpen(false)}>
                {tabs.map((p, i) => (
                  <div
                    key={p}
                    className={`study-tabs-menu-item${p === active ? " active" : ""}${i === menuIdx ? " hl" : ""}`}
                    title={p}
                    onMouseEnter={() => setMenuIdx(i)}
                    onClick={() => {
                      setStudyActive(side, p);
                      closeMenu();
                    }}
                  >
                    {basename(p)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {active && <StudyFileView key={`${active}:${mode}`} path={active} editable={mode === "editor"} />}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={[{ label: "경로 복사", onClick: () => void copyText(ctx.path) }]}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
