import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errText } from "../utils/error";
import { useAppStore } from "../state/store";

/**
 * Dependency-graph browser (sidebar tab): a per-project probe → on-demand
 * generate → open-viewer flow over the `graph_*` tauri commands. Opening a
 * project only probes the cache (`graph_list`, no Opus run); when there's no
 * cached graph the user presses 생성 to run the one-shot Opus generation
 * (수백 초). An existing graph shows its 노드/엣지/생성시각 meta and opens the
 * rendered HTML viewer in the system browser (`graph_open_path`), mirroring the
 * ArchivePanel invoke/AppError/refresh-on-event conventions.
 *
 * Auto-generate on open and the `.claude` selection marker are deliberately out
 * of scope here (후속 작업) — this panel never runs Opus without an explicit
 * click.
 */

// Mirrors `commands::graph::GraphInfo` (serde). `graph_list` returns this or
// null (Rust `Option<GraphInfo>`) — null / absent means "no cached graph".
interface GraphInfo {
  json_path: string;
  html_path?: string | null;
  generated_at: string;
  nodes: number;
  edges: number;
}
// Mirrors `commands::graph::GraphPaths` (the `graph_generate` result).
interface GraphPaths {
  json_path: string;
  html_path: string;
}
// Mirrors the `graph-generated` event payload (`GraphGenerated`): `project` is
// the path that was generated for, so a listener can filter to its own project.
interface GraphGenerated {
  project: string;
  json_path: string;
  html_path: string;
}

// Best-effort local-time formatting of the graph's ISO-8601 generation stamp;
// fall back to the raw string if it doesn't parse (never hide the value).
const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function GraphPanel() {
  const activeProject = useAppStore((s) => s.activeProject);
  const [info, setInfo] = useState<GraphInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic token for generation requests. A `generate()` call captures the
  // current token; its then/catch/finally only touch state while that token is
  // still current — so a stale run (project switched away and back, or a second
  // generate superseding the first) can never resurrect old state or flip
  // `generating` for a newer request.
  const genToken = useRef(0);

  // Probe the cache for `project` (no Opus). Guards against a stale response
  // landing after the active project changed by re-checking the current store
  // value before applying.
  const load = (project: string) => {
    setLoading(true);
    setError(null);
    invoke<GraphInfo | null>("graph_list", { projectPath: project })
      .then((res) => {
        if (useAppStore.getState().activeProject !== project) return;
        setInfo(res ?? null);
      })
      .catch((e) => {
        if (useAppStore.getState().activeProject !== project) return;
        setError(errText(e));
      })
      .finally(() => {
        if (useAppStore.getState().activeProject === project) setLoading(false);
      });
  };

  // Re-probe whenever the active project changes (and reset transient state so a
  // previous project's graph never flashes for the new one).
  useEffect(() => {
    // Invalidate any in-flight generation from the previous project so its late
    // response can't apply to (or un-set `generating` on) the new one.
    genToken.current += 1;
    setInfo(null);
    setError(null);
    setGenerating(false);
    if (activeProject) load(activeProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  // Refresh when a generation finishes for THIS project — the panel may have been
  // triggered here or (future) elsewhere. Re-registered per project so the filter
  // compares against the right path; unlisten on change/unmount (async-listen
  // cleanup pattern, MainArea.tsx:487).
  useEffect(() => {
    if (!activeProject) return;
    const un = listen<GraphGenerated>("graph-generated", (e) => {
      if (e.payload.project === activeProject) load(activeProject);
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  // Run the one-shot Opus generation. The `graph-generated` event refreshes the
  // meta, and the awaited result is a second, self-sufficient refresh path (so a
  // dropped event never leaves the panel stale).
  const generate = () => {
    if (!activeProject) return;
    const project = activeProject;
    const token = (genToken.current += 1);
    // A result applies only when it is still the latest request AND the project
    // hasn't changed underneath it (the two guards are complementary: the token
    // rejects a superseded same-project run, activeProject rejects a switch away).
    const current = () =>
      genToken.current === token && useAppStore.getState().activeProject === project;
    setGenerating(true);
    setError(null);
    invoke<GraphPaths>("graph_generate", { projectPath: project })
      .then(() => {
        if (current()) load(project);
      })
      .catch((e) => {
        if (current()) setError(errText(e));
      })
      .finally(() => {
        if (current()) setGenerating(false);
      });
  };

  const openViewer = (path: string) => {
    invoke("graph_open_path", { path }).catch((e) => alert(`열기 실패: ${errText(e)}`));
  };

  return (
    <div className="archive-panel">
      <div className="archive-head">
        <span>의존성 그래프</span>
        {activeProject && !generating && (
          <span className="archive-head-actions">
            <button className="archive-refresh" title="다시 읽기" onClick={() => load(activeProject)}>
              ↻
            </button>
          </span>
        )}
      </div>
      {!activeProject ? (
        <div className="archive-empty">프로젝트를 선택하세요.</div>
      ) : generating ? (
        <div className="archive-empty">
          그래프 생성 중… (Opus 분석 — 수백 초 걸릴 수 있습니다)
        </div>
      ) : loading ? (
        <div className="archive-empty">확인 중…</div>
      ) : (
        <>
          {error && <div className="archive-error">{error}</div>}
          {info ? (
            <div className="graph-info">
              <div className="graph-meta">
                노드 {info.nodes} · 엣지 {info.edges}
                <br />
                생성: {fmtTime(info.generated_at)}
              </div>
              <div className="archive-session-actions">
                <button
                  className="archive-btn"
                  title={info.html_path ? "그래프 뷰어를 시스템 브라우저로 열기" : "렌더된 HTML이 없습니다 — 다시 생성하세요"}
                  disabled={!info.html_path}
                  onClick={() => info.html_path && openViewer(info.html_path)}
                >
                  뷰어 열기
                </button>
                <button
                  className="archive-btn"
                  title="그래프를 다시 생성합니다 (Opus 분석 — 수백 초)"
                  onClick={generate}
                >
                  다시 생성
                </button>
              </div>
            </div>
          ) : (
            <div className="graph-info">
              {!error && <div className="graph-meta">아직 생성된 그래프가 없습니다.</div>}
              <div className="archive-session-actions">
                <button
                  className="archive-btn"
                  title="프로젝트 의존성 그래프를 생성합니다 (Opus 분석 — 수백 초)"
                  onClick={generate}
                >
                  그래프 생성
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
