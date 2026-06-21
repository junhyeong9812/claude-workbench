import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import { computeGraph, GitGraphRow } from "./GitGraph";

/** Mirrors core_lib::git serialized types. */
interface FileChange {
  path: string;
  code: string;
  staged: boolean;
  conflicted: boolean;
}
interface GitStatus {
  is_repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_remote: boolean;
  merging: boolean;
  changes: FileChange[];
}
interface Branches {
  current: string;
  local: string[];
  remote: string[];
}
interface Commit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  date: string;
  refs: string;
  subject: string;
}

const errText = (e: unknown): string =>
  typeof e === "string" ? e : ((e as { message?: string })?.message ?? String(e));

const localOf = (remote: string): string => remote.split("/").slice(1).join("/") || remote;

type Ref = { kind: "head" | "local" | "remote" | "tag"; label: string };
function parseRefs(refs: string): Ref[] {
  if (!refs.trim()) return [];
  return refs
    .split(", ")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r): Ref => {
      if (r.startsWith("HEAD -> ")) return { kind: "head", label: r.slice("HEAD -> ".length) };
      if (r === "HEAD") return { kind: "head", label: "HEAD" };
      if (r.startsWith("tag: ")) return { kind: "tag", label: r.slice("tag: ".length) };
      if (r.includes("/")) return { kind: "remote", label: r };
      return { kind: "local", label: r };
    });
}

/** A node in the folder-tree view of changed files. */
interface TreeNode {
  name: string;
  path: string;
  change?: FileChange;
  children: Map<string, TreeNode>;
}
function buildTree(changes: FileChange[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const ch of changes) {
    const parts = ch.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.change = ch;
      node = child;
    });
  }
  return root;
}

/**
 * Git panel (G1) — built into the left sidebar (Git tab). Top half: branch +
 * staging/changes (flat or folder-tree, toggleable) + commit. Bottom half:
 * commit history with ref badges. Runs against `activeProject`'s cwd.
 */
export function GitPanel() {
  const cwd = useAppStore((s) => s.activeProject);
  const requestDiff = useAppStore((s) => s.requestDiff);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [view, setView] = useState<"tree" | "flat">("tree");
  const [sort, setSort] = useState<"date" | "topo" | "author">("date");
  const reqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      setBranches(null);
      setCommits([]);
      return;
    }
    const myReq = ++reqRef.current;
    const target = cwd;
    try {
      const st = await invoke<GitStatus>("git_status", { cwd: target });
      if (reqRef.current !== myReq) return;
      setStatus(st);
      if (st.is_repo) {
        const [br, lg] = await Promise.all([
          invoke<Branches>("git_branches", { cwd: target }).catch(() => null),
          invoke<Commit[]>("git_log", { cwd: target, limit: 200, order: sort }).catch(
            () => [] as Commit[],
          ),
        ]);
        if (reqRef.current !== myReq) return;
        setBranches(br);
        setCommits(lg ?? []);
      } else {
        setBranches(null);
        setCommits([]);
      }
    } catch (e) {
      if (reqRef.current === myReq) setNote(errText(e));
    }
  }, [cwd, sort]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>, okNote = ""): Promise<boolean> => {
    setBusy(true);
    setNote("");
    let ok = false;
    try {
      await fn();
      ok = true;
      if (okNote) setNote(okNote);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
      await reload();
    }
    return ok;
  };

  if (!cwd) return <div className="git-empty">프로젝트를 먼저 여세요.</div>;
  if (status && !status.is_repo) return <div className="git-empty">git 저장소가 아닙니다.</div>;

  const conflicted = status?.changes.filter((c) => c.conflicted) ?? [];
  const staged = status?.changes.filter((c) => c.staged && !c.conflicted) ?? [];
  const unstaged = status?.changes.filter((c) => !c.staged && !c.conflicted) ?? [];
  const merging = status?.merging ?? false;
  // During a merge, conclude via the banner's '계속'(merge --continue) instead of
  // a normal commit, so the prepared merge message is used (codex TF-2).
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy && !merging;

  const fileRow = (c: FileChange, label: string, depth: number, kind: "staged" | "unstaged"): ReactNode => (
    <div key={c.path} className="git-file" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className={`git-code${kind === "staged" ? " git-staged" : ""}`}>
        {c.code || (kind === "staged" ? "·" : "??")}
      </span>
      <span
        className="git-path git-clickable"
        title={`${c.path}\n(클릭: diff 보기)`}
        onClick={() =>
          requestDiff({
            title: c.path.split("/").pop() ?? c.path,
            cwd: cwd as string,
            path: c.path,
            staged: kind === "staged",
          })
        }
      >
        {label}
      </span>
      {kind === "unstaged" && (
        <button
          className="git-mini"
          disabled={busy}
          title="변경 취소(restore)"
          onClick={() => {
            if (window.confirm(`${c.path}의 변경을 취소할까요?`))
              act(() => invoke("git_discard", { cwd, path: c.path }));
          }}
        >
          ↩
        </button>
      )}
      <button
        className="git-mini"
        disabled={busy}
        onClick={() =>
          act(() => invoke(kind === "staged" ? "git_unstage" : "git_stage", { cwd, path: c.path }))
        }
      >
        {kind === "staged" ? "−" : "+"}
      </button>
    </div>
  );

  const renderNode = (node: TreeNode, depth: number, kind: "staged" | "unstaged"): ReactNode[] => {
    const out: ReactNode[] = [];
    const entries = [...node.children.values()].sort((a, b) => {
      const ad = a.children.size > 0;
      const bd = b.children.size > 0;
      if (ad !== bd) return ad ? -1 : 1; // directories first
      return a.name.localeCompare(b.name);
    });
    for (const child of entries) {
      if (child.change && child.children.size === 0) {
        out.push(fileRow(child.change, child.name, depth, kind));
      } else {
        out.push(
          <div key={`d:${child.path}`} className="git-dir" style={{ paddingLeft: 8 + depth * 12 }}>
            {child.name}/
          </div>,
        );
        out.push(...renderNode(child, depth + 1, kind));
      }
    }
    return out;
  };

  const renderGroup = (list: FileChange[], kind: "staged" | "unstaged"): ReactNode =>
    view === "flat"
      ? list.map((c) => fileRow(c, c.path, 0, kind))
      : renderNode(buildTree(list), 0, kind);

  return (
    <div className="git-panel">
      {/* Top half: branch, changes, commit */}
      <div className="git-top">
        <div className="git-head">
          <span className="git-branch" title="브랜치 전환">
            ⎇{" "}
            <select
              value={status?.branch ?? ""}
              disabled={busy}
              onChange={(e) => act(() => invoke("git_checkout", { cwd, branch: e.target.value }))}
            >
              {!branches?.local.includes(status?.branch ?? "") && status?.branch && (
                <option value={status.branch}>{status.branch}</option>
              )}
              <optgroup label="로컬">
                {branches?.local.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </optgroup>
              {branches && branches.remote.length > 0 && (
                <optgroup label="원격">
                  {branches.remote.map((r) => (
                    <option key={r} value={localOf(r)}>
                      {r}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </span>
          <button
            className="git-btn"
            disabled={busy}
            title="새 브랜치 생성"
            onClick={() => {
              const name = window.prompt("새 브랜치 이름");
              if (name && name.trim()) act(() => invoke("git_create_branch", { cwd, name: name.trim() }));
            }}
          >
            + 브랜치
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="브랜치 삭제"
            onClick={() => {
              const name = window.prompt("삭제할 브랜치 이름");
              if (!name || !name.trim()) return;
              if (!window.confirm(`'${name.trim()}' 브랜치를 삭제할까요?`)) return; // cancel = abort
              const force = window.confirm("머지 안 됐어도 강제 삭제(-D)? (확인=강제 / 취소=안전 삭제 -d)");
              act(() => invoke("git_delete_branch", { cwd, name: name.trim(), force }));
            }}
          >
            − 브랜치
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="브랜치 머지(현재 브랜치로)"
            onClick={() => {
              const b = window.prompt("현재 브랜치에 머지할 브랜치");
              if (b && b.trim()) act(() => invoke("git_merge", { cwd, branch: b.trim() }), "머지 완료");
            }}
          >
            merge
          </button>
          <span className="git-track">
            {status ? `↑${status.ahead} ↓${status.behind}` : ""}
            {status && !status.has_remote ? " (원격없음)" : ""}
          </span>
          <button
            className="git-btn"
            disabled={busy || !status?.has_remote}
            title="fetch --all --prune"
            onClick={() => act(() => invoke("git_fetch", { cwd }), "fetch 완료")}
          >
            fetch
          </button>
          <button
            className="git-btn"
            disabled={busy || !status?.has_remote}
            title="pull"
            onClick={() => act(() => invoke("git_pull", { cwd }), "pull 완료")}
          >
            pull
          </button>
          <button
            className="git-btn"
            disabled={busy || !status?.has_remote}
            title="현재 브랜치 push"
            onClick={() => act(() => invoke("git_push", { cwd }), "push 완료")}
          >
            push
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="변경을 stash에 저장"
            onClick={() => {
              const m = window.prompt("stash 메시지(선택)") ?? "";
              act(() => invoke("git_stash_save", { cwd, message: m }), "stash 저장");
            }}
          >
            stash
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="최근 stash 적용(pop)"
            onClick={() => {
              if (window.confirm("최근 stash를 적용(pop)할까요? (적용 후 stash에서 제거됩니다)"))
                act(() => invoke("git_stash_pop", { cwd }), "stash pop");
            }}
          >
            pop
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="HEAD에 태그 생성"
            onClick={() => {
              const name = window.prompt("태그 이름");
              if (!name || !name.trim()) return;
              const message = window.prompt("주석 메시지 (비우면 lightweight)") ?? "";
              act(() => invoke("git_create_tag", { cwd, name: name.trim(), message }), "태그 생성");
            }}
          >
            tag
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title="태그 삭제"
            onClick={() => {
              const name = window.prompt("삭제할 태그 이름");
              if (!name || !name.trim()) return;
              if (!window.confirm(`태그 '${name.trim()}'를 삭제할까요?`)) return;
              act(() => invoke("git_delete_tag", { cwd, name: name.trim() }), "태그 삭제");
            }}
          >
            tag−
          </button>
          <button
            className="git-btn"
            disabled={busy}
            title={view === "tree" ? "목록형으로" : "폴더형으로"}
            onClick={() => setView((v) => (v === "tree" ? "flat" : "tree"))}
          >
            {view === "tree" ? "▤" : "▥"}
          </button>
          <button className="git-btn" disabled={busy} title="새로고침" onClick={() => void reload()}>
            ↻
          </button>
        </div>

        <div className="git-body">
          {merging && (
            <div className="git-merge-banner">
              <span>머지 진행 중 — 충돌 {conflicted.length}개</span>
              <button
                className="git-mini"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("머지를 중단(abort)할까요? 변경이 머지 전 상태로 돌아갑니다."))
                    act(() => invoke("git_merge_abort", { cwd }), "머지 중단");
                }}
              >
                중단
              </button>
              <button
                className="git-mini"
                disabled={busy || conflicted.length > 0}
                title={conflicted.length > 0 ? "충돌을 모두 해결(stage)한 뒤 가능" : "머지 커밋"}
                onClick={() => act(() => invoke("git_merge_continue", { cwd }), "머지 완료")}
              >
                계속
              </button>
            </div>
          )}
          {conflicted.length > 0 && (
            <>
              <div className="git-section-head git-conflict-head">충돌 ({conflicted.length})</div>
              {conflicted.map((c) => (
                <div key={c.path} className="git-file">
                  <span className="git-code git-conflict">{c.code || "U"}</span>
                  <span
                    className="git-path git-clickable"
                    title={`${c.path}\n(클릭: diff 보기)`}
                    onClick={() =>
                      requestDiff({
                        title: c.path.split("/").pop() ?? c.path,
                        cwd: cwd as string,
                        path: c.path,
                        staged: false,
                      })
                    }
                  >
                    {c.path}
                  </span>
                  <button
                    className="git-mini"
                    disabled={busy}
                    title="에디터로 충돌 마커 직접 편집"
                    onClick={() => requestEditorOpen(`${cwd}/${c.path}`)}
                  >
                    편집
                  </button>
                  <button
                    className="git-mini"
                    disabled={busy}
                    title="내 쪽(현재 브랜치)으로 해결"
                    onClick={() => act(() => invoke("git_resolve_ours", { cwd, path: c.path }))}
                  >
                    내것
                  </button>
                  <button
                    className="git-mini"
                    disabled={busy}
                    title="상대 쪽(머지 대상)으로 해결"
                    onClick={() => act(() => invoke("git_resolve_theirs", { cwd, path: c.path }))}
                  >
                    상대
                  </button>
                  <button
                    className="git-mini"
                    disabled={busy}
                    title="편집 후 해결됨으로 표시(stage)"
                    onClick={() => act(() => invoke("git_stage", { cwd, path: c.path }))}
                  >
                    해결
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="git-section-head">
            스테이지됨 ({staged.length})
            {staged.length > 0 && (
              <button
                className="git-mini"
                disabled={busy}
                onClick={() =>
                  act(() => Promise.all(staged.map((c) => invoke("git_unstage", { cwd, path: c.path }))))
                }
              >
                전체 해제
              </button>
            )}
          </div>
          {renderGroup(staged, "staged")}

          <div className="git-section-head">
            변경됨 ({unstaged.length})
            {unstaged.length > 0 && (
              <button className="git-mini" disabled={busy} onClick={() => act(() => invoke("git_stage_all", { cwd }))}>
                모두 스테이지
              </button>
            )}
          </div>
          {renderGroup(unstaged, "unstaged")}
          {status?.changes.length === 0 && <div className="git-clean">변경 사항 없음 (clean)</div>}
        </div>

        <div className="git-commit">
          <textarea
            className="git-msg"
            placeholder="커밋 메시지"
            value={message}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="git-commit-row">
            <button
              className="git-btn git-commit-btn"
              disabled={!canCommit}
              onClick={async () => {
                const ok = await act(() => invoke("git_commit", { cwd, message: message.trim() }), "커밋 완료");
                if (ok) setMessage("");
              }}
            >
              커밋 ({staged.length})
            </button>
            {note && <span className="git-note">{note}</span>}
          </div>
        </div>
      </div>

      {/* Bottom half: commit history graph */}
      <div className="git-graph-pane">
        <div className="git-section-head">
          히스토리
          <select
            className="git-sort"
            value={sort}
            disabled={busy}
            title="그래프 정렬"
            onChange={(e) => setSort(e.target.value as "date" | "topo" | "author")}
          >
            <option value="date">커밋 날짜순</option>
            <option value="topo">토폴로지순</option>
            <option value="author">작성 날짜순</option>
          </select>
        </div>
        <div className="git-graph">
          {(() => {
            const rows = computeGraph(commits);
            const maxLanes = rows.reduce((m, r) => Math.max(m, r.before.length, r.after.length), 1);
            return rows.map((row) => {
              const c = row.commit;
              const refs = parseRefs(c.refs);
              return (
                <div
                  key={c.hash}
                  className="git-commit-row-g git-clickable"
                  title={`${c.short} · ${c.author} · ${c.date}\n(클릭: 커밋 변경 보기)`}
                  onClick={() => requestDiff({ title: `${c.short} ${c.subject}`, cwd: cwd as string, hash: c.hash })}
                >
                  <GitGraphRow row={row} maxLanes={maxLanes} />
                  <span className="git-chash">{c.short}</span>
                  {refs.map((r, i) => (
                    <span key={i} className={`git-ref git-ref-${r.kind}`}>
                      {r.label}
                    </span>
                  ))}
                  <span className="git-subject" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="git-cmeta">{c.date}</span>
                </div>
              );
            });
          })()}
          {commits.length === 0 && <div className="git-clean">커밋 없음</div>}
        </div>
      </div>
    </div>
  );
}
