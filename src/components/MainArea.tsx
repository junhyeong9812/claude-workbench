import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useAppStore } from "../state/store";
import { useClaudeUi } from "../state/claudeUi";
import { recallArea, forgetArea, type PanelArea } from "../state/panelFocus";
import { isTransferring } from "../state/panelTransfer";
import { closePanelSession } from "../state/panelSession";
import { installDragOut, movePanelToNewWindow } from "../state/windowTransfer";
import { DropTargetOverlay } from "./DropTargetOverlay";
import { installTransferTarget } from "../state/panelTransferTarget";
import { components, AppTab, type PanelKind } from "./panelRegistry";
import {
  SESSION_DRAG_MIME,
  decodeSessionDrag,
  encodeSessionDrag,
  resolveDropZone,
  sameZoneRect,
  zoneHighlight,
  type DropZone,
  type SessionDragPayload,
  type ZoneRect,
} from "./sessionDropZone";
import { resolveLayerMode, integratedIsFront } from "../state/layerRouting";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { fileName } from "./cmLang";
import { fmtUnix } from "../utils/time";

/** Archive freshness of a saved session — the picker's three groups.
 * `current` = 아카이브가 최신, `stale` = 아카이브 이후 작업 있음, `none` = 아카이브 없음. */
type ArchState = "current" | "stale" | "none";

/** A saved session normalized for the reopen picker (ACP `claude` or A
 * `claudeterm`). `id` is the session UUID. */
interface SessionSummary {
  id: string;
  date: string;
  name: string;
  title: string;
  count: number;
  /** The project (cwd) this session belongs to — passed through on reopen. */
  project: string;
  /** Archive freshness (책·요약·지식 유무 + 최신 여부) — picker grouping. */
  archState: ArchState;
  /** When the latest archive was written (unix seconds), if archived. */
  archivedAt: number | null;
  /** Preserved past archive versions of this session. */
  versions: number;
}


/** Transient new-connection dialog form state. The secret fields never enter
 * panel params or workspace.json — they go to `ssh_create` (this session) and,
 * when "save" is on, to the OS keychain. */
interface SshForm {
  label: string;
  host: string;
  port: string;
  username: string;
  authKind: "password" | "publickey" | "agent";
  keyPath: string;
  password: string;
  passphrase: string;
  save: boolean;
}

/** The picker's archive groups, in display order. */
const PICKER_GROUPS: { key: ArchState; label: string; hint: string }[] = [
  { key: "current", label: "📦 아카이브됨", hint: "아카이브가 최신입니다 (책·요약·지식 있음)" },
  {
    key: "stale",
    label: "🕓 아카이브 이후 작업",
    hint: "아카이브 뒤에 세션이 더 진행됐습니다 — 다시 아카이브하면 최신화됩니다",
  },
  { key: "none", label: "미아카이브", hint: "아카이브가 없습니다" },
];

const EMPTY_SSH_FORM: SshForm = {
  label: "",
  host: "",
  port: "22",
  username: "",
  authKind: "password",
  keyPath: "",
  password: "",
  passphrase: "",
  save: true,
};

interface HostKeyPrompt {
  id: number;
  host: string;
  port: number;
  fingerprint: string;
}

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
  // Saved-session picker for "+ Claude" (null = closed) + the name a "새 세션"
  // would get (B3-4: per-project "Claude N", computed when the picker opens).
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // Mirror of `picker` for the archive-event listener (its closure would
  // otherwise capture a stale snapshot).
  const pickerRef = useRef<SessionSummary[] | null>(null);
  pickerRef.current = picker;
  // 이 프로젝트의 아카이브가 지금 실행 중인지 (picker "아카이브 진행중" 배지).
  const [archBusy, setArchBusy] = useState(false);
  // in_flight 조회 세대 — 늦게 도착한 낡은 응답이 배지를 되돌리지 못하게.
  const archReqRef = useRef(0);
  // Collapsed picker groups (아카이브됨/아카이브 이후 작업/아카이브 없음).
  const [pickerCollapsed, setPickerCollapsed] = useState<Set<ArchState>>(new Set());
  // Which kind the open picker creates/reopens: ACP `claude` or A `claudeterm`.
  const [newName, setNewName] = useState("Claude 1");
  // Close request raised by a Claude tab's × (B3-1).
  const closeRequest = useClaudeUi((s) => s.closeRequest);
  const clearClose = useClaudeUi((s) => s.clearClose);

  // SSH: saved connections + the "+ Terminal" menu / new-connection dialog /
  // host-key (TOFU) confirmation modal.
  const savedConnections = useAppStore((s) => s.savedConnections);
  const upsertConnection = useAppStore((s) => s.upsertConnection);
  const deleteConnection = useAppStore((s) => s.deleteConnection);
  const persistScrollback = useAppStore((s) => s.persistScrollback);
  const setPersistScrollback = useAppStore((s) => s.setPersistScrollback);
  const [termMenu, setTermMenu] = useState(false);
  const [sshForm, setSshForm] = useState<SshForm | null>(null);
  // A queue (not a single slot) so two connections prompting for unknown host
  // keys at once don't clobber each other — each is answered in turn (P3-R2).
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPrompt[]>([]);
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

    // Restore the saved layout first; a corrupt/incompatible blob must never
    // crash — fall back to an empty layout.
    if (savedLayout != null) {
      try {
        api.fromJSON(savedLayout as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.error("dockview fromJSON failed; starting empty", err);
      }
    }

    // Persist after restore so the restore itself does not redundantly re-save.
    api.onDidLayoutChange(() => {
      if (surfaceProject) {
        setLayout(surfaceProject, api.toJSON());
      }
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

  // Tear down the drag gesture wiring on unmount.
  useEffect(() => {
    return () => dragSubRef.current?.dispose();
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
    const id = `${kind}-${Date.now()}-${n}`;
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
      },
    });
    return id;
  };

  // Create an SSH session (backend connects async) and open a panel attached to
  // it. The secret (password/passphrase) is passed to `ssh_create` only — it is
  // NOT placed in panel params (which persist in the layout): reconnect after a
  // restart pulls the secret from the keychain via `connectionId` (review F8).
  const connectSsh = async (o: {
    title: string;
    host: string;
    port: number;
    username: string;
    authKind: "password" | "publickey" | "agent";
    keyPath?: string | null;
    connectionId?: string | null;
    password?: string | null;
    passphrase?: string | null;
  }) => {
    const api = apiRef.current;
    if (!api) return;
    try {
      // Generate the panel id up front so it can double as the scrollback
      // persistence key (opt-in — review F11).
      const panelId = `ssh-${Date.now()}`;
      const persistKey = useAppStore.getState().persistScrollback ? panelId : null;
      const id = await invoke<number>("ssh_create", {
        host: o.host,
        port: o.port,
        username: o.username,
        authKind: o.authKind,
        password: o.password ?? null,
        keyPath: o.keyPath ?? null,
        passphrase: o.passphrase ?? null,
        connectionId: o.connectionId ?? null,
        persistKey,
        cols: 80,
        rows: 24,
      });
      api.addPanel({
        id: panelId,
        component: "ssh",
        title: o.title,
        params: {
          kind: "ssh",
          title: o.title,
          sessionId: id,
          host: o.host,
          port: o.port,
          username: o.username,
          authKind: o.authKind,
          keyPath: o.keyPath ?? null,
          connectionId: o.connectionId ?? null,
        },
      });
    } catch (err) {
      console.error("ssh_create failed", err);
    }
  };

  // Connect to a previously saved connection (no dialog). The secret comes from
  // the keychain via the connection id.
  const connectSaved = (id: string) => {
    setTermMenu(false);
    const c = savedConnections.find((x) => x.id === id);
    if (!c) return;
    connectSsh({
      title: c.label || `${c.username}@${c.host}`,
      host: c.host,
      port: c.port,
      username: c.username,
      authKind: c.auth_kind,
      keyPath: c.key_path ?? null,
      connectionId: c.id,
    });
  };

  // Submit the new-connection dialog: optionally save (keychain secret + store
  // metadata), then connect.
  const submitSshForm = async () => {
    const f = sshForm;
    if (!f) return;
    const host = f.host.trim();
    const username = f.username.trim();
    if (!host || !username) return; // minimal validation; dialog enforces more
    const port = Number(f.port) || 22;
    const label = f.label.trim() || `${username}@${host}`;
    const secret = f.authKind === "password" ? f.password : f.passphrase;

    let connectionId: string | undefined;
    if (f.save) {
      const cid = crypto.randomUUID();
      let storeOk = true;
      if (secret) {
        // No plaintext fallback (review F9): if the keychain rejects, we do NOT
        // create a saved connection (it would be broken on reconnect — P3-R3).
        try {
          await invoke("ssh_store_secret", { id: cid, secret });
        } catch {
          storeOk = false;
        }
      }
      if (!secret || storeOk) {
        connectionId = cid;
        upsertConnection({
          id: cid,
          label,
          host,
          port,
          username,
          auth_kind: f.authKind,
          key_path: f.authKind === "publickey" ? f.keyPath.trim() || null : null,
          has_stored_secret: !!secret,
        });
      } else {
        alert(
          "OS 키체인에 비밀번호를 저장하지 못했습니다. 이 연결은 저장하지 않고 세션 전용으로 접속합니다.",
        );
      }
    }
    setSshForm(null);
    setTermMenu(false);
    await connectSsh({
      title: label,
      host,
      port,
      username,
      authKind: f.authKind,
      keyPath: f.authKind === "publickey" ? f.keyPath.trim() || null : null,
      connectionId: connectionId ?? null,
      password: f.authKind === "password" ? f.password : null,
      passphrase: f.authKind === "publickey" ? f.passphrase : null,
    });
  };

  // Global host-key (TOFU) prompt: the backend raises `ssh-hostkey-prompt` for a
  // first-seen host; we enqueue it and show the fingerprint. Also surface SSH
  // connect/auth **failures** here — a not-yet-mounted panel can miss the
  // `ssh-status` event, so handling it globally guarantees it's never silent
  // (review P3-R1).
  useEffect(() => {
    if (!isPrimary) return; // 전역 알림/모달은 주 surface 1곳만
    const unPrompt = listen<HostKeyPrompt>("ssh-hostkey-prompt", (e) => {
      setHostKeyQueue((q) => [...q, e.payload]);
    });
    const unStatus = listen<{ id: number; phase: string; reason?: string | null }>(
      "ssh-status",
      (e) => {
        if (e.payload.phase === "failed") {
          alert(`SSH 연결 실패: ${e.payload.reason ?? "알 수 없는 오류"}`);
        }
      },
    );
    return () => {
      unPrompt.then((f) => f()).catch(() => {});
      unStatus.then((f) => f()).catch(() => {});
    };
  }, []);

  const answerHostKey = (accept: boolean) => {
    const p = hostKeyQueue[0];
    setHostKeyQueue((q) => q.slice(1));
    if (!p) return;
    invoke("ssh_hostkey_decision", { id: p.id, accept }).catch((e) => {
      // Surface the failure: the backend never got the decision, so the SSH
      // connect will hang — at least make the cause findable in devtools.
      console.error("ssh_hostkey_decision failed", e);
    });
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

  // Resolve a close request from a Claude tab's × (B3-1): 닫기 keeps the saved
  // history, 삭제 also removes it; both close the panel.
  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    // Delete must target the session's *own* project (a workspace-wide reopen can
    // open a task from a project other than the active tab) — codex P2 F1.
    const project = req.project ?? activeProject;
    // 삭제: tear the WHOLE session down (force-close every viewer) before deleting
    // its history, so a mirror in another window can't recreate the snapshot. 닫기:
    // just close the panel — onDidRemovePanel detaches this window (refcount, P6).
    if (req.kind === "claudeterm" && deleteHistory && typeof req.ptyId === "number") {
      await invoke("claude_close", { id: req.ptyId }).catch(() => {});
      if (req.sessionId && project) {
        await invoke("claude_delete", { project, uuid: req.sessionId }).catch(() => {});
      }
    }
    apiRef.current?.getPanel(req.panelId)?.api.close();
  };

  /** Session ids currently open in a panel (live `sessionId`/`sessionUuid` or
   * read-only `loadSessionId`), so the picker can exclude them (B3-2). */
  const openSessionIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const p of apiRef.current?.panels ?? []) {
      const prm = p.params as
        | { sessionId?: string; sessionUuid?: string; loadSessionId?: string }
        | undefined;
      // claude panels carry a string sessionId; claudeterm's sessionId is the
      // numeric PTY id, so its session UUID is `sessionUuid`.
      if (typeof prm?.sessionId === "string") ids.add(prm.sessionId);
      if (prm?.sessionUuid) ids.add(prm.sessionUuid);
      if (prm?.loadSessionId) ids.add(prm.loadSessionId);
    }
    return ids;
  };

  /** Open panels of `kind` (for numbering): empty sessions never persist, so the
   * next number is saved sessions + currently-open panels of that kind + 1. */
  const openKindCount = (kind: PanelKind): number =>
    (apiRef.current?.panels ?? []).filter(
      (p) => (p.params as { kind?: string } | undefined)?.kind === kind,
    ).length;

  // "+ Claude(A)": open the picker — name a new session or reopen a saved
  // (not-already-open) one. Per-project (active project). Sessions are a flat,
  // newest-first list — 새 태스크 = 순수 새 세션 (아카이브 모델, 체인 없음).
  const openPicker = async () => {
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      const myReq = ++archReqRef.current;
      const [raw, statuses, inFlight] = await Promise.all([
        invoke<
          {
            uuid: string;
            name: string;
            title: string;
            date: string;
            count: number;
          }[]
        >("claude_sessions", { project: activeProject }).catch(() => []),
        invoke<
          { uuid: string; up_to_date: boolean; archived_at: number | null; versions: number }[]
        >("archive_status", { project: activeProject }).catch(() => []),
        invoke<boolean>("archive_in_flight", { project: activeProject }).catch(() => false),
      ]);
      const byUuid = new Map(statuses.map((s) => [s.uuid, s]));
      sessions = raw.map((s) => {
        const st = byUuid.get(s.uuid);
        return {
          id: s.uuid,
          name: s.name,
          title: s.title,
          date: s.date,
          count: s.count,
          project: activeProject,
          archState: (st ? (st.up_to_date ? "current" : "stale") : "none") as ArchState,
          archivedAt: st?.archived_at ?? null,
          versions: st?.versions ?? 0,
        };
      });
      if (archReqRef.current === myReq) setArchBusy(inFlight);
    }
    setNewName(`Claude ${sessions.length + openKindCount("claudeterm") + 1}`);
    setPicker(sessions); // open-session filtering happens at render
  };

  // 진행중 배지 실시간화: 아카이브 시작/종료 브로드캐스트를 받아 배지를 갱신
  // 하고, 종료 시 picker가 열려 있으면 그룹 분류를 새로 가져온다. payload의
  // raw cwd를 activeProject와 문자열 비교하면 경로 정규화 차이(심링크·슬래시)
  // 에 취약하므로, 이벤트는 트리거로만 쓰고 판정은 백엔드 in_flight 재조회로
  // 한다 (리뷰 F7 — 백엔드가 canonicalize로 동일성을 판정).
  useEffect(() => {
    if (!isPrimary) return; // 피커는 주 surface 전용
    const refresh = () => {
      if (!activeProject) return;
      // started/finished 연속 발생 시 응답 역전으로 낡은 true가 나중에 도착해
      // 배지가 busy에 갇힐 수 있다 — 최신 요청만 반영(post-fix P4).
      const my = ++archReqRef.current;
      void invoke<boolean>("archive_in_flight", { project: activeProject })
        .then((v) => {
          if (archReqRef.current === my) setArchBusy(v);
        })
        .catch(() => {
          // 최신 요청이 실패하면 이전 응답도 세대 가드에 막혀 배지가 고착될
          // 수 있다 — 정보성 배지는 미표시가 고착보다 낫다(fail-soft).
          if (archReqRef.current === my) setArchBusy(false);
        });
    };
    const un1 = listen("mt-archive-started", refresh);
    const un2 = listen("mt-archive-finished", () => {
      refresh();
      if (pickerRef.current !== null) void openPicker();
    });
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  // Picker rows: saved sessions newest-first, excluding already-open ones.
  const pickerRows = (): SessionSummary[] => {
    if (picker == null) return [];
    const open = openSessionIds();
    return picker
      .filter((s) => !open.has(s.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  };

  const createNewSession = () => {
    const name = newName.trim() || "Claude";
    setPicker(null);
    // Give the new session a stable UUID up front so it's saved in the layout
    // immediately → resumes the same session after restart (create-or-resume in
    // claude_start handles the not-yet-chatted case). #6
    // Pin the session to the current project so its cwd basis is stable (the panel
    // reads `params.project` as sessionCwd; an `activeProject` fallback would shift
    // if the user switches tabs while the session lives — codex P2).
    addPanel("claudeterm", {
      title: name,
      loadSessionId: crypto.randomUUID(),
      project: activeProject ?? undefined,
    });
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
    const existing = api.panels.find((pl) => {
      const prm = pl.params as { sessionUuid?: string; loadSessionId?: string } | undefined;
      return prm?.sessionUuid === p.uuid || prm?.loadSessionId === p.uuid;
    });
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

  // ---- 세션 드래그 배치 (spec task 03) ------------------------------------
  // 아카이브/피커 행 드래그가 dock 위를 지날 때: 마우스가 올라간 그룹의 존
  // (중앙/가장자리 20%)을 계산해 하이라이트하고, 드롭 시 그 위치로 연다.
  // 전용 MIME에만 반응 — 트리 DnD·탭 창간 전송·OS Files와 무간섭 (spec §2).
  // dockview 자체 droptarget은 외부 드래그를 onUnhandledDragOverEvent 수락
  // 시에만 받는데 우리는 구독하지 않으므로 dockview 오버레이는 뜨지 않는다
  // (dockviewComponent.js rootCanDisplayOverlay — 리뷰 S10 실코드 확인).
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [sessionDrop, setSessionDrop] = useState<{
    referencePanel: string | null;
    zone: DropZone;
    /** .main-area 로컬 좌표의 하이라이트 사각형. */
    hl: ZoneRect;
  } | null>(null);
  // dragleave 지연 클리어 타이머 — WebKitGTK는 자식 경계 전이에서도
  // relatedTarget이 null일 수 있어(리뷰 S5) 즉시 지우면 60Hz 깜빡인다.
  // 다음 dragover가 취소하고, 진짜 이탈이면 타이머가 지운다.
  const dropLeaveTimerRef = useRef<number | null>(null);
  // 드래그 직전 실제로 눌린 요소 — dragstart의 e.target은 HTML DnD 표준상
  // draggable 조상(행)이라 내부 버튼 판별이 불가능하다(리뷰 S6 감사, WHATWG
  // dnd). mousedown 캡처로 기록해 dragstart에서 판별한다.
  const dragPressRef = useRef<EventTarget | null>(null);
  const cancelLeaveTimer = () => {
    if (dropLeaveTimerRef.current !== null) {
      window.clearTimeout(dropLeaveTimerRef.current);
      dropLeaveTimerRef.current = null;
    }
  };

  const isSessionDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(SESSION_DRAG_MIME);

  /** 좌표 → 드롭 타깃. dragover(프리뷰)와 drop(실행)이 **같은 함수·같은 입력**
   * 을 쓴다 — 렌더 state를 drop의 진실로 쓰면 마지막 dragover 커밋 전의 drop이
   * 직전 존으로 열린다(리뷰 S1: dragover=continuous, drop=discrete 우선순위
   * 역전). null = 유효한 드롭 위치 아님(비어 있지 않은 dock의 그룹 밖 여백 포함
   * — 리뷰 S7: "빈 dock"만 기본 배치 대상). */
  const computeSessionDropTarget = (
    x: number,
    y: number,
  ): { referencePanel: string | null; zone: DropZone; hl: ZoneRect } | null => {
    const api = apiRef.current;
    const host = mainAreaRef.current?.getBoundingClientRect();
    if (!api || !host) return null;
    // 겹치는 그룹(저장 레이아웃이 floating group을 복원할 수 있다 — 리뷰 S12
    // 감사)은 히트한 것 중 **최소 면적**을 고른다: floating은 타일 위에 더
    // 작게 떠 있으므로 최상단(가장 안쪽)을 근사한다.
    let best: { ref: string; rect: DOMRect; zone: DropZone; area: number } | null = null;
    for (const g of api.groups) {
      // 빈 그룹(activePanel도 panels[0]도 없음)은 프리뷰-결과 계약을 지킬 수
      // 없어 대상에서 제외한다 (리뷰 S3).
      const ref = g.activePanel ?? g.panels[0];
      if (!ref) continue;
      const r = g.element.getBoundingClientRect();
      const zone = resolveDropZone(r, x, y);
      if (zone === null) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { ref: ref.id, rect: r, zone, area };
    }
    if (best) {
      const hl = zoneHighlight(best.rect, best.zone);
      return {
        referencePanel: best.ref,
        zone: best.zone,
        hl: {
          left: hl.left - host.left,
          top: hl.top - host.top,
          width: hl.width,
          height: hl.height,
        },
      };
    }
    if (api.panels.length === 0) {
      return {
        referencePanel: null,
        zone: "center",
        hl: { left: 0, top: 0, width: host.width, height: host.height },
      };
    }
    return null;
  };

  const onSessionDragOver = (e: React.DragEvent) => {
    if (!isPrimary) return; // 드롭 존은 주 surface 전용 (부는 수동적 dock)
    if (!isSessionDrag(e)) return;
    if (!integratedIsFront(layerMode)) return;
    cancelLeaveTimer();
    // 피커 위는 드롭 대상이 아니다 — 좌표 히트테스트가 피커 '뒤' 그룹으로
    // 새면, 되돌려 놓기(취소) 제스처가 실제 열기가 된다 (리뷰 S7b).
    if ((e.target as HTMLElement).closest?.(".claude-picker")) {
      setSessionDrop(null);
      return;
    }
    const next = computeSessionDropTarget(e.clientX, e.clientY);
    if (!next) {
      setSessionDrop(null); // preventDefault 없이 반환 → 이 좌표는 드롭 불허
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // dragover는 초당 수십 회 — 동일 타깃이면 setState 생략 (rect 4값 전부 비교, S4).
    setSessionDrop((prev) =>
      prev &&
      prev.referencePanel === next.referencePanel &&
      prev.zone === next.zone &&
      sameZoneRect(prev.hl, next.hl)
        ? prev
        : next,
    );
  };

  const onSessionDragLeave = (e: React.DragEvent) => {
    if (!isSessionDrag(e)) return;
    const rt = e.relatedTarget;
    if (rt instanceof Node && mainAreaRef.current?.contains(rt)) return; // 내부 이동
    cancelLeaveTimer();
    dropLeaveTimerRef.current = window.setTimeout(() => {
      dropLeaveTimerRef.current = null;
      setSessionDrop(null);
    }, 120);
  };

  const onSessionDrop = (e: React.DragEvent) => {
    if (!isPrimary) return;
    if (!isSessionDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    cancelLeaveTimer();
    setSessionDrop(null);
    if (!integratedIsFront(layerMode)) return;
    if ((e.target as HTMLElement).closest?.(".claude-picker")) return; // 피커 위 드롭 = 취소
    const payload = decodeSessionDrag(e.dataTransfer.getData(SESSION_DRAG_MIME));
    if (!payload) return;
    // 드롭 좌표로 재계산 — 하이라이트와 결과가 항상 같은 입력에서 나온다 (S1).
    const target = computeSessionDropTarget(e.clientX, e.clientY);
    if (!target) return; // 유효 위치 아님 — 아무것도 열지 않음
    if (payload.source === "picker") setPicker(null); // 피커 드래그만 피커를 닫는다 (S11)
    openOrActivateSession(
      payload,
      target.referencePanel
        ? {
            referencePanel: target.referencePanel,
            direction: target.zone === "center" ? "within" : target.zone,
          }
        : undefined,
    );
  };

  // 취소 백스톱 (리뷰 S2): Esc·창 밖 드롭·다른 핸들러의 drop 소비(stopPropagation)
  // 는 dragleave/drop을 우리에게 보장하지 않는다 — window 캡처 단계에서 정리.
  // (onSessionDrop은 state가 아니라 드롭 좌표 재계산을 쓰므로, 캡처 단계에서
  // 먼저 지워져도 무해하다.)
  useEffect(() => {
    if (!isPrimary) return;
    const clear = () => {
      cancelLeaveTimer();
      setSessionDrop(null);
    };
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, []);
  // 드래그 중 레이어가 dev로 바뀌면 프리뷰 제거.
  useEffect(() => {
    if (!integratedIsFront(layerMode)) setSessionDrop(null);
  }, [layerMode]);

  // Attention roll-up cycle: activate the panel for the requested session uuid.
  // Matched by the panel's live `sessionUuid` or its resume `loadSessionId` (a
  // fresh session's uuid == its loadSessionId). No-op if no panel here owns it —
  // it lives in another window's dock (a documented limitation of the roll-up).
  useEffect(() => {
    if (!isPrimary) return; // 롤업 포커스는 주 surface만
    if (!focusSessionRequest) return;
    const api = apiRef.current;
    if (!api) return;
    const { uuid } = focusSessionRequest;
    const panel = api.panels.find((p) => {
      const prm = p.params as { sessionUuid?: string; loadSessionId?: string } | undefined;
      return prm?.sessionUuid === uuid || prm?.loadSessionId === uuid;
    });
    if (!panel) return;
    // 레이어 스왑 접합: the target tab lives in this (integrated) dock — if the
    // dev layer is in front, bring integrated forward first so the activated tab
    // is actually visible (같은 원칙: 뷰-행 요청의 대칭 전환, layerRouting 참조).
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
          <div className="claude-picker" onMouseLeave={() => setTermMenu(false)}>
            <button
              className="claude-picker-item"
              onClick={() => {
                setTermMenu(false);
                addPanel("terminal");
              }}
            >
              <span className="claude-picker-title">로컬 터미널</span>
            </button>
            <button
              className="claude-picker-item"
              onClick={() => {
                setTermMenu(false);
                setSshForm({ ...EMPTY_SSH_FORM });
              }}
            >
              <span className="claude-picker-title">+ 새 SSH 연결</span>
            </button>
            {savedConnections.length > 0 && (
              <>
                <div className="claude-picker-sep">저장된 연결</div>
                {savedConnections.map((c) => (
                  <div key={c.id} className="claude-picker-row" style={{ paddingLeft: 4 }}>
                    <button className="claude-picker-item" onClick={() => connectSaved(c.id)}>
                      <span className="claude-picker-title">{c.label}</span>
                      <span className="claude-picker-meta">
                        {c.username}@{c.host}:{c.port} · {c.auth_kind}
                      </span>
                    </button>
                    <span
                      className="claude-tab-x"
                      title="연결 삭제"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`'${c.label}' 연결을 삭제할까요? (키체인 비밀번호도 삭제)`)) return;
                        const ok = await deleteConnection(c.id);
                        if (!ok)
                          alert(
                            "키체인 비밀번호 삭제에 실패해 연결을 삭제하지 못했습니다. 다시 시도해 주세요.",
                          );
                      }}
                    >
                      ×
                    </span>
                  </div>
                ))}
              </>
            )}
            <div className="claude-picker-sep">설정</div>
            <button
              className="claude-picker-item"
              onClick={() => setPersistScrollback(!persistScrollback)}
            >
              <span className="claude-picker-title">
                출력 저장(재시작 복원): {persistScrollback ? "ON" : "OFF"}
              </span>
              <span className="claude-picker-meta">출력에 비밀번호가 섞일 수 있어 기본 OFF</span>
            </button>
          </div>
        )}
        {picker !== null && (
          <div className="claude-picker">
            <div className="claude-picker-new-row">
              <input
                className="claude-picker-input"
                value={newName}
                autoFocus
                placeholder="새 세션 이름"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createNewSession();
                  else if (e.key === "Escape") setPicker(null);
                }}
              />
              <button className="claude-picker-create" onClick={createNewSession}>
                + 만들기
              </button>
            </div>
            {archBusy && (
              <div className="claude-picker-busy" title="이 프로젝트의 세션 아카이브가 실행 중입니다 (책·요약·지식 추출 — 1~2분)">
                ⏳ 아카이브 진행 중…
              </div>
            )}
            {(() => {
              const rows = pickerRows();
              if (rows.length === 0) return null;
              const renderRow = (s: SessionSummary) => (
                <div
                  key={`${s.project}:${s.id}`}
                  className="claude-picker-row"
                  draggable
                  title="드래그해서 dock의 원하는 위치에 열기 (중앙=탭 · 가장자리=스플릿)"
                  onMouseDownCapture={(e) => {
                    dragPressRef.current = e.target;
                  }}
                  onDragStart={(e) => {
                    // 삭제 ×에서 시작한 드래그만 취소 (S6) — 행의 주 클릭 면이
                    // 버튼(claude-picker-item)이라 버튼 전체를 막으면 드래그
                    // 자체가 불가능해진다. dragstart의 e.target은 행 자신이므로
                    // mousedown 캡처로 기록한 실제 눌린 요소를 본다(S6 감사).
                    // project 미상 행은 드래그 불가 (S8).
                    const pressed = dragPressRef.current;
                    if (
                      (pressed instanceof HTMLElement &&
                        pressed.closest(".claude-tab-x, input")) ||
                      !s.project
                    ) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData(
                      SESSION_DRAG_MIME,
                      encodeSessionDrag({
                        uuid: s.id,
                        project: s.project,
                        title: s.name || s.title?.slice(0, 24) || s.date,
                        source: "picker",
                      }),
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                >
                  <button
                    className="claude-picker-item"
                    onClick={() => {
                      setPicker(null);
                      addPanel("claudeterm", {
                        loadSessionId: s.id,
                        project: s.project,
                        title: s.name || s.title?.slice(0, 24) || s.date,
                      });
                    }}
                  >
                    <span className="claude-picker-title">{s.name || "(이름 없음)"}</span>
                    <span className="claude-picker-meta">
                      {s.title ? `${s.title.slice(0, 40)} · ` : ""}
                      {s.date} · 변경 {s.count}
                      {s.archivedAt ? ` · 📦 ${fmtUnix(s.archivedAt)}` : ""}
                      {s.versions > 0 ? ` · 버전 ${s.versions + 1}` : ""}
                    </span>
                  </button>
                </div>
              );
              return (
                <>
                  <div className="claude-picker-sep">저장된 세션</div>
                  {PICKER_GROUPS.map((g) => {
                    const members = rows.filter((s) => s.archState === g.key);
                    if (members.length === 0) return null;
                    const collapsed = pickerCollapsed.has(g.key);
                    return (
                      <div key={g.key}>
                        <button
                          className={`claude-picker-group arch-${g.key}`}
                          title={g.hint}
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setPickerCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(g.key)) next.delete(g.key);
                              else next.add(g.key);
                              return next;
                            })
                          }
                        >
                          <span className="claude-picker-group-caret">{collapsed ? "▸" : "▾"}</span>
                          {g.label} ({members.length})
                        </button>
                        {!collapsed && members.map(renderRow)}
                      </div>
                    );
                  })}
                </>
              );
            })()}
            <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
              취소
            </button>
          </div>
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
          같은 closeRequest를 이중 소비하지 않게 (project-dual-surface). */}
      {closeRequest && apiRef.current?.getPanel(closeRequest.panelId) && (
        <div className="claude-modal-backdrop" onClick={() => clearClose()}>
          <div className="claude-modal" onClick={(e) => e.stopPropagation()}>
            <div className="claude-modal-title">이 Claude 세션을 어떻게 할까요?</div>
            <button className="claude-modal-opt" onClick={() => resolveClose(false)}>
              닫기 <span className="claude-modal-hint">세션 히스토리 보존 (나중에 다시 열기)</span>
            </button>
            <button
              className="claude-modal-opt claude-modal-del"
              onClick={() => resolveClose(true)}
            >
              삭제 <span className="claude-modal-hint">히스토리까지 영구 삭제</span>
            </button>
            <button className="claude-modal-opt claude-modal-cancel" onClick={() => clearClose()}>
              취소
            </button>
          </div>
        </div>
      )}

      {isPrimary && sshForm && (
        <div className="claude-modal-backdrop" onClick={() => setSshForm(null)}>
          <div className="claude-modal ssh-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="claude-modal-title">새 SSH 연결</div>
            <label className="ssh-field">
              <span>라벨 (탭 이름)</span>
              <input
                value={sshForm.label}
                placeholder={`${sshForm.username || "user"}@${sshForm.host || "host"}`}
                onChange={(e) => setSshForm({ ...sshForm, label: e.target.value })}
              />
            </label>
            <div className="ssh-row">
              <label className="ssh-field ssh-grow">
                <span>호스트</span>
                <input
                  value={sshForm.host}
                  autoFocus
                  placeholder="example.com"
                  onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })}
                />
              </label>
              <label className="ssh-field ssh-port">
                <span>포트</span>
                <input
                  value={sshForm.port}
                  inputMode="numeric"
                  onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })}
                />
              </label>
            </div>
            <label className="ssh-field">
              <span>사용자명</span>
              <input
                value={sshForm.username}
                placeholder="root"
                onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })}
              />
            </label>
            <label className="ssh-field">
              <span>인증 방식</span>
              <select
                value={sshForm.authKind}
                onChange={(e) =>
                  setSshForm({
                    ...sshForm,
                    authKind: e.target.value as SshForm["authKind"],
                  })
                }
              >
                <option value="password">비밀번호</option>
                <option value="publickey">PEM 키</option>
                <option value="agent">ssh-agent</option>
              </select>
            </label>
            {sshForm.authKind === "password" && (
              <label className="ssh-field">
                <span>비밀번호</span>
                <input
                  type="password"
                  value={sshForm.password}
                  onChange={(e) => setSshForm({ ...sshForm, password: e.target.value })}
                />
              </label>
            )}
            {sshForm.authKind === "publickey" && (
              <>
                <label className="ssh-field">
                  <span>키 파일 경로</span>
                  <input
                    value={sshForm.keyPath}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(e) => setSshForm({ ...sshForm, keyPath: e.target.value })}
                  />
                </label>
                <label className="ssh-field">
                  <span>passphrase (암호화된 키만)</span>
                  <input
                    type="password"
                    value={sshForm.passphrase}
                    onChange={(e) => setSshForm({ ...sshForm, passphrase: e.target.value })}
                  />
                </label>
              </>
            )}
            <label className="ssh-save-row">
              <input
                type="checkbox"
                checked={sshForm.save}
                onChange={(e) => setSshForm({ ...sshForm, save: e.target.checked })}
              />
              <span>이 연결 저장 (비밀번호/passphrase는 OS 키체인에)</span>
            </label>
            <div className="ssh-dialog-actions">
              <button className="claude-modal-opt" onClick={submitSshForm}>
                접속
              </button>
              <button
                className="claude-modal-opt claude-modal-cancel"
                onClick={() => setSshForm(null)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {isPrimary && hostKeyQueue[0] && (
        <div className="claude-modal-backdrop">
          <div className="claude-modal" onClick={(e) => e.stopPropagation()}>
            <div className="claude-modal-title">처음 접속하는 호스트입니다</div>
            <div className="ssh-hostkey-body">
              <div>
                {hostKeyQueue[0].host}:{hostKeyQueue[0].port}
              </div>
              <div className="ssh-fingerprint">{hostKeyQueue[0].fingerprint}</div>
              <div className="claude-modal-hint">
                이 호스트키를 신뢰하고 저장할까요? (불일치 시 MITM 위험)
              </div>
            </div>
            <button className="claude-modal-opt" onClick={() => answerHostKey(true)}>
              신뢰 <span className="claude-modal-hint">키를 저장하고 접속</span>
            </button>
            <button
              className="claude-modal-opt claude-modal-del"
              onClick={() => answerHostKey(false)}
            >
              거부 <span className="claude-modal-hint">접속 취소</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
