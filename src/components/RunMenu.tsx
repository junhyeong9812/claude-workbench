import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../state/store";
import type { RunTarget } from "../types";

/**
 * Toolbar "▶ 실행" menu: detects the active project's build/test toolchains
 * (cargo/npm/gradle/...) and runs the chosen command in a fresh terminal panel.
 * A polyglot repo shows one row per tool. Detection is read-only; running just
 * types the command into a terminal (the user sees full output + can re-run).
 */
export function RunMenu() {
  const activeProject = useAppStore((s) => s.activeProject);
  const requestRun = useAppStore((s) => s.requestRun);
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Re-detect whenever the active project changes.
  useEffect(() => {
    if (!activeProject) {
      setTargets([]);
      return;
    }
    let alive = true;
    invoke<RunTarget[]>("detect_run_targets", { dir: activeProject })
      .then((t) => {
        if (alive) setTargets(t);
      })
      .catch(() => {
        if (alive) setTargets([]);
      });
    return () => {
      alive = false;
    };
  }, [activeProject]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!activeProject || targets.length === 0) return null;

  const run = (cmd: string, label: string) => {
    requestRun({ project: activeProject, cmd, title: label });
    setOpen(false);
  };

  return (
    <div className="run-menu" ref={ref}>
      <button className="toolbar-btn" title="빌드/테스트 실행" onClick={() => setOpen((o) => !o)}>
        ▶ 실행
      </button>
      {open && (
        <div className="run-dropdown">
          {targets.map((t) => (
            <div key={t.kind} className="run-group">
              <div className="run-group-head">{t.kind}</div>
              {t.test && (
                <button className="run-item" onClick={() => run(t.test!, `test: ${t.kind}`)}>
                  ✓ 테스트 — <code>{t.test}</code>
                </button>
              )}
              {t.build && (
                <button className="run-item" onClick={() => run(t.build!, `build: ${t.kind}`)}>
                  🔨 빌드 — <code>{t.build}</code>
                </button>
              )}
              {!t.test && !t.build && <div className="run-item run-empty">실행 가능한 명령 없음</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
