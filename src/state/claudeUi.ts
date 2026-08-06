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

/**
 * 프롬프트 정리 패널의 닫기 요청 — 모달 없이 **패널 자신이** 처리한다.
 *
 * 왜 요청을 거쳐 가는가: 정리 세션의 닫기는 아카이브를 수반하고 그건 실패할 수
 * 있다. 실패 사유를 보여 줄 자리는 패널 안뿐이고(탭 헤더는 `overflow:hidden`,
 * 모달은 이 흐름에서 쓰지 않기로 했다), 아카이브에 필요한 메모·턴 수도 패널이
 * 들고 있다. 그래서 탭의 ×는 "닫아 달라"고 **부탁만** 하고, 성공했을 때만
 * 패널이 스스로 `api.close()`를 부른다.
 *
 * `nonce`는 같은 패널에 대한 재요청([다시 닫기])을 새 사건으로 만든다 — 값이
 * 같으면 구독 이펙트가 다시 돌지 않는다.
 */
export interface RefineCloseRequest {
  panelId: string;
  nonce: number;
}

interface ClaudeUiState {
  closeRequest: ClaudeCloseRequest | null;
  requestClose: (r: ClaudeCloseRequest) => void;
  clearClose: () => void;
  refineCloseRequest: RefineCloseRequest | null;
  requestRefineClose: (panelId: string) => void;
  clearRefineClose: () => void;
}

export const useClaudeUi = create<ClaudeUiState>((set) => ({
  closeRequest: null,
  requestClose: (r) => set({ closeRequest: r }),
  clearClose: () => set({ closeRequest: null }),
  refineCloseRequest: null,
  requestRefineClose: (panelId) =>
    set((s) => ({
      refineCloseRequest: { panelId, nonce: (s.refineCloseRequest?.nonce ?? 0) + 1 },
    })),
  clearRefineClose: () => set({ refineCloseRequest: null }),
}));
