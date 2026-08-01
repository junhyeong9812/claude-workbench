/**
 * Claude 탭 × 닫기/삭제 해석 (P4 공통화 — MainArea ↔ PopoutWorkbench의
 * 문자단위 동일 resolveClose 실행부 단일 출처).
 *
 * 계약: 닫기 = 패널만 닫는다(저장 히스토리 유지 — onDidRemovePanel이 이 창을
 * detach, refcount P6). 삭제 = 세션 전체를 강제 종료(다른 창 미러가 스냅샷을
 * 재생성 못 하게) 후 히스토리 삭제, 그 다음 패널 닫기. delete는 세션 **자기**
 * 프로젝트를 대상으로(활성 탭과 다를 수 있음 — codex P2 F1).
 *
 * 창별 차이(모달 렌더 가드 — 소유 surface 판정, primary 전용 고아 백스톱)는
 * 호출 컴포넌트에 남는다(주입 지점, 조사 워커 #8).
 */
import { invoke } from "@tauri-apps/api/core";

export interface CloseRequestLike {
  kind: string;
  panelId: string;
  ptyId?: number | null;
  sessionId?: string | null;
  project?: string | null;
}

export async function resolveCloseRequest(
  req: CloseRequestLike,
  activeProject: string | null,
  deleteHistory: boolean,
  closePanel: (panelId: string) => void,
): Promise<void> {
  const project = req.project ?? activeProject;
  if (req.kind === "claudeterm" && deleteHistory && typeof req.ptyId === "number") {
    await invoke("claude_close", { id: req.ptyId }).catch(() => {});
    if (req.sessionId && project) {
      await invoke("claude_delete", { project, uuid: req.sessionId }).catch(() => {});
    }
  }
  closePanel(req.panelId);
}
