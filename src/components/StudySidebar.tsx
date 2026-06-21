import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/store";
import { StudyTree } from "./StudyTree";

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** A study sidebar: pick a root folder, then browse it; file click opens a tab
 * in this side's viewer. */
export function StudySidebar({ side }: { side: "left" | "right" }) {
  const folder = useAppStore((s) => s.studyFolders[side]);
  const setStudyFolder = useAppStore((s) => s.setStudyFolder);
  const openStudyTab = useAppStore((s) => s.openStudyTab);

  const pick = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setStudyFolder(side, sel);
  };

  if (!folder) {
    return (
      <div className="study-sidebar study-sidebar-empty">
        <button className="toolbar-btn" onClick={() => void pick()}>
          폴더 선택
        </button>
        <span className="study-sb-hint">{side === "left" ? "좌측" : "우측"} 폴더를 선택하세요</span>
      </div>
    );
  }

  return (
    <div className="study-sidebar">
      <div className="study-sb-head" title={folder}>
        <span className="study-sb-name">{basename(folder)}</span>
        <button className="git-mini" title="폴더 변경" onClick={() => void pick()}>
          ⋯
        </button>
      </div>
      <StudyTree root={folder} onOpenFile={(p) => openStudyTab(side, p)} />
    </div>
  );
}
