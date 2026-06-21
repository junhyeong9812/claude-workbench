import { useState } from "react";
import { useAppStore } from "../state/store";
import { StudyFileView } from "./StudyFileView";

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * A study viewer: multi-tab read-only file view for one side. Tabs are MRU
 * ordered (active first), so the recent ones stay visible; the rest overflow
 * (clipped) and are reachable via the ▾ dropdown that lists every open tab.
 */
export function StudyViewer({ side }: { side: "left" | "right" }) {
  const tabs = useAppStore((s) => s.studyTabs[side]);
  const active = useAppStore((s) => s.studyActive[side]);
  const setStudyActive = useAppStore((s) => s.setStudyActive);
  const closeStudyTab = useAppStore((s) => s.closeStudyTab);
  const [menuOpen, setMenuOpen] = useState(false);

  if (tabs.length === 0) {
    return <div className="study-viewer study-viewer-empty">사이드바에서 파일을 열면 탭으로 표시됩니다.</div>;
  }

  return (
    <div className="study-viewer">
      <div className="study-tabs">
        <div className="study-tabs-list">
          {tabs.map((p) => (
            <div
              key={p}
              className={`study-tab${p === active ? " active" : ""}`}
              title={p}
              onClick={() => setStudyActive(side, p)}
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
            <button className="git-mini" title="모든 탭" onClick={() => setMenuOpen((o) => !o)}>
              ▾ {tabs.length}
            </button>
            {menuOpen && (
              <div className="study-tabs-menu" onMouseLeave={() => setMenuOpen(false)}>
                {tabs.map((p) => (
                  <div
                    key={p}
                    className={`study-tabs-menu-item${p === active ? " active" : ""}`}
                    title={p}
                    onClick={() => {
                      setStudyActive(side, p);
                      setMenuOpen(false);
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
      {active && <StudyFileView key={active} path={active} />}
    </div>
  );
}
