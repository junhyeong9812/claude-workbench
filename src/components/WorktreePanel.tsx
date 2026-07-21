import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../utils/error";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { groupWorktrees, type Worktree, type WorktreeGroup } from "./worktreeGroups";

/** A discovered git root (path + current branch) — `git_roots` backend shape. */
interface GitRoot {
  path: string;
  branch: string;
}
/** A live Claude session + the directory it runs in (its cwd, possibly a worktree).
 * `root` is the git-canonicalized worktree root of `cwd` — match against that. */
interface SessionCwd {
  uuid: string;
  cwd: string;
  root: string;
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;


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
  const [groups, setGroups] = useState<WorktreeGroup[]>([]);
  const [sessions, setSessions] = useState<SessionCwd[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const reqRef = useRef(0);
  // Mirror `busy` into a ref so the polling interval reads the live value (its
  // closure captures state once) and skips refreshing mid-action.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Coalesce overlapping reloads (focus + interval + manual + post-action) so they
  // don't each spawn a concurrent `git_worktrees` subprocess + IPC (codex P2).
  const loadingRef = useRef(false);

  const reload = useCallback(async () => {
    if (!cwd) {
      setGroups([]);
      setSessions([]);
      return;
    }
    if (loadingRef.current) return; // a reload is already in flight
    loadingRef.current = true;
    const myReq = ++reqRef.current;
    const target = cwd;
    try {
      // 멀티 repo 인식: activeProject 자체가 repo가 아닌 모음 폴더(하위에
      // repo 여럿)여도 git_roots로 전부 찾아 root별 `git worktree list`를
      // 모은다. 링크드 워크트리 폴더도 root로 잡히는 중복은 groupWorktrees가
      // main 경로 기준으로 dedup. 개별 root 실패(비-repo 등)는 빈 목록으로
      // 넘어간다 — 한 repo의 오류가 전체 패널을 비우지 않는다.
      const [roots, sess] = await Promise.all([
        invoke<GitRoot[]>("git_roots", { cwd: target }),
        invoke<SessionCwd[]>("claude_session_cwds").catch(() => [] as SessionCwd[]),
      ]);
      const repos = await Promise.all(
        roots.map(async (r) => ({
          root: r.path,
          worktrees: await invoke<Worktree[]>("git_worktrees", { cwd: r.path }).catch(
            () => [] as Worktree[],
          ),
        })),
      );
      if (reqRef.current === myReq) {
        setGroups(groupWorktrees(repos)); // ignore superseded (project switch)
        setSessions(sess);
        if (roots.length === 0) setNote("git 저장소를 찾지 못했습니다.");
        else setNote("");
      }
    } catch (e) {
      if (reqRef.current === myReq) {
        setNote(errText(e));
        setGroups([]);
      }
    } finally {
      loadingRef.current = false;
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Auto-refresh: worktrees and sessions change out-of-band (a session opens in a
  // worktree, a subagent's isolation worktree appears/vanishes). Poll while mounted
  // and on window focus so the panel stays current without a manual ↻. Skips while
  // a mutating action is in flight to avoid clobbering its own post-action reload.
  useEffect(() => {
    if (!cwd) return;
    const tick = () => {
      if (!busyRef.current) void reload();
    };
    const id = setInterval(tick, 4000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [cwd, reload]);

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

  // add/remove는 반드시 그 repo의 main 워크트리(cwd=repoCwd)에서 실행 —
  // 모음 폴더나 다른 repo에서 실행하면 엉뚱한 저장소를 조작하게 된다.
  const addWorktree = (repoCwd: string) => {
    const path = window.prompt(`[${baseName(repoCwd)}] 새 워크트리 경로 (예: ../proj-feature)`);
    if (!path || !path.trim()) return;
    const branch = window.prompt("체크아웃할 브랜치");
    if (!branch || !branch.trim()) return;
    act(() => invoke("git_worktree_add", { cwd: repoCwd, path: path.trim(), branch: branch.trim() }));
  };

  const renderRow = (w: Worktree, repoCwd: string) => {
    const wtSessions = sessions.filter((s) => s.root === w.path);
    return (
      <div key={w.path} className="git-file">
        <span className="git-ref git-ref-local">{w.branch}</span>
        {w.is_main && (
          <span className="git-cmeta" title="메인 워크트리">
            메인
          </span>
        )}
        {wtSessions.length > 0 && (
          <span
            className="git-ref git-ref-head"
            title={`이 워크트리에서 도는 Claude 세션:\n${wtSessions.map((s) => s.uuid).join("\n")}`}
          >
            ● 세션 {wtSessions.length}
          </span>
        )}
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
              act(() => invoke("git_worktree_remove", { cwd: repoCwd, path: w.path }));
          }}
        >
          ×
        </button>
      </div>
    );
  };

  const total = groups.reduce((n, g) => n + g.worktrees.length, 0);
  const multi = groups.length > 1;

  return (
    <div className="git-panel">
      <div className="tree-hint">
        워크트리 = 같은 저장소의 <b>추가 작업 폴더</b>(각자 다른 브랜치를 동시 체크아웃). 병렬 작업
        격리용 — 브랜치 자체가 아니라 그 브랜치가 놓인 폴더입니다. ‘열기’로 프로젝트 탭에 엽니다.
      </div>
      <div className="git-head">
        <span className="git-track">
          워크트리 ({total}){multi ? ` · 저장소 ${groups.length}` : ""}
        </span>
        {!multi && groups.length === 1 && (
          <button
            className="git-btn"
            disabled={busy}
            title="새 워크트리 추가"
            onClick={() => addWorktree(groups[0].mainPath)}
          >
            + 추가
          </button>
        )}
        <button className="git-btn" disabled={busy} title="새로고침" onClick={() => void reload()}>
          ↻
        </button>
      </div>
      <div className="git-body">
        {groups.map((g) => (
          <div key={g.mainPath}>
            {multi && (
              <div className="git-head worktree-repo-head" title={g.mainPath}>
                <span className="git-track">{baseName(g.mainPath)}</span>
                <button
                  className="git-btn"
                  disabled={busy}
                  title={`${baseName(g.mainPath)}에 새 워크트리 추가`}
                  onClick={() => addWorktree(g.mainPath)}
                >
                  + 추가
                </button>
              </div>
            )}
            {g.worktrees.map((w) => renderRow(w, g.mainPath))}
          </div>
        ))}
        {total === 0 && <div className="git-clean">워크트리 없음</div>}
        {note && <div className="git-clean">{note}</div>}
      </div>
    </div>
  );
}
