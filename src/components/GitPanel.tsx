import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";

/** Mirrors core_lib::git serialized types. */
interface FileChange {
  path: string;
  code: string;
  staged: boolean;
}
interface GitStatus {
  is_repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_remote: boolean;
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
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [view, setView] = useState<"tree" | "flat">("tree");
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
          invoke<Commit[]>("git_log", { cwd: target, limit: 200 }).catch(() => [] as Commit[]),
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
  }, [cwd]);

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

  const staged = status?.changes.filter((c) => c.staged) ?? [];
  const unstaged = status?.changes.filter((c) => !c.staged) ?? [];
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  const fileRow = (c: FileChange, label: string, depth: number, kind: "staged" | "unstaged"): ReactNode => (
    <div key={c.path} className="git-file" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className={`git-code${kind === "staged" ? " git-staged" : ""}`}>
        {c.code || (kind === "staged" ? "·" : "??")}
      </span>
      <span className="git-path" title={c.path}>
        {label}
      </span>
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
          <span className="git-track">
            {status ? `↑${status.ahead} ↓${status.behind}` : ""}
            {status && !status.has_remote ? " (원격없음)" : ""}
          </span>
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
        <div className="git-section-head">히스토리</div>
        <div className="git-graph">
          {commits.map((c) => {
            const refs = parseRefs(c.refs);
            const merge = c.parents.length > 1;
            return (
              <div key={c.hash} className="git-commit-row-g" title={`${c.short} · ${c.author} · ${c.date}`}>
                <span className={`git-node${merge ? " git-node-merge" : ""}`}>{merge ? "◆" : "●"}</span>
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
          })}
          {commits.length === 0 && <div className="git-clean">커밋 없음</div>}
        </div>
      </div>
    </div>
  );
}
