import type { ProjectType } from "../types";

/** Badge color per detected project type (mirrors the Rust `ProjectType`). */
export const BADGE_COLOR: Record<ProjectType, string> = {
  Rust: "#dea584",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Python: "#3572a5",
  React: "#61dafb",
  JavaScript: "#f1e05a",
  Vue: "#41b883",
  Unknown: "#888888",
};

/** A single colored type badge. */
export function TypeBadge({ type }: { type: ProjectType }) {
  return (
    <span className="badge" style={{ backgroundColor: BADGE_COLOR[type] }}>
      {type}
    </span>
  );
}

/**
 * A row of colored badges for a detected-type list. An empty list renders a
 * single `Unknown` badge so the absence of any marker is still visible.
 */
export function TypeBadges({ types }: { types: ProjectType[] }) {
  const list = types.length > 0 ? types : (["Unknown"] as ProjectType[]);
  return (
    <span className="badges">
      {list.map((t) => (
        <TypeBadge key={t} type={t} />
      ))}
    </span>
  );
}
