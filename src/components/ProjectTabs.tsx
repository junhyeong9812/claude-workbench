import { useState } from "react";
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

  // HTML5 drag-drop reorder state (transient, view-only).
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [overPath, setOverPath] = useState<string | null>(null);

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

  const handleDrop = (targetPath: string) => {
    if (draggedPath && draggedPath !== targetPath) {
      reorderProject(draggedPath, targetPath);
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
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(p.path);
            }}
            onDragEnd={() => {
              setDraggedPath(null);
              setOverPath(null);
            }}
            onClick={() => setActive(p.path)}
            title={p.path}
            style={{
              opacity: isDragged ? 0.4 : 1,
              boxShadow: isOver ? "inset 0 0 0 2px #4a9eff" : undefined,
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
    </div>
  );
}
