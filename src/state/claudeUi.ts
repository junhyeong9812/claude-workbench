import { create } from "zustand";

/** A request to close a Claude panel, raised by its tab's × and handled by a
 * MainArea modal that lets the user pick 닫기(keep) vs 삭제(delete history).
 * Rendering the choice at app level avoids the dockview tab's `overflow:hidden`
 * clipping a tab-local menu. */
export interface ClaudeCloseRequest {
  panelId: string;
  sessionId: string | null;
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
