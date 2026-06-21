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

const CELL = 14;
const ROW = 24;
const RADIUS = 4;
const LANE_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#f5c2e7", "#94e2d5", "#fab387", "#f38ba8"];
const laneColor = (col: number): string => LANE_COLORS[col % LANE_COLORS.length];
const cx = (col: number): number => col * CELL + CELL / 2;

/** A path from (x1,y1)→(x2,y2): straight if same column, else a smooth S-curve
 * (vertical-tangent cubic bezier) so lane shifts/merges read as curves. */
function edge(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`;
}

/** SVG gutter for one commit row (curved multi-lane). */
export function GitGraphRow({ row, maxLanes }: { row: GraphRow; maxLanes: number }) {
  const width = Math.max(1, maxLanes) * CELL;
  const node = cx(row.col);
  return (
    <svg width={width} height={ROW} className="git-graph-svg" style={{ flex: `0 0 ${width}px` }}>
      {/* Incoming lanes from the top: the commit's own lane(s) curve into the node;
          other lanes pass straight through to their column in `after`. */}
      {row.before.map((h, i) => {
        if (h == null) return null;
        if (h === row.commit.hash) {
          return (
            <path key={`in${i}`} d={edge(cx(i), 0, node, ROW / 2)} stroke={laneColor(i)} fill="none" strokeWidth={1.6} />
          );
        }
        const af = row.after.indexOf(h);
        if (af < 0) return null;
        return (
          <path key={`th${i}`} d={edge(cx(i), 0, cx(af), ROW)} stroke={laneColor(i)} fill="none" strokeWidth={1.6} />
        );
      })}
      {/* Outgoing edges: node → each parent's lane in `after` (merges fan out). */}
      {row.commit.parents.map((p, pi) => {
        const pc = row.after.indexOf(p);
        return pc >= 0 ? (
          <path key={`p${pi}`} d={edge(node, ROW / 2, cx(pc), ROW)} stroke={laneColor(pc)} fill="none" strokeWidth={1.6} />
        ) : null;
      })}
      <circle cx={node} cy={ROW / 2} r={RADIUS} fill={laneColor(row.col)} stroke="#1e1e2e" strokeWidth={1} />
    </svg>
  );
}
