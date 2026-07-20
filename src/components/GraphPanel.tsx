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
 * Below the project-level graph, a "marked folders" section (task-07) lists the
 * folders the user opted in by placing a `.claude` marker directory
 * (`graph_marked_folders`). Each folder generates / opens its own graph through
 * the same `graph_generate` / `graph_open_path` commands (passing the folder
 * path), with per-folder race guards so switching projects or overlapping
 * generations never resurrect stale state. This panel never runs Opus without an
 * explicit click.
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
// Mirrors `commands::graph::MarkedFolder` (serde) — a `.claude`-marked folder
// under the active project. `path` is what we pass to graph_generate/open.
interface MarkedFolder {
  path: string;
  rel: string;
  has_graph: boolean;
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

  // Marked-folder (task-07) state: the `.claude`-opted folders under the active
  // project, which of them are mid-generation, and any list-load error.
  const [markers, setMarkers] = useState<MarkedFolder[]>([]);
  const [markersError, setMarkersError] = useState<string | null>(null);
  const [genFolders, setGenFolders] = useState<Set<string>>(new Set());
  // Per-folder monotonic tokens — same race discipline as `genToken`, keyed by
  // folder path so overlapping folder generations don't cross-cancel.
  const folderTokens = useRef<Map<string, number>>(new Map());

  // Load the marked-folder list for `project` (a bounded fs scan, no Opus).
  // Stale-response guarded against the active project like `load`.
  const loadMarkers = (project: string) => {
    invoke<MarkedFolder[]>("graph_marked_folders", { projectPath: project })
      .then((res) => {
        if (useAppStore.getState().activeProject !== project) return;
        setMarkers(res ?? []);
        setMarkersError(null);
      })
      .catch((e) => {
        if (useAppStore.getState().activeProject !== project) return;
        setMarkers([]);
        setMarkersError(errText(e));
      });
  };

  // Generate the graph for one marked folder. Reuses `graph_generate` with the
  // folder path; a per-folder token + active-project check reject stale results.
  const generateFolder = (folderPath: string) => {
    if (!activeProject) return;
    const project = activeProject;
    const token = (folderTokens.current.get(folderPath) ?? 0) + 1;
    folderTokens.current.set(folderPath, token);
    const current = () =>
      folderTokens.current.get(folderPath) === token &&
      useAppStore.getState().activeProject === project;
    setGenFolders((prev) => new Set(prev).add(folderPath));
    invoke<GraphPaths>("graph_generate", { projectPath: folderPath })
      .then(() => {
        if (current()) loadMarkers(project);
      })
      .catch((e) => {
        if (current()) alert(`생성 실패: ${errText(e)}`);
      })
      .finally(() => {
        if (current())
          setGenFolders((prev) => {
            const next = new Set(prev);
            next.delete(folderPath);
            return next;
          });
      });
  };

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
    // Reset marker state so a previous project's folders never flash for the new
    // one; in-flight folder gens are rejected by the active-project check.
    setMarkers([]);
    setMarkersError(null);
    setGenFolders(new Set());
    if (activeProject) {
      load(activeProject);
      loadMarkers(activeProject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  // Refresh when a generation finishes for THIS project — the panel may have been
  // triggered here or (future) elsewhere. Re-registered per project so the filter
  // compares against the right path; unlisten on change/unmount (async-listen
  // cleanup pattern, MainArea.tsx:487).
  useEffect(() => {
    if (!activeProject) return;
    const un = listen<GraphGenerated>("graph-generated", (e) => {
      // Project-level generation refreshes the project meta; any generation
      // (project- or folder-level) may change a marked folder's cache state, so
      // re-probe the marker list too (bounded fs scan, no Opus).
      if (e.payload.project === activeProject) load(activeProject);
      loadMarkers(activeProject);
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

  // Open a marked folder's viewer: MarkedFolder carries only `has_graph`, so
  // resolve the folder's html_path via graph_list (same cache probe) then open it.
  const openFolderGraph = (folderPath: string) => {
    invoke<GraphInfo | null>("graph_list", { projectPath: folderPath })
      .then((res) => {
        if (res?.html_path) openViewer(res.html_path);
        else alert("렌더된 그래프 HTML이 없습니다 — 다시 생성하세요.");
      })
      .catch((e) => alert(`열기 실패: ${errText(e)}`));
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

          <div className="graph-markers">
            <div className="graph-markers-head">
              마커 폴더 (<code>.claude</code>)
            </div>
            {markersError ? (
              <div className="archive-error">{markersError}</div>
            ) : markers.length === 0 ? (
              <div className="graph-meta">
                <code>.claude</code> 폴더로 표시된 대상이 없습니다.
              </div>
            ) : (
              <ul className="graph-marker-list">
                {markers.map((m) => {
                  const busy = genFolders.has(m.path);
                  return (
                    <li key={m.path} className="graph-marker">
                      <span className="graph-marker-rel" title={m.path}>
                        {m.rel}
                      </span>
                      <span className="archive-session-actions">
                        {busy ? (
                          <span className="graph-meta">생성 중…</span>
                        ) : (
                          <>
                            <button
                              className="archive-btn"
                              title="이 폴더의 의존성 그래프를 생성합니다 (Opus 분석 — 수백 초)"
                              onClick={() => generateFolder(m.path)}
                            >
                              {m.has_graph ? "다시 생성" : "생성"}
                            </button>
                            <button
                              className="archive-btn"
                              title={m.has_graph ? "이 폴더의 그래프 뷰어 열기" : "먼저 생성하세요"}
                              disabled={!m.has_graph}
                              onClick={() => openFolderGraph(m.path)}
                            >
                              열기
                            </button>
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
