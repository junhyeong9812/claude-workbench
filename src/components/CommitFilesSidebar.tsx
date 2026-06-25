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

  // ↑/↓ move the selection (and open it); Esc closes the whole view.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeGitHistory();
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

  if (!gitHistory) return null;
  const short = commit.slice(0, 8);

  return (
    <div className="commit-files" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
      <div className="commit-files-head">
        <span className="commit-files-title" title={commit}>
          ⎇ {short}
        </span>
        <span className="commit-files-count">{files.length}개 파일</span>
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
