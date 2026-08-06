import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { resolveCloseRequest } from "./sessionClose";
import { CloseSessionModal } from "./CloseSessionModal";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";
import { recallArea, forgetArea, type PanelArea } from "../state/panelFocus";
import { isTransferring } from "../state/panelTransfer";
import { closePanelSession } from "../state/panelSession";
import { installDragOut, movePanelToNewWindow } from "../state/windowTransfer";
import {
  findPanelById,
  findSessionPanel,
  registerSurface,
  unregisterSurface,
} from "../state/surfaceRegistry";
import { DropTargetOverlay } from "./DropTargetOverlay";
import { installTransferTarget } from "../state/panelTransferTarget";
import { components, AppTab, type PanelKind } from "./panelRegistry";
import { closeEphemeralPanels } from "../state/ephemeralPanels";
import { openProjectMemo } from "../state/projectMemo";
import { type SessionDragPayload } from "./sessionDropZone";
import { useSessionDropZone } from "../hooks/useSessionDropZone";
import { resolveLayerMode, integratedIsFront } from "../state/layerRouting";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { fileName } from "./cmLang";
import { SessionPicker, useSessionPicker } from "./SessionPicker";
import { useSsh } from "./ssh/useSsh";
import { TerminalMenu } from "./ssh/TerminalMenu";
import { SshDialog } from "./ssh/SshDialog";
import { HostKeyModal } from "./ssh/HostKeyModal";

/** Move DOM focus into the active panel's *content* (xterm/CodeMirror/input),
 * not just the dockview group — dockview's `focus()` focuses the group only.
 *
 * Tab *switches* (Alt/click) are handled by the panels themselves (they focus
 * their content on remount); this is the Ctrl+B path, where the active panel is
 * already mounted but focus is elsewhere (the tree). `area` restores a Claude
 * panel's last sub-area; it retries across a few frames in case content is still
 * laying out. Under dockview's onlyWhenVisible mode only the active panel's
 * content is in `.dv-active-group`, so this never targets a hidden panel. */
function focusActivePanelContent(area?: PanelArea) {
  let tries = 0;
  const tick = () => {
    const group = document.querySelector(".main-dock .dv-active-group");
    if (group) {
      const selectors: string[] = [];
      if (area === "timeline") selectors.push(".claudeterm-timeline-pane .timeline-list");
      else if (area === "viewer") selectors.push(".claudeterm-viewer-pane");
      // Fallback (and the "term"/non-Claude case): first focusable content.
      selectors.push(".xterm-helper-textarea", ".cm-content", "textarea", "input", "[tabindex]");
      for (const sel of selectors) {
        const el = group.querySelector(sel) as HTMLElement | null;
        if (el && el.offsetParent !== null) {
          el.focus();
          return;
        }
      }
    }
    if (tries++ < 10) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * The 80% main area, backed by dockview.
 *
 * Per-project isolation is achieved by keying the <DockviewReact> on the active
 * project path: switching projects remounts dockview, which fires `onReady`
 * again and restores *that* project's saved layout (or an empty layout). Layout
 * changes are persisted back to the store via `onDidLayoutChange`.
 */
export function MainArea({
  project,
  secondary = false,
}: { project?: string; secondary?: boolean } = {}) {
  const activeProject = useAppStore((s) => s.activeProject);
  // 이 surface가 소유한 프로젝트: 주(primary)는 activeProject, 부(secondary)는
  // prop 고정(project-dual-surface). 부 surface는 **수동적 dock** — 전역 요청
  // 버스·window 리스너·창 수명 훅·메뉴/모달을 일절 소비/등록하지 않는다
  // (spec §2 단일 소비자 불변식). 아래 각 지점이 isPrimary로 게이트된다.
  const isPrimary = !secondary;
  const surfaceProject = secondary ? (project ?? null) : activeProject;
  const surfaceKey = isPrimary ? "primary" : "secondary";
  const theme = useAppStore((s) => s.theme);
  const projects = useAppStore((s) => s.projects);
  const projectModes = useAppStore((s) => s.projectModes);
  // MainArea is now always mounted (behind the dev layer when in dev mode), so
  // it must only consume main-area requests while it is the front layer.
  const layerMode = resolveLayerMode(projectModes, activeProject);
  const editorOpenRequest = useAppStore((s) => s.editorOpenRequest);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const diffRequest = useAppStore((s) => s.diffRequest);
  const requestDiff = useAppStore((s) => s.requestDiff);
  const claudeOpenRequest = useAppStore((s) => s.claudeOpenRequest);
  const requestClaudeOpen = useAppStore((s) => s.requestClaudeOpen);
  const runRequest = useAppStore((s) => s.runRequest);
  const requestRun = useAppStore((s) => s.requestRun);
  const focusMainRequest = useAppStore((s) => s.focusMainRequest);
  const focusSessionRequest = useAppStore((s) => s.focusSessionRequest);
  const setLayout = useAppStore((s) => s.setLayout);

  const apiRef = useRef<DockviewApi | null>(null);
  // Drop-out gesture (P3): one AbortController per in-progress tab drag bounds
  // the dragover/dragend listeners, and the onWillDragPanel subscription is
  // disposed on unmount — no stale listener can fire a late popout (review P3 #1).
  const dragSubRef = useRef<{ dispose: () => void } | null>(null);
  // De-dup set for panels docked INTO the main window from other windows (P4).
  const transferProcessedRef = useRef<Set<string>>(new Set());
  // Monotonic per-mount counter for human-friendly panel titles.
  const counterRef = useRef(0);
  // "+ Claude" 저장 세션 피커 — 상태·조회·표시는 SessionPicker 소유 (P5 F-b).
  // 여는 트리거(툴바 요청 버스)와 드롭 취소는 여기 남아 setPicker/openPicker만
  // 부른다.
  const picker = useSessionPicker({
    isPrimary,
    activeProject,
    getApi: () => apiRef.current,
  });
  const setPicker = picker.setPicker;
  const openPicker = picker.openPicker;
  // Close request raised by a Claude tab's × (B3-1).
  const closeRequest = useClaudeUi((s) => s.closeRequest);
  const clearClose = useClaudeUi((s) => s.clearClose);

  // "+ Terminal" 메뉴는 여기(요청 버스 소비자), 그 안의 SSH 연결 생성·다이얼로그
  // ·호스트키 확인은 components/ssh 소유 (P5 F-c).
  const [termMenu, setTermMenu] = useState(false);
  const ssh = useSsh({ isPrimary, getApi: () => apiRef.current, setTermMenu });
  // Flips true once the dockview api is ready (onReady). A pending claudeOpenRequest
  // that arrives during a project-switch remount waits on this so the panel lands in
  // the freshly-restored layout, not a null api.
  const [apiReady, setApiReady] = useState(false);

  // The layout for the project this mount belongs to (read once at onReady).
  const savedLayout = projects.find((p) => p.path === surfaceProject)?.layout;

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setApiReady(true);
    // surface 레지스트리 등록 (D3·D4) — 세션 중복 attach 방지·closeRequest
    // 소유 조회가 두 dock을 모두 본다. 키 리마운트 시 새 api가 덮어쓴다.
    registerSurface(surfaceKey, api);

    // Restore the saved layout first; a corrupt/incompatible blob must never
    // crash — fall back to an empty layout.
    if (savedLayout != null) {
      try {
        api.fromJSON(savedLayout as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.error("dockview fromJSON failed; starting empty", err);
      }
    }
    // 단발성 패널(타임라인 peek·프롬프트 정리)은 되살리지 않는다 ("persist 없음"): 레이아웃
    // 직렬화는 모든 패널을 담으므로, 복원 **직후** 제거해 재시작 부활을 끊는다.
    // onDidLayoutChange 구독 전에 호출하므로 이 제거 자체는 저장을 유발하지 않고,
    // 다음 실제 레이아웃 변경 때 정리된 상태가 저장된다.
    closeEphemeralPanels(api);

    // Persist after restore so the restore itself does not redundantly re-save.
    api.onDidLayoutChange(() => {
      if (!surfaceProject) return;
      // 부 surface가 주와 같은 프로젝트를 가리키는 전이 순간(교체 직전 프레임
      // ·teardown 이벤트)의 저장을 차단 — 부가 마지막에 부분 layout을 써서
      // 주 복원본을 덮으면 레이아웃 소실이다 (리뷰 D2).
      if (secondary && useAppStore.getState().activeProject === surfaceProject) return;
      setLayout(surfaceProject, api.toJSON());
    });

    // Real panel removal (close) -> close the backing session (spec §0.1). Tab/
    // project switches don't fire this, so those only detach (session lives).
    api.onDidRemovePanel((panel) => {
      // Drop this panel's remembered focus area (closed for good — not a switch).
      forgetArea(panel.id);
      const params = panel.params as { kind?: string; sessionId?: number } | undefined;
      if (typeof params?.sessionId !== "number") return;
      // A *transfer* to another window removes the panel here but the session must
      // survive (the target re-attaches). Claude sessions are refcounted, so we
      // still detach this window (closeIfLast=false during transfer); plain
      // terminals are single-owner, so a transfer skips their close entirely.
      const transferring = isTransferring(panel.id);
      if (params.kind === "claudeterm") {
        void closePanelSession(params as never, { closeIfLast: !transferring });
      } else if (!transferring) {
        void closePanelSession(params as never);
      }
    });

    // Drop-out / dock gesture: a tab released over another window docks into it,
    // over the desktop opens a new window, inside this window rearranges as usual
    // (review P3/P4). Shared wiring with popouts. Dispose any prior gesture from
    // an earlier (project-keyed) mount before re-installing (review P4-impl #5).
    dragSubRef.current?.dispose();
    // 창 분리 드래그는 주 surface만 — 전송 envelope가 activeProject 기준이라
    // 부 surface에서 끌면 프로젝트가 뒤바뀐다 (spec §2).
    if (isPrimary) dragSubRef.current = installDragOut(api);
  };

  // Tear down the drag gesture wiring on unmount + surface 레지스트리 해제.
  useEffect(() => {
    return () => {
      dragSubRef.current?.dispose();
      unregisterSurface(surfaceKey, apiRef.current ?? undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Receive panels docked INTO this (main) window from popouts — re-dock back
  // to main (review P4). apiRef is read per-event so a project-keyed remount
  // never leaves a stale dock.
  useEffect(() => {
    if (!isPrimary) return; // 창당 수신자 1개 — 부 surface 등록 시 이중 처리
    const label = getCurrentWindow().label;
    let un: (() => void) | undefined;
    installTransferTarget(label, () => apiRef.current, transferProcessedRef.current)
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  // Main-window shutdown: tell popouts to tear down their sessions and WAIT for
  // their acks (with a fallback timeout) before destroying them, so nothing
  // leaks — destroy() may skip a popout's own close handler (review P4-impl #2).
  useEffect(() => {
    if (!isPrimary) return; // 창 수명 훅은 주 surface만 등록(이중 등록 방지)
    const win = getCurrentWindow();
    if (win.label !== "main") return;
    const unP = win.onCloseRequested(async (event) => {
      event.preventDefault();
      // We took over the close: from here ONLY an explicit destroy() actually
      // closes the window. A teardown that throws or hangs must never leave the
      // app un-closable, so destroy() runs in `finally` AND a watchdog forces it
      // if the teardown stalls past the bound (the ack-wait below is already
      // capped at 2.5s; the watchdog covers a stuck IPC call too).
      const watchdog = setTimeout(() => {
        void win.destroy().catch(() => {});
      }, 4000);
      try {
        const others = (await getAllWindows()).filter((w) => w.label !== "main");
        if (others.length > 0) {
          const expected = others.map((w) => w.label);
          const acked = new Set<string>();
          const unAck = await listen<{ label: string }>("app-shutdown-ack", (e) =>
            acked.add(e.payload.label),
          );
          await emit("app-shutdown");
          const start = Date.now();
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (expected.every((l) => acked.has(l)) || Date.now() - start > 2500) resolve();
              else setTimeout(tick, 50);
            };
            tick();
          });
          unAck();
          await Promise.all(others.map((w) => w.destroy().catch(() => {})));
        }
      } catch (err) {
        console.error("main shutdown teardown failed; closing anyway", err);
      } finally {
        clearTimeout(watchdog);
        await win.destroy().catch(() => {});
      }
    });
    return () => {
      void unP.then((f) => f());
    };
  }, []);

  const addPanel = (
    kind: PanelKind,
    opts?: {
      loadSessionId?: string;
      title?: string;
      project?: string;
      path?: string;
      seed?: string;
      runCmd?: string;
      cwd?: string;
      /** claudeterm 전용: PTY를 띄울 디렉토리가 `project`와 달라야 할 때
       * (외부 세션 adopt — CLI는 세션이 만들어진 디렉토리에서만 resume한다). */
      spawnCwd?: string;
      /** claudeterm 전용: 인수 직전 live 재검증 요청 (1회성 — 세션이 열리면
       * 패널이 스스로 지운다). */
      adoptPending?: boolean;
      /** "within" = referencePanel의 그룹에 탭으로 추가 (드롭 존 중앙). */
      position?: {
        referencePanel: string;
        direction: "right" | "left" | "above" | "below" | "within";
      };
    },
  ) => {
    const api = apiRef.current;
    if (!api) return null;
    const n = ++counterRef.current;
    const title = opts?.title ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${n}`;
    // Terminals get the real PTY panel, claudeterm the real claude CLI + timeline,
    // editor a CodeMirror editor; anything else is a stub.
    const component =
      kind === "terminal"
        ? "terminal"
        : kind === "claudeterm"
          ? "claudeterm"
          : kind === "editor"
            ? "editor"
            : "placeholder";
    // Counter suffix: two same-kind panels in one millisecond (rapid dev-mode
    // opens) must not collide — dockview requires unique ids.
    // surface 접두사(m/s): 두 dock의 id 충돌 방지 (closeRequest 소유 판정 D3).
    const id = `${kind}-${isPrimary ? "m" : "s"}-${Date.now()}-${n}`;
    api.addPanel({
      id,
      component,
      title,
      // Position beside a reference panel (review: claude to the right of the
      // diff) only if that panel actually exists, else default placement.
      ...(opts?.position && api.getPanel(opts.position.referencePanel)
        ? { position: opts.position }
        : {}),
      params: {
        kind,
        title,
        ...(opts?.loadSessionId ? { loadSessionId: opts.loadSessionId } : {}),
        ...(opts?.project ? { project: opts.project } : {}),
        ...(opts?.path ? { path: opts.path } : {}),
        ...(opts?.seed ? { seed: opts.seed } : {}),
        ...(opts?.runCmd ? { runCmd: opts.runCmd } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.spawnCwd ? { spawnCwd: opts.spawnCwd } : {}),
        ...(opts?.adoptPending ? { adoptPending: true } : {}),
      },
    });
    return id;
  };

  // Open a file in the editor when requested (from the peek viewer or tree). Focus
  // an already-open editor for the same file instead of opening a duplicate.
  // (통합·개발 두 레이어가 동시 마운트되므로 — MainArea가 언마운트된다는 옛 전제
  // 폐기 — 앞 레이어인 통합 모드일 때만 소비한다. 개발 모드면 요청을 건드리지
  // 않고 그대로 두어 DevView가 소비하게 한다: 유실≠소비. layerMode를 deps에 넣어
  // 같은 틱 모드 전환에도 재평가된다.)
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 요청 버스 비소비 (spec §2)
    if (!integratedIsFront(layerMode)) return; // dev layer's request — leave it
    if (!editorOpenRequest) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready (mount/project switch) — keep the request
    const path = editorOpenRequest;
    // Clear only AFTER the side effect (activate/open) succeeds, so a throw leaves
    // the request in place to retry (side effect before clear, T1 / codex P2 E4).
    try {
      const existing = api.panels.find((p) => {
        const prm = p.params as { kind?: string; path?: string } | undefined;
        return prm?.kind === "editor" && prm.path === path;
      });
      if (existing) existing.api.setActive();
      else addPanel("editor", { path, title: fileName(path) });
      requestEditorOpen(null);
    } catch (err) {
      console.error("editorOpen failed; keeping request", err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest, apiReady, activeProject, layerMode]);

  // Open a diff panel (changed file or commit) when requested from the Git panel.
  // (통합·개발 두 레이어가 동시 마운트되므로 앞 레이어인 통합 모드일 때만 소비한다 —
  // 개발 모드면 요청을 클리어하지 않고 남겨 두어 통합 복귀 시 소비된다: 유실≠소비.)
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 요청 버스 비소비 (spec §2)
    if (!integratedIsFront(layerMode)) return; // dev layer in front — leave the request
    if (!diffRequest) return;
    const api = apiRef.current;
    if (!api) return;
    const spec = diffRequest;
    requestDiff(null);
    // Scope the dedupe key by cwd: with multi-root, two repos can share a path or
    // commit hash, and a cwd-less key would reactivate the wrong repo's diff (codex P1).
    const key = spec.hash
      ? `diff:${spec.cwd}:${spec.hash}`
      : `diff:${spec.cwd}:${spec.path}:${spec.staged ? 1 : 0}`;
    const existing = api.panels.find((p) => p.id === key);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: key,
      component: "diff",
      title: spec.title,
      params: { kind: "diff", ...spec },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffRequest, activeProject, layerMode]);

  // Open a new Claude session bound to a specific project when requested (the
  // worktree panel's one-click "Claude 열기"). A fresh loadSessionId seeds a new
  // task session; `project` pins it to that worktree's cwd regardless of which
  // tab is active afterwards.
  // (통합·개발 두 레이어가 동시 마운트되므로 앞 레이어인 통합 모드일 때만 소비한다 —
  // 개발 모드면 요청을 클리어하지 않고 남겨 두어 통합 복귀 시 소비된다: 유실≠소비.)
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 요청 버스 비소비 (spec §2)
    if (!integratedIsFront(layerMode)) return; // dev layer in front — leave the request
    if (!claudeOpenRequest) return;
    const { project, seed, title: reqTitle, referencePanelId } = claudeOpenRequest;
    // Only THIS project's mount may consume the request (MainArea is keyed by
    // activeProject): otherwise a not-yet-switched old mount would add the Claude
    // panel to the wrong project's dock (codex P1). Keep the request until the
    // worktree's mount is active.
    if (project !== activeProject) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready (project-switch remount) — keep the request; apiReady re-runs this
    requestClaudeOpen(null); // consume only once we can actually act
    const title = reqTitle ?? `Claude ${counterRef.current + 1}`;
    addPanel("claudeterm", {
      project,
      loadSessionId: crypto.randomUUID(),
      title,
      seed,
      ...(referencePanelId
        ? { position: { referencePanel: referencePanelId, direction: "right" as const } }
        : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeOpenRequest, apiReady, activeProject, layerMode]);

  // (개발 세션 ✓확인/🧪 소비는 DevView로 이관됨 — 통합 dock 안에 "개발 세션"
  // 부분 패널을 끼워 넣던 옛 경로는 제거. 이제 EditorPanel이 dev 레이어를 전면
  // 전환하고 DevView가 자기 dock의 개발 세션에 프롬프트를 전달한다.)

  // Build/test runner: open a terminal panel that runs the command.
  // (통합·개발 두 레이어가 동시 마운트되므로 앞 레이어인 통합 모드일 때만 소비한다 —
  // 개발 모드면 요청을 클리어하지 않고 남겨 두어 통합 복귀 시 소비된다: 유실≠소비.)
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 요청 버스 비소비 (spec §2)
    if (!integratedIsFront(layerMode)) return; // dev layer in front — leave the request
    if (!runRequest) return;
    if (runRequest.project !== activeProject) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready — keep the request; apiReady re-runs
    requestRun(null);
    addPanel("terminal", {
      title: runRequest.title,
      runCmd: runRequest.cmd,
      cwd: runRequest.project,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest, apiReady, activeProject, layerMode]);

  // 고아 closeRequest 백스톱 (리뷰 D3): 어느 surface도 패널을 소유하지 않으면
  // (전이 타이밍·이미 닫힌 패널) 요청이 영구 잔류해 ×가 먹통이 된다 — 주
  // surface가 1초 뒤 전 surface 조회로 확인하고 정리한다.
  useEffect(() => {
    if (!isPrimary || !closeRequest) return;
    const t = setTimeout(() => {
      if (useClaudeUi.getState().closeRequest === closeRequest && !findPanelById(closeRequest.panelId)) {
        clearClose();
      }
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRequest]);

  // Resolve a close request from a Claude tab's × (B3-1): 닫기 keeps the saved
  // history, 삭제 also removes it; both close the panel.
  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    // 실행부는 sessionClose 단일 출처 (P4 — Popout과 문자단위 동일이던 것).
    await resolveCloseRequest(req, activeProject, deleteHistory, (panelId) =>
      apiRef.current?.getPanel(panelId)?.api.close(),
    );
  };

  // Alt+←/→/↑/↓ moves between panels by SCREEN POSITION: when the layout is split
  // into groups (regions), it jumps to the nearest group in the pressed direction
  // (so a vertical split moves with ↑/↓, a side-by-side split with ←/→); within a
  // single region it cycles that region's tabs. Distinct from a Claude panel's
  // Ctrl+←/→ pane focus. (The newly-active panel focuses its own content on the
  // onlyWhenVisible remount — no focus call here, which would race the xterm.)
  useEffect(() => {
    if (!isPrimary) return; // window 단축키는 주 surface만 (이중 처리 방지)
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const dir =
        e.key === "ArrowRight"
          ? "right"
          : e.key === "ArrowLeft"
            ? "left"
            : e.key === "ArrowDown"
              ? "down"
              : e.key === "ArrowUp"
                ? "up"
                : null;
      if (!dir) return;
      const api = apiRef.current;
      if (!api) return;
      const cur = api.activeGroup;

      // 1) Directional jump to the nearest group (region) in the pressed direction.
      if (api.groups.length >= 2 && cur) {
        const cr = cur.element.getBoundingClientRect();
        const cx = cr.left + cr.width / 2;
        const cy = cr.top + cr.height / 2;
        const horizontal = dir === "left" || dir === "right";
        let best: (typeof api.groups)[number] | null = null;
        let bestDist = Infinity;
        for (const g of api.groups) {
          if (g === cur) continue;
          const r = g.element.getBoundingClientRect();
          const dx = r.left + r.width / 2 - cx;
          const dy = r.top + r.height / 2 - cy;
          const inDir =
            dir === "right" ? dx > 1 : dir === "left" ? dx < -1 : dir === "down" ? dy > 1 : dy < -1;
          if (!inDir) continue;
          // Penalize the off-axis distance so the picked region is the aligned one.
          const dist = (horizontal ? Math.abs(dx) : Math.abs(dy)) + (horizontal ? Math.abs(dy) : Math.abs(dx)) * 2;
          if (dist < bestDist) {
            bestDist = dist;
            best = g;
          }
        }
        if (best) {
          e.preventDefault();
          best.activePanel?.api.setActive();
          return;
        }
      }

      // 2) No aligned region (or a single group): cycle tabs within the current
      // region. Right/Down = next, Left/Up = prev (wraps).
      const panels = cur?.panels ?? api.panels;
      if (panels.length < 2) return;
      const fwd = dir === "right" || dir === "down";
      const idx = api.activePanel ? panels.indexOf(api.activePanel) : -1;
      const nextIdx = fwd ? (idx + 1) % panels.length : (idx - 1 + panels.length) % panels.length;
      e.preventDefault();
      panels[nextIdx].api.setActive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+B from the already-focused tree asks to focus the open tab (App bumps
  // focusMainRequest). dockview's focus() only focuses the active GROUP, so also
  // drop focus into the active panel's content (xterm/CodeMirror/…) so keyboard
  // input lands there. Skip the initial 0 so a fresh mount doesn't steal focus.
  const lastFocusHandledRef = useRef(0);
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 포커스 요청 비소비
    // Claim each distinct request once; a layerMode-only re-fire (deps) must not
    // replay an already-handled focus. Skip the initial 0 (fresh-mount steal).
    if (focusMainRequest === 0 || focusMainRequest === lastFocusHandledRef.current) return;
    lastFocusHandledRef.current = focusMainRequest;
    // Only the FRONT (integrated) layer takes the focus; when the dev layer is in
    // front, DevView's own consumer handles it instead (symmetric routing).
    if (!integratedIsFront(layerMode)) return;
    const api = apiRef.current;
    if (!api) return;
    api.focus();
    // Restore the active Claude panel's last sub-area (terminal/viewer/timeline);
    // for other panels `area` is undefined → first focusable content.
    focusActivePanelContent(recallArea(api.activePanel?.id ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMainRequest, layerMode]);

  // App-toolbar remote buttons (the main-toolbar row was absorbed into the app
  // toolbar — spec task 01): each is a bump counter consumed here because the
  // menu/picker UI and the dockview api live in this component. The handled refs
  // initialize to the CURRENT counter so a project-switch remount never replays
  // the previous window's press (unlike a 0-initialized ref).
  // All three buttons are disabled in the app toolbar while the dev layer is
  // front (parity with the pre-move UI, where they lived inside the integrated
  // layer and were unreachable in dev mode). A request that still arrives with
  // dev in front is a stale press: drop it — never silently flip the project's
  // persisted 통합/개발 mode from here (review A3).
  const termMenuRequest = useAppStore((s) => s.termMenuRequest);
  const termMenuHandledRef = useRef(termMenuRequest);
  useEffect(() => {
    if (!isPrimary) return;
    if (termMenuRequest === termMenuHandledRef.current) return;
    termMenuHandledRef.current = termMenuRequest;
    if (!integratedIsFront(layerMode)) return;
    setPicker(null);
    setTermMenu((v) => !v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termMenuRequest]);

  const claudePickerRequest = useAppStore((s) => s.claudePickerRequest);
  const claudePickerHandledRef = useRef(claudePickerRequest);
  useEffect(() => {
    if (!isPrimary) return;
    if (claudePickerRequest === claudePickerHandledRef.current) return;
    claudePickerHandledRef.current = claudePickerRequest;
    if (!integratedIsFront(layerMode)) return;
    setTermMenu(false);
    // Always (re)open — the pre-move button refetched sessions on every press
    // rather than toggling closed (review A4: 동작 보존; closing is the 취소
    // button's job).
    void openPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudePickerRequest]);

  // "메모" — 이 프로젝트의 메모 패널을 연다(이미 있으면 포커스). 다른 툴바
  // 버튼과 같은 bump 카운터 계약이고, 규칙(결정적 id·중복 방지)은 순수 모듈
  // state/projectMemo가 소유한다. 프로젝트가 없으면 저장 키가 없으므로 no-op.
  const memoRequest = useAppStore((s) => s.memoRequest);
  const memoHandledRef = useRef(memoRequest);
  useEffect(() => {
    if (!isPrimary) return;
    if (memoRequest === memoHandledRef.current) return;
    memoHandledRef.current = memoRequest;
    if (!integratedIsFront(layerMode)) return;
    const api = apiRef.current;
    if (!api || !activeProject) return;
    setTermMenu(false);
    setPicker(null);
    openProjectMemo(api, activeProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoRequest]);

  const detachPanelRequest = useAppStore((s) => s.detachPanelRequest);
  const detachHandledRef = useRef(detachPanelRequest);
  useEffect(() => {
    if (!isPrimary) return;
    if (detachPanelRequest === detachHandledRef.current) return;
    detachHandledRef.current = detachPanelRequest;
    // Only the front (integrated) dock detaches — the App button is disabled in
    // dev mode, so a request here while dev is front is a stale press: drop it.
    if (!integratedIsFront(layerMode)) return;
    const api = apiRef.current;
    if (api?.activePanel) void movePanelToNewWindow(api, api.activePanel.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detachPanelRequest]);

  /** Resume a saved session — already open (live uuid or resume id) → activate
   * that panel; otherwise open a claudeterm pinned to the session's own project
   * (activeProject 전환 없음 — spec §2 resume 의미 보존). `position`은 드롭 존
   * 배치(중앙='within'=그 그룹 탭, 가장자리=그 방향 스플릿). */
  const openOrActivateSession = (
    p: Omit<SessionDragPayload, "source">,
    position?: { referencePanel: string; direction: "right" | "left" | "above" | "below" | "within" },
  ) => {
    const api = apiRef.current;
    if (!api) return;
    // 중복 판정은 **전 surface** 조회 (D4) — 우측 dock에 열린 세션을 좌측에서
    // resume하면 같은 uuid 이중 attach가 되므로, 소유 패널을 활성화한다.
    const existing = findSessionPanel(p.uuid);
    if (existing) {
      existing.api.setActive();
      return;
    }
    // project는 항상 전달 — 디코더가 빈 문자열을 거부하므로(S8) 조용한
    // activeProject 폴백 경로가 없다.
    addPanel("claudeterm", {
      loadSessionId: p.uuid,
      project: p.project,
      ...(p.title ? { title: p.title } : {}),
      ...(position ? { position } : {}),
    });
  };

  // 아카이브 "이어서" 소비 (spec task 04) — claudeOpenRequest와 같은 keep-until-
  // consumable 계약: dev 레이어가 앞이면 요청을 남겨 두고(유실≠소비), 통합 복귀
  // 시 소비한다. 프로젝트 게이트는 없다(세션의 원 project를 pin해서 연다).
  const sessionResumeRequest = useAppStore((s) => s.sessionResumeRequest);
  const requestSessionResume = useAppStore((s) => s.requestSessionResume);
  useEffect(() => {
    if (!isPrimary) return; // 부 surface는 resume 요청 비소비
    if (!integratedIsFront(layerMode)) return;
    if (!sessionResumeRequest) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready — keep the request; apiReady re-runs
    const { uuid, project, title } = sessionResumeRequest;
    requestSessionResume(null); // consume only once we can actually act
    openOrActivateSession({ uuid, project, title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionResumeRequest, apiReady, layerMode]);

  // ---- 세션 드래그 배치 (spec task 03) — 훅으로 이관 (P5 F-a) --------------
  const {
    mainAreaRef,
    sessionDrop,
    onDragOver: onSessionDragOver,
    onDragLeave: onSessionDragLeave,
    onDrop: onSessionDrop,
  } = useSessionDropZone({
    isPrimary,
    integratedFront: integratedIsFront(layerMode),
    getApi: () => apiRef.current,
    openOrActivateSession,
    closePicker: () => setPicker(null),
  });

  // Attention roll-up cycle: activate the panel for the requested session uuid.
  // Matched by the panel's live `sessionUuid` or its resume `loadSessionId` (a
  // fresh session's uuid == its loadSessionId). No-op if no panel here owns it —
  // it lives in another window's dock (a documented limitation of the roll-up).
  useEffect(() => {
    // 단일 소비자(주 surface)가 **전 surface 조회**로 소유 패널을 찾아 활성화
    // (감사 N1: 부 surface가 전역 요청을 직접 구독하면 spec §2 단일 소비자
    // 불변식 위반 — 레지스트리 조회면 우측 세션 포커스와 원칙을 동시 충족).
    if (!isPrimary) return;
    if (!focusSessionRequest) return;
    const { uuid } = focusSessionRequest;
    const panel = findSessionPanel(uuid);
    if (!panel) return; // 이 창 어느 surface도 소유하지 않음 — 다른 창(기존 한계)
    // 레이어 스왑 접합: the target tab lives in this (integrated) dock — if the
    // dev layer is in front, bring integrated forward first so the activated tab
    // is actually visible (같은 원칙: 뷰-행 요청의 대칭 전환, layerRouting 참조).
    // 대상이 어느 surface든 integrated 레이어(dual 포함)를 앞으로 — dev 레이어
    // 뒤에서 activate되면 보이지 않는다 (기존 대칭 전환 원칙).
    if (!integratedIsFront(layerMode) && activeProject) {
      useAppStore.getState().setProjectMode(activeProject, "integrated");
    }
    panel.api.setActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSessionRequest]);

  return (
    <div
      className="main-area"
      ref={mainAreaRef}
      onDragOver={onSessionDragOver}
      onDragLeave={onSessionDragLeave}
      onDrop={onSessionDrop}
    >
      {isPrimary && <DropTargetOverlay />}
      {sessionDrop && (
        <div
          className="drop-session-zone"
          style={{
            left: sessionDrop.hl.left,
            top: sessionDrop.hl.top,
            width: sessionDrop.hl.width,
            height: sessionDrop.hl.height,
          }}
        />
      )}
      {/* Zero-height anchor for the dropdowns that used to hang off the removed
          main-toolbar row — the "+ Terminal"/"+ Claude" buttons now live in the
          app toolbar and drive these via store request counters (task 01). */}
      {isPrimary && (
      <div className="main-menus">
        {termMenu && (
          <TerminalMenu
            onClose={() => setTermMenu(false)}
            onLocalTerminal={() => addPanel("terminal")}
            onNewSsh={ssh.openNewSshDialog}
            onConnectSaved={ssh.connectSaved}
          />
        )}
        {picker.sessions !== null && (
          <SessionPicker ctl={picker} addPanel={addPanel} activeProject={activeProject} />
        )}
      </div>
      )}
      <DockviewReact
        key={surfaceProject ?? "none"}
        className={`dockview-theme-${theme === "light" ? "light" : "dark"} ${isPrimary ? "main-dock" : "secondary-dock"}`}
        components={components}
        defaultTabComponent={AppTab}
        onReady={onReady}
      />

      {/* 닫기 모달은 요청된 패널을 **소유한** surface만 띄운다 — 두 mount가
          같은 closeRequest를 이중 소비하지 않게. apiReady를 조건에 넣어
          판정이 리액티브하고(마운트 직후 ref null 창), id는 surface 접두사로
          유일하다 (리뷰 D3). */}
      {closeRequest && apiReady && apiRef.current?.getPanel(closeRequest.panelId) && (
        <CloseSessionModal
          onClose={() => void resolveClose(false)}
          onDelete={() => void resolveClose(true)}
          onCancel={() => clearClose()}
        />
      )}

      {isPrimary && ssh.sshForm && (
        <SshDialog form={ssh.sshForm} setForm={ssh.setSshForm} onSubmit={ssh.submit} />
      )}

      {isPrimary && ssh.hostKeyQueue[0] && (
        <HostKeyModal prompt={ssh.hostKeyQueue[0]} onAnswer={ssh.answerHostKey} />
      )}
    </div>
  );
}
