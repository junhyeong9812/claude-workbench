import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/store";
import type { ProjectType } from "../types";

const BADGE_COLOR: Record<ProjectType, string> = {
  Rust: "#dea584",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Python: "#3572a5",
  Unknown: "#888888",
};

function TypeBadge({ type }: { type: ProjectType }) {
  return (
    <span className="badge" style={{ backgroundColor: BADGE_COLOR[type] }}>
      {type}
    </span>
  );
}

export function ProjectTabs() {
  const projects = useAppStore((s) => s.projects);
  const activeProject = useAppStore((s) => s.activeProject);
  const setActive = useAppStore((s) => s.setActive);
  const addProject = useAppStore((s) => s.addProject);
  const closeProject = useAppStore((s) => s.closeProject);

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

  return (
    <div className="tabbar">
      {projects.map((p) => (
        <div
          key={p.path}
          className={`tab${p.path === activeProject ? " tab-active" : ""}`}
          onClick={() => setActive(p.path)}
          title={p.path}
        >
          <span className="tab-name">{p.name}</span>
          <TypeBadge type={p.project_type} />
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
      ))}
      <button className="tab-add" onClick={handleAdd} title="Open folder">
        +
      </button>
    </div>
  );
}
