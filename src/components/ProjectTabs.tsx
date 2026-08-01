import { useState, type DragEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/store";
import { TypeBadges } from "./TypeBadges";

export function ProjectTabs() {
  const projects = useAppStore((s) => s.projects);
  const activeProject = useAppStore((s) => s.activeProject);
  const setActive = useAppStore((s) => s.setActive);
  const addProject = useAppStore((s) => s.addProject);
  const closeProject = useAppStore((s) => s.closeProject);
  const reorderProject = useAppStore((s) => s.reorderProject);
  const dualProject = useAppStore((s) => s.dualProject);
  const setDualProject = useAppStore((s) => s.setDualProject);
  // 탭 우클릭 컨텍스트 메뉴 (project-dual-surface 진입점).
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // HTML5 drag-drop reorder state (transient, view-only).
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);
  // Which side of the hovered tab the cursor is on: true = insert after it.
  const [overAfter, setOverAfter] = useState(false);

  // Cursor past a tab's horizontal midpoint -> insert after it, else before.
  const sideAfter = (e: DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };

  const handleAdd = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await addProject(selected);
      }
    } catch (err) {
      console.error("folder picker failed", err);
    }
  };

  const handleDrop = (targetPath: string, after: boolean) => {
    if (draggedPath && draggedPath !== targetPath) {
      reorderProject(draggedPath, targetPath, after);
    }
    setDraggedPath(null);
    setOverPath(null);
  };

  return (
    <div className="tabbar">
      {projects.map((p) => {
        const isDragged = p.path === draggedPath;
        const isOver = p.path === overPath && draggedPath !== null && !isDragged;
        return (
          <div
            key={p.path}
            className={`tab${p.path === activeProject ? " tab-active" : ""}`}
            draggable
            onDragStart={(e) => {
              setDraggedPath(p.path);
              // WebKitGTK only initiates a drag when dataTransfer is populated.
              e.dataTransfer.setData("text/plain", p.path);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverPath(p.path);
              setOverAfter(sideAfter(e));
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(p.path, sideAfter(e));
            }}
            onDragEnd={() => {
              setDraggedPath(null);
              setOverPath(null);
            }}
            onClick={() => setActive(p.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ path: p.path, x: e.clientX, y: e.clientY });
            }}
            title={p.path}
            style={{
              opacity: isDragged ? 0.4 : 1,
              // Insertion line on the side the tab will drop into.
              boxShadow: isOver
                ? overAfter
                  ? "inset -3px 0 0 0 #4a9eff"
                  : "inset 3px 0 0 0 #4a9eff"
                : undefined,
            }}
          >
            <span className="tab-name">{p.name}</span>
            <TypeBadges types={p.project_types} />
            <button
              className="tab-close"
              title="Close project"
              onClick={(e) => {
                e.stopPropagation();
                closeProject(p.path);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-add" onClick={handleAdd} title="Open folder">
        +
      </button>
      {ctxMenu && (
        <>
          <div
            className="tab-ctx-backdrop"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div className="tab-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {dualProject === ctxMenu.path ? (
              <button
                className="tab-ctx-item"
                onClick={() => {
                  setDualProject(null);
                  setCtxMenu(null);
                }}
              >
                우측 분할 닫기
              </button>
            ) : (
              <button
                className="tab-ctx-item"
                disabled={ctxMenu.path === activeProject}
                title={
                  ctxMenu.path === activeProject
                    ? "활성 프로젝트는 이미 왼쪽에 열려 있습니다 — 다른 프로젝트를 분할로 여세요"
                    : "이 프로젝트의 작업 영역을 우측 분할로 나란히 엽니다"
                }
                onClick={() => {
                  setDualProject(ctxMenu.path);
                  setCtxMenu(null);
                }}
              >
                우측 분할로 열기
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
