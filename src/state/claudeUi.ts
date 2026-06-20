import { create } from "zustand";

/** A request to close a Claude panel, raised by its tab's × and handled by a
 * MainArea modal that lets the user pick 닫기(keep) vs 삭제(delete history).
 * Rendering the choice at app level avoids the dockview tab's `overflow:hidden`
 * clipping a tab-local menu. */
export interface ClaudeCloseRequest {
  panelId: string;
  sessionId: string | null;
  /** Panel kind (architecture-A claude terminal). */
  kind: "claudeterm";
  /** claudeterm's live PTY id, so the modal can stop the poll thread before a
   * delete (otherwise it would recreate the snapshot). */
  ptyId?: number;
  /** The project (cwd) the session is stored under — needed because a
   * workspace-wide reopen can open a task from a project other than the active
   * one, and delete must target that project's storage. */
  project?: string | null;
}

interface ClaudeUiState {
  closeRequest: ClaudeCloseRequest | null;
  requestClose: (r: ClaudeCloseRequest) => void;
  clearClose: () => void;
}

export const useClaudeUi = create<ClaudeUiState>((set) => ({
  closeRequest: null,
  requestClose: (r) => set({ closeRequest: r }),
  clearClose: () => set({ closeRequest: null }),
}));
