import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { TerminalPanel } from "./TerminalPanel";
import { CodexTermPanel } from "./CodexTermPanel";
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
  // codex 세션 = TerminalPanel(터미널 그대로) + rollout 전사 타임라인 컬럼.
  // 작업③에서 얇은 래퍼 하나가 생겼지만 **격리의 구조적 보장은 그대로다**:
  // CodexTermPanel은 TerminalPanel을 감싸기만 하고(스폰·릴레이·스냅샷·리사이즈·
  // 닫기 전부 공용 경로 그대로) ClaudeTermPanel은 여전히 지나지 않는다 —
  // claude의 타임라인 이벤트·스냅샷·시드·상태 배지 배선이 붙을 자리가 없다.
  codexterm: CodexTermPanel,
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
