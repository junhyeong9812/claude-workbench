import type { IDockviewPanelProps } from "dockview-react";

/** Params attached to a placeholder panel when it is created (see MainArea). */
export interface PlaceholderParams {
  kind?: "terminal" | "editor";
  title?: string;
}

/**
 * Stub content for a dockview panel.
 *
 * This is intentionally inert: the real terminal (phase-02b) and editor
 * (phase-03) replace this component later. For now it only echoes which kind of
 * panel it stands in for, so the docking/split/swap behaviour can be exercised.
 */
export function PlaceholderPanel(props: IDockviewPanelProps<PlaceholderParams>) {
  const kind = props.params.kind ?? "panel";
  const title = props.params.title ?? kind;
  return (
    <div className="dock-placeholder">
      <p className="dock-placeholder-kind">{kind}</p>
      <p className="dock-placeholder-title">{title}</p>
      <p className="dock-placeholder-sub">
        Placeholder — real content arrives in a later phase.
      </p>
    </div>
  );
}
