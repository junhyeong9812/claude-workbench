import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { errText } from "../utils/error";
import { baseName } from "./treeDnd";

/** import_paths 백엔드 결과 — copied/conflicts/errors 3분류(무음 실패 없음). */
interface ImportOutcome {
  copied: string[];
  conflicts: string[];
  errors: string[];
}

/** `#dropzone=<dest>::<root>` 해시 파라미터. 둘 다 encodeURIComponent됨. */
function parseHash(): { dest: string; root: string } | null {
  const h = window.location.hash;
  if (!h.startsWith("#dropzone=")) return null;
  const [dest, root] = h.slice("#dropzone=".length).split("::");
  if (!dest || !root) return null;
  return { dest: decodeURIComponent(dest), root: decodeURIComponent(root) };
}

/**
 * OS 파일 반입용 드롭 존 보조 창 (파일트리 DnD spec §1②).
 *
 * 메인 창은 dockview 탭 드래그(HTML5 DnD) 때문에 `dragDropEnabled: false`가
 * 강제라 OS 드롭을 못 받는다 — 이 창만 `dragDropEnabled: true`로 열려 Tauri
 * 네이티브 드롭 이벤트를 받아 대상 폴더로 **복사**한다(원본 이동·삭제 없음).
 * 충돌은 확인 후 overwrite 재호출. 메인 트리는 4초 폴링이 자동 반영한다.
 */
export function DropZoneWindow() {
  const params = parseHash();
  const [hovering, setHovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // 드롭 연타 시 처리 순서를 직렬화 (이전 import가 끝나기 전 재드롭 무시).
  const busyRef = useRef(false);

  useEffect(() => {
    if (!params) return;
    const un = getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === "enter" || t === "over") setHovering(true);
      else if (t === "leave") setHovering(false);
      else if (t === "drop") {
        setHovering(false);
        const paths = event.payload.paths;
        if (busyRef.current || paths.length === 0) return;
        busyRef.current = true;
        setBusy(true);
        void (async () => {
          try {
            const first = await invoke<ImportOutcome>("import_paths", {
              sources: paths,
              destDir: params.dest,
              root: params.root,
              overwrite: false,
            });
            let outcome = first;
            if (first.conflicts.length > 0) {
              const names = first.conflicts.map(baseName).join(", ");
              if (window.confirm(`이미 존재: ${names}\n기존 항목을 덮어쓸까요?`)) {
                const second = await invoke<ImportOutcome>("import_paths", {
                  sources: first.conflicts,
                  destDir: params.dest,
                  root: params.root,
                  overwrite: true,
                });
                outcome = {
                  copied: [...first.copied, ...second.copied],
                  conflicts: second.conflicts,
                  errors: [...first.errors, ...second.errors],
                };
              } else {
                outcome = { ...first, conflicts: [] }; // 사용자가 건너뛰기 선택
              }
            }
            setLog((prev) => [
              ...outcome.errors.map((e) => `⚠ ${e}`),
              ...outcome.copied.map((p) => `✓ ${baseName(p)}`),
              ...prev,
            ]);
          } catch (e) {
            setLog((prev) => [`⚠ 가져오기 실패: ${errText(e)}`, ...prev]);
          } finally {
            busyRef.current = false;
            setBusy(false);
          }
        })();
      }
    });
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!params) {
    return <div className="dropzone dropzone-err">드롭 존 파라미터가 없습니다.</div>;
  }
  return (
    <div className={`dropzone${hovering ? " dropzone-hover" : ""}`}>
      <div className="dropzone-target" title={params.dest}>
        📥 <b>{baseName(params.dest) || params.dest}</b> 폴더로 복사
      </div>
      <div className="dropzone-hint">
        {busy ? "복사 중…" : "OS 파일매니저에서 파일/폴더를 여기로 끌어다 놓으세요"}
      </div>
      <div className="dropzone-log">
        {log.map((line, i) => (
          <div key={i} className="dropzone-log-line">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
