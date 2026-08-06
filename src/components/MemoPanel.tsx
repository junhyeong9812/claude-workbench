import { useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { MemoEditor, type MemoDoc, type MemoSaveResult } from "./MemoEditor";

export interface MemoParams {
  kind?: "memo";
  title?: string;
  /** 이 메모가 딸린 프로젝트 경로 (저장 키). */
  project?: string;
}

/**
 * 프로젝트 메모장 — 프로젝트당 롱폼 스크래치 문서 하나.
 *
 * 에디터·자동 저장·유실 방어선은 전부 {@link MemoEditor}가 소유한다(프롬프트 정리
 * 세션의 초안과 같은 계약을 써야 하므로 단일 출처). 여기 남은 것은 이 패널의
 * 저장 위치(`<app_data>/projects/<project_key>/memo.md` — `memo_read`/`memo_write`)와
 * 탭 활성화 시 커서 복귀뿐이다.
 */
export function MemoPanel(props: IDockviewPanelProps<MemoParams>) {
  const project = props.params.project;
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 탭이 활성화되면 커서를 에디터로 (열자마자 바로 쓸 수 있게).
  useEffect(() => {
    const d = props.api.onDidActiveChange(() => {
      if (props.api.isActive) {
        (hostRef.current?.querySelector(".cm-content") as HTMLElement | null)?.focus();
      }
    });
    return () => d.dispose();
  }, [props.api]);

  return (
    <div className="memo-panel" ref={hostRef}>
      {project ? (
        <MemoEditor
          storeKey={project}
          subtitle={project}
          read={(key) => invoke<MemoDoc>("memo_read", { project: key })}
          write={(key, text, baseHash) =>
            invoke<MemoSaveResult>("memo_write", { project: key, text, baseHash })
          }
        />
      ) : (
        <div className="memo-err">메모를 열 프로젝트가 없습니다</div>
      )}
    </div>
  );
}
