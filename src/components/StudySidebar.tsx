import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/store";
import { StudyTree } from "./StudyTree";

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A study sidebar: pick a root folder, then browse it (mouse or keyboard). The
 * 뷰어/에디터 toggle controls how files open — viewer follows the tree cursor
 * (single preview), editor accumulates tabs. */
export function StudySidebar({ side, focusId }: { side: "left" | "right"; focusId?: string }) {
  const folder = useAppStore((s) => s.studyFolders[side]);
  const mode = useAppStore((s) => s.studyMode[side]);
  const setStudyFolder = useAppStore((s) => s.setStudyFolder);
  const setStudyMode = useAppStore((s) => s.setStudyMode);
  const openStudyTab = useAppStore((s) => s.openStudyTab);
  const openStudyPreview = useAppStore((s) => s.openStudyPreview);
  const [reloadSignal, setReloadSignal] = useState(0);

  const pick = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setStudyFolder(side, sel);
  };

  if (!folder) {
    return (
      <div className="study-sidebar study-sidebar-empty" id={focusId} tabIndex={-1}>
        <button className="toolbar-btn" onClick={() => void pick()}>
          폴더 선택
        </button>
        <span className="study-sb-hint">{side === "left" ? "좌측" : "우측"} 폴더를 선택하세요</span>
      </div>
    );
  }

  // viewer: cursor follows + Enter both replace the single preview.
  // editor: Enter/click accumulates tabs (no follow).
  const onActivate =
    mode === "viewer" ? (p: string) => openStudyPreview(side, p) : (p: string) => openStudyTab(side, p);
  const onPreview = mode === "viewer" ? (p: string) => openStudyPreview(side, p) : undefined;

  return (
    <div className="study-sidebar">
      <div className="study-sb-head" title={folder}>
        <span className="study-sb-name">{basename(folder)}</span>
        <button
          className="git-mini"
          title={mode === "viewer" ? "현재 뷰어(따라보기) — 에디터(탭)로 전환" : "현재 에디터(탭) — 뷰어(따라보기)로 전환"}
          onClick={() => setStudyMode(side, mode === "viewer" ? "editor" : "viewer")}
        >
          {mode === "viewer" ? "뷰어" : "에디터"}
        </button>
        <button className="git-mini" title="디스크에서 새로고침" onClick={() => setReloadSignal((n) => n + 1)}>
          ↻
        </button>
        <button className="git-mini" title="폴더 변경" onClick={() => void pick()}>
          ⋯
        </button>
      </div>
      <StudyTree
        root={folder}
        onActivate={onActivate}
        onPreview={onPreview}
        id={focusId}
        reloadSignal={reloadSignal}
      />
    </div>
  );
}
