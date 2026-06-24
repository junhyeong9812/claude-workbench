import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../utils/error";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";

interface Worktree {
  path: string;
  head: string;
  branch: string;
}


/**
 * Worktree panel (GP4) — sidebar tab. Lists `git worktree`s for the active
 * project, adds (path + branch), removes, and opens one as a project tab.
 */
export function WorktreePanel() {
  const cwd = useAppStore((s) => s.activeProject);
  const addProject = useAppStore((s) => s.addProject);
  const requestClaudeOpen = useAppStore((s) => s.requestClaudeOpen);

  // Register a worktree as a project tab and open a fresh Claude session bound to
  // it — one-click "work this worktree with Claude". Must `await addProject` first:
  // a NOT-yet-open worktree awaits project-type detection before activeProject
  // flips, and MainArea is keyed by activeProject (remounts per project). Requesting
  // before the switch would land the panel in the OLD project's dock; awaiting lets
  // the new mount pick the request up (via apiReady).
  const openClaude = async (path: string) => {
    await addProject(path);
    requestClaudeOpen({ project: path });
  };
  const [list, setList] = useState<Worktree[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const reqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!cwd) {
      setList([]);
      return;
    }
    const myReq = ++reqRef.current;
    const target = cwd;
    try {
      const wts = await invoke<Worktree[]>("git_worktrees", { cwd: target });
      if (reqRef.current === myReq) setList(wts); // ignore superseded (project switch)
    } catch (e) {
      if (reqRef.current === myReq) {
        setNote(errText(e));
        setList([]);
      }
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote("");
    try {
      await fn();
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
      await reload();
    }
  };

  if (!cwd) return <div className="git-empty">프로젝트를 먼저 여세요.</div>;

  return (
    <div className="git-panel">
      <div className="tree-hint">
        워크트리 = 같은 저장소의 <b>추가 작업 폴더</b>(각자 다른 브랜치를 동시 체크아웃). 병렬 작업
        격리용 — 브랜치 자체가 아니라 그 브랜치가 놓인 폴더입니다. ‘열기’로 프로젝트 탭에 엽니다.
      </div>
      <div className="git-head">
        <span className="git-track">워크트리 ({list.length})</span>
        <button
          className="git-btn"
          disabled={busy}
          title="새 워크트리 추가"
          onClick={() => {
            const path = window.prompt("새 워크트리 경로 (예: ../proj-feature)");
            if (!path || !path.trim()) return;
            const branch = window.prompt("체크아웃할 브랜치");
            if (!branch || !branch.trim()) return;
            act(() => invoke("git_worktree_add", { cwd, path: path.trim(), branch: branch.trim() }));
          }}
        >
          + 추가
        </button>
        <button className="git-btn" disabled={busy} title="새로고침" onClick={() => void reload()}>
          ↻
        </button>
      </div>
      <div className="git-body">
        {list.map((w) => (
          <div key={w.path} className="git-file">
            <span className="git-ref git-ref-local">{w.branch}</span>
            <span className="git-path" title={`${w.path}\n${w.head}`}>
              {w.path}
            </span>
            {w.path === cwd ? (
              <span className="git-cmeta" title="현재 활성 프로젝트">
                현재
              </span>
            ) : (
              <button className="git-mini" disabled={busy} title="프로젝트 탭으로 열기" onClick={() => void addProject(w.path)}>
                열기
              </button>
            )}
            <button
              className="git-mini"
              disabled={busy}
              title="이 워크트리에서 Claude 세션 열기"
              onClick={() => void openClaude(w.path)}
            >
              Claude
            </button>
            <button
              className="git-mini"
              disabled={busy}
              title="워크트리 제거"
              onClick={() => {
                if (window.confirm(`${w.path} 워크트리를 제거할까요?`))
                  act(() => invoke("git_worktree_remove", { cwd, path: w.path }));
              }}
            >
              ×
            </button>
          </div>
        ))}
        {list.length === 0 && <div className="git-clean">워크트리 없음</div>}
        {note && <div className="git-clean">{note}</div>}
      </div>
    </div>
  );
}
