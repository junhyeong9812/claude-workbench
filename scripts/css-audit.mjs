// CSS isolation guard audit for src/App.css — run via `npm run css-audit`.
// Enforces the three invariants that keep the single global sheet from
// regressing into overlap/breakage territory:
//   1. z-index literals are forbidden outside the :root layer-scale block —
//      every stacking decision must go through a --z-* token so the stacking
//      order stays reviewable in one place.
//   2. every `flex: 1` growing child carries a shrink guard (min-width:0 /
//      min-height:0 / overflow) — an unguarded one pushes siblings out of the
//      panel when space runs out (the observed overlap bug class).
//   3. top-level class selectors stay inside the component namespace prefixes —
//      the only isolation mechanism a single global sheet has.
import { readFileSync } from "node:fs";

const CSS_PATH = new URL("../src/App.css", import.meta.url);
const css = readFileSync(CSS_PATH, "utf8");
const lines = css.split("\n");

// Component namespaces (first hyphen-segment of a rule-starting class).
// Extend deliberately when adding a new component family — not ad hoc.
const PREFIXES = new Set([
  "app", "archive", "badge", "cfs", "claude", "claudeterm", "cm", "commit", "ctx",
  "dev", "diff", "dock", "drop", "editor", "git", "main", "modal", "pane", "panes",
  "peek", "placeholder", "resize", "run", "search", "sidebar", "ssh",
  "study", "tab", "tabbar", "terminal", "timeline", "tl", "toolbar",
  "tree", "ts",
]);

const violations = [];

// --- 1. raw z-index outside the :root token block ---
lines.forEach((line, i) => {
  if (!/z-index\s*:/.test(line)) return; // property use only (not prose in comments)
  if (/^\s*--z-[a-z-]+:\s*\d+;/.test(line)) return; // token definition
  if (/z-index:\s*var\(--z-/.test(line)) return; // token usage
  violations.push(`L${i + 1}: raw z-index (use a --z-* token): ${line.trim()}`);
});

// --- 2. flex:1 without a shrink guard ---
// Known heuristic limits (kept regex-simple by design — no CSS AST dependency):
// the guard check is axis-agnostic (a min-width:0 satisfies it even where the
// parent is a column and min-height:0 is the effective guard), and the naive
// rule regex reads nested @media blocks flat. Both can under-report axis
// mismatches, never over-report; the current sheet audits clean under manual
// axis review (P3 dual review).
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().split("\n").pop().trim();
  const body = m[2];
  if (!/flex:\s*1/.test(body)) continue;
  const guarded =
    /min-(width|height):\s*0/.test(body) ||
    /overflow(-[xy])?:\s*(hidden|auto|scroll)/.test(body);
  if (!guarded) {
    violations.push(
      `selector "${sel}": flex:1 without min-width:0/min-height:0/overflow guard`,
    );
  }
}

// --- 3. rule-starting class outside the namespace allowlist ---
// Checks column-0 selectors only — App.css keeps top-level rules unindented;
// an indented selector (inside @media) inherits its component's namespace.
lines.forEach((line, i) => {
  const m = /^\.([a-z][a-z0-9]*)/.exec(line);
  if (!m) return;
  if (!PREFIXES.has(m[1])) {
    violations.push(
      `L${i + 1}: selector prefix ".${m[1]}" not in namespace allowlist (scripts/css-audit.mjs)`,
    );
  }
});

if (violations.length) {
  console.error(`css-audit: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("css-audit: clean (z-index tokens / flex guards / prefixes)");
