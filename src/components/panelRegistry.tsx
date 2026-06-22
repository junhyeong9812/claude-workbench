import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { EditorPanel } from "./EditorPanel";
import { DiffPanel } from "./DiffPanel";
import { ClaudeTab } from "./ClaudeTab";
import { SshTab } from "./SshTab";

/** dockview component registry — maps component name -> React panel. Shared by
 * the main workbench (MainArea) and popped-out windows (PopoutWorkbench) so a
 * panel transferred between windows renders identically. SSH reuses the
 * PTY-backed TerminalPanel (it branches on `kind` internally). */
export const components = {
  placeholder: PlaceholderPanel,
  terminal: TerminalPanel,
  ssh: TerminalPanel,
  claudeterm: ClaudeTermPanel,
  editor: EditorPanel,
  diff: DiffPanel,
};

/** Panel kinds that can be created/transferred. */
export type PanelKind = "terminal" | "editor" | "claudeterm";

/** Default tab for all panels. Both Claude panel kinds (ACP `claude` and the
 * architecture-A `claudeterm`) use the custom tab — its × raises a 닫기/삭제
 * modal and its title renames inline (B3-1/B3-5). SSH uses its own tab. */
export function AppTab(props: IDockviewPanelHeaderProps) {
  const kind = props.params.kind;
  if (kind === "claudeterm") return <ClaudeTab {...props} />;
  if (kind === "ssh") return <SshTab {...props} />;
  return <DockviewDefaultTab {...props} />;
}
