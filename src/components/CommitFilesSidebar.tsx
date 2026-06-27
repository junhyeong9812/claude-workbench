import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";

interface CommitFile {
  path: string;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  M: "수정",
  A: "추가",
  D: "삭제",
  R: "이름변경",
  C: "복사",
  T: "타입변경",
};

/**
 * Second sidebar: lists the changed files of the commit selected in the Git panel
 * (so a commit with many files scrolls here, not inside an overlay). Navigable with
 * ↑/↓; Enter/click opens the file in the peek-style view. The top file auto-opens
 * so the view is populated immediately. Closes the whole history view via ✕.
 */
export function CommitFilesSidebar() {
  const gitHistory = useAppStore((s) => s.gitHistory);
  const gitHistoryFile = useAppStore((s) => s.gitHistoryFile);
  const openGitHistoryFile = useAppStore((s) => s.openGitHistoryFile);
  const closeGitHistory = useAppStore((s) => s.closeGitHistory);
  const requestClaudeOpen = useAppStore((s) => s.requestClaudeOpen);
  const requestDiff = useAppStore((s) => s.requestDiff);

  const [files, setFiles] = useState<CommitFile[]>([]);
  const [note, setNote] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const root = gitHistory?.root ?? "";
  const commit = gitHistory?.commit ?? "";

  // Load the commit's changed files; auto-open the top one into the file view, and
  // take focus so ↑/↓ work immediately. Keyed on the `gitHistory` *object* (a fresh
  // one per openGitHistory call) so re-clicking the same commit reloads + reopens.
  // Clearing `files` first avoids briefly showing the previous commit's list.
  useEffect(() => {
    if (!gitHistory) {
      setFiles([]);
      return;
    }
    const { root: r, commit: c } = gitHistory;
    let alive = true;
    setNote("");
    setFiles([]);
    listRef.current?.focus();
    invoke<CommitFile[]>("git_commit_files", { cwd: r, hash: c })
      .then((fs) => {
        if (!alive) return;
        setFiles(fs);
        if (fs.length > 0) openGitHistoryFile(r, c, fs[0].path);
      })
      .catch((e) => {
        if (alive) {
          setNote(errText(e));
          setFiles([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [gitHistory, openGitHistoryFile]);

  const activePath = gitHistoryFile?.path ?? null;

  // ↑/↓ move the selection (and open it); Ctrl+→ hands focus to the file view;
  // Esc closes the whole view.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeGitHistory();
      return;
    }
    // Ctrl+→ : focus the peek file view (Ctrl+← there returns focus here).
    if (e.key === "ArrowRight" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.querySelector<HTMLElement>(".commit-file-view")?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (files.length === 0) return;
    const cur = files.findIndex((f) => f.path === activePath);
    const next =
      e.key === "ArrowDown"
        ? Math.min((cur === -1 ? -1 : cur) + 1, files.length - 1)
        : Math.max((cur === -1 ? files.length : cur) - 1, 0);
    openGitHistoryFile(root, commit, files[next].path);
  };

  // Open a fresh review-dedicated Claude session seeded with this commit's
  // context. Claude reads the diff itself (`git show`) — we only point it at the
  // commit + the changed-file list, so the seed stays small.
  const startReview = () => {
    if (!gitHistory || files.length === 0) return;
    const fileList = files.map((f) => `- ${f.path} (${STATUS_LABEL[f.status] ?? f.status})`).join("\n");
    const seed =
      `이 커밋을 함께 코드리뷰하자. 커밋: ${commit}\n` +
      `변경 파일 ${files.length}개:\n${fileList}\n\n` +
      `먼저 \`git show ${commit}\` 로 변경을 확인하고, 버그·경계조건·설계 관점에서 리뷰해줘. ` +
      `내가 특정 파일/라인을 물으면 그 부분을 깊이 보자. (파일은 수정하지 말고 리뷰·설명만)`;
    // Open the commit diff as a dockview panel (left) and the review-dedicated
    // Claude session to its right — genuine side-by-side. The diff panel id
    // mirrors MainArea's dedupe key (`diff:<cwd>:<hash>`). Close the history
    // overlay so the dockview panels are visible.
    requestDiff({ title: `diff ${commit.slice(0, 8)}`, cwd: root, hash: commit });
    requestClaudeOpen({
      project: root,
      seed,
      title: `리뷰 ${commit.slice(0, 8)}`,
      referencePanelId: `diff:${root}:${commit}`,
    });
    closeGitHistory();
  };

  if (!gitHistory) return null;
  const short = commit.slice(0, 8);

  return (
    <div className="commit-files" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
      <div className="commit-files-head">
        <span className="commit-files-title" title={commit}>
          ⎇ {short}
        </span>
        <span className="commit-files-count">{files.length}개 파일</span>
        <button
          className="commit-review-btn"
          title="이 커밋을 Claude와 코드리뷰 (리뷰 전용 세션)"
          disabled={files.length === 0}
          onClick={startReview}
        >
          🤖 리뷰
        </button>
        <span className="commit-files-x" title="닫기 (Esc)" onClick={closeGitHistory}>
          ✕
        </span>
      </div>
      <div className="commit-files-body">
        {files.map((f) => (
          <div
            key={f.path}
            className={`commit-file-row${f.path === activePath ? " sel" : ""}`}
            title={f.path}
            onClick={() => {
              openGitHistoryFile(root, commit, f.path);
              listRef.current?.focus();
            }}
          >
            <span className={`commit-file-status cfs-${f.status || "M"}`}>
              {STATUS_LABEL[f.status] ?? f.status}
            </span>
            <span className="commit-file-path">{f.path.split("/").pop()}</span>
            <span className="commit-file-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
          </div>
        ))}
        {files.length === 0 && !note && <div className="git-clean">변경 파일 없음</div>}
        {note && <div className="git-clean">{note}</div>}
      </div>
    </div>
  );
}
