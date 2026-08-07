import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudeTermPanel } from "./ClaudeTermPanel";
import { EditorPanel } from "./EditorPanel";
import { DiffPanel } from "./DiffPanel";
import { TimelinePeekPanel } from "./TimelinePeekPanel";
import { MemoPanel } from "./MemoPanel";
import { PEEK_KIND } from "../state/timelinePeek";
import { MEMO_KIND } from "../state/projectMemo";
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
  // codex 세션은 **순수 터미널 탭**이다 — SSH와 같은 이유로 TerminalPanel을
  // 재사용한다(스폰 커맨드만 다르고 그 뒤는 PTY 릴레이·xterm이 전부). 이것이
  // 격리의 구조적 보장이기도 하다: ClaudeTermPanel을 안 지나므로 타임라인·
  // 스냅샷·시드·상태 배지 배선이 붙을 자리 자체가 없다.
  codexterm: TerminalPanel,
  claudeterm: ClaudeTermPanel,
  editor: EditorPanel,
  diff: DiffPanel,
  // 우측 단발성 타임라인 peek — 세션을 소유하지 않는 읽기 전용 패널.
  [PEEK_KIND]: TimelinePeekPanel,
  // 프로젝트 메모장 — 세션을 소유하지 않는 일반 탭(복원 대상).
  [MEMO_KIND]: MemoPanel,
};

/** Panel kinds that can be created/transferred. */
export type PanelKind = "terminal" | "editor" | "claudeterm" | "codexterm";

/** Default tab for all panels. Both Claude panel kinds (ACP `claude` and the
 * architecture-A `claudeterm`) use the custom tab — its × raises a 닫기/삭제
 * modal and its title renames inline (B3-1/B3-5). SSH uses its own tab. */
export function AppTab(props: IDockviewPanelHeaderProps) {
  const kind = props.params.kind;
  if (kind === "claudeterm") return <ClaudeTab {...props} />;
  if (kind === "ssh") return <SshTab {...props} />;
  return <DockviewDefaultTab {...props} />;
}
