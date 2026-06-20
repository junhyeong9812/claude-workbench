/**
 * Multi-lane commit graph (GP2). Computes a column (lane) per commit with the
 * standard git-graph algorithm, then renders each row as an SVG gutter: vertical
 * lines for lanes passing through, a node dot at the commit's lane, and connectors
 * to parent lanes (merges fan out). Used by {@link GitPanel}'s history half.
 */

export interface GraphCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  date: string;
  refs: string;
  subject: string;
}

export interface GraphRow {
  commit: GraphCommit;
  col: number;
  before: (string | null)[];
  after: (string | null)[];
}

/** Assign lanes. `lanes[i]` = the commit hash lane i is currently waiting for. */
export function computeGraph(commits: GraphCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  let lanes: (string | null)[] = [];
  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = firstFree();
      lanes[col] = c.hash;
    }
    const before = lanes.slice();
    // Free any *other* lane that also waited for this commit (branch point).
    lanes = lanes.map((h, i) => (i !== col && h === c.hash ? null : h));
    // This lane continues into the first parent — unless that parent already has
    // a lane (a branch point): then this lane ends and joins the existing one, so
    // the parent isn't duplicated across lanes (codex GP-1). The node→parent
    // diagonal is still drawn by the renderer via the existing lane.
    const fp = c.parents[0] ?? null;
    lanes[col] = fp !== null && lanes.indexOf(fp) !== -1 ? null : fp;
    // Extra parents (a merge) take an existing lane that expects them, else a new one.
    for (let p = 1; p < c.parents.length; p++) {
      const ph = c.parents[p];
      if (lanes.indexOf(ph) === -1) lanes[firstFree()] = ph;
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, col, before, after: lanes.slice() });
  }
  return rows;
}

const CELL = 12;
const ROW = 22;
const RADIUS = 3.5;
const LANE_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#f5c2e7", "#94e2d5", "#fab387", "#f38ba8"];
const laneColor = (col: number): string => LANE_COLORS[col % LANE_COLORS.length];
const cx = (col: number): number => col * CELL + CELL / 2;

/** SVG gutter for one commit row. */
export function GitGraphRow({ row, maxLanes }: { row: GraphRow; maxLanes: number }) {
  const width = Math.max(1, maxLanes) * CELL;
  return (
    <svg width={width} height={ROW} className="git-graph-svg" style={{ flex: `0 0 ${width}px` }}>
      {row.before.map((h, i) =>
        h != null ? (
          <line key={`b${i}`} x1={cx(i)} y1={0} x2={cx(i)} y2={ROW / 2} stroke={laneColor(i)} strokeWidth={1.5} />
        ) : null,
      )}
      {row.after.map((h, i) =>
        h != null ? (
          <line key={`a${i}`} x1={cx(i)} y1={ROW / 2} x2={cx(i)} y2={ROW} stroke={laneColor(i)} strokeWidth={1.5} />
        ) : null,
      )}
      {row.commit.parents.map((p, pi) => {
        const pc = row.after.indexOf(p);
        // Connect the node to a parent that sits in a *different* lane (merge/branch
        // diagonal); same-lane parents are already covered by the after-line.
        return pc >= 0 && pc !== row.col ? (
          <line key={`p${pi}`} x1={cx(row.col)} y1={ROW / 2} x2={cx(pc)} y2={ROW} stroke={laneColor(pc)} strokeWidth={1.5} />
        ) : null;
      })}
      <circle cx={cx(row.col)} cy={ROW / 2} r={RADIUS} fill={laneColor(row.col)} />
    </svg>
  );
}
