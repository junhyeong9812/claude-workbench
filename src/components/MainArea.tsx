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
import { installDragOut, movePanelToNewWindow } from "../state/windowTransfer";
import { installTransferTarget } from "../state/panelTransferTarget";
import { components, AppTab, type PanelKind } from "./panelRegistry";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { fileName } from "./cmLang";

/** A saved session normalized for the reopen picker (ACP `claude` or A
 * `claudeterm`). `id` is the session UUID. */
interface SessionSummary {
  id: string;
  date: string;
  name: string;
  title: string;
  count: number;
  /** Handoff chain link (claudeterm only) — groups sessions into task chains. */
  prev_uuid?: string | null;
  /** The project (cwd) this session belongs to — passed through on reopen. */
  project: string;
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
export function MainArea() {
  const activeProject = useAppStore((s) => s.activeProject);
  const theme = useAppStore((s) => s.theme);
  const projects = useAppStore((s) => s.projects);
  const editorOpenRequest = useAppStore((s) => s.editorOpenRequest);
  const requestEditorOpen = useAppStore((s) => s.requestEditorOpen);
  const diffRequest = useAppStore((s) => s.diffRequest);
  const requestDiff = useAppStore((s) => s.requestDiff);
  const focusMainRequest = useAppStore((s) => s.focusMainRequest);
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
  // Which kind the open picker creates/reopens: ACP `claude` or A `claudeterm`.
  const [newName, setNewName] = useState("Claude 1");
  // Expanded task chains in the picker (by head uuid) — collapsed shows only the
  // latest task of each chain; expand reveals its previous tasks.
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());
  const toggleChain = (uuid: string) =>
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
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

  // The layout for the project this mount belongs to (read once at onReady).
  const savedLayout = projects.find((p) => p.path === activeProject)?.layout;

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;

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
      if (activeProject) {
        setLayout(activeProject, api.toJSON());
      }
    });

    // Real panel removal (close) -> close the backing session (spec §0.1). Tab/
    // project switches don't fire this, so those only detach (session lives).
    api.onDidRemovePanel((panel) => {
      // Drop this panel's remembered focus area (closed for good — not a switch).
      forgetArea(panel.id);
      // A *transfer* to another window removes the panel here but the backend
      // session must survive (it re-attaches in the target window) — skip close
      // (detach≠close, review R0-1). The actual move is wired in P2.
      if (isTransferring(panel.id)) return;
      const params = panel.params as { kind?: string; sessionId?: number } | undefined;
      if (typeof params?.sessionId === "number") {
        // claudeterm sessions also need their poll thread stopped (claude_close);
        // plain terminals just close the PTY.
        const cmd = params.kind === "claudeterm" ? "claude_close" : "terminal_close";
        invoke(cmd, { id: params.sessionId }).catch(() => {});
      }
      // Persisted scrollback is discarded by the session's own flusher when the
      // session is removed (it is the file's sole owner — no delete/flush race,
      // review P4-R1), so there's nothing to clean up here.
    });

    // Drop-out / dock gesture: a tab released over another window docks into it,
    // over the desktop opens a new window, inside this window rearranges as usual
    // (review P3/P4). Shared wiring with popouts. Dispose any prior gesture from
    // an earlier (project-keyed) mount before re-installing (review P4-impl #5).
    dragSubRef.current?.dispose();
    dragSubRef.current = installDragOut(api);
  };

  // Tear down the drag gesture wiring on unmount.
  useEffect(() => {
    return () => dragSubRef.current?.dispose();
  }, []);

  // Receive panels docked INTO this (main) window from popouts — re-dock back
  // to main (review P4). apiRef is read per-event so a project-keyed remount
  // never leaves a stale dock.
  useEffect(() => {
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
    const win = getCurrentWindow();
    if (win.label !== "main") return;
    const unP = win.onCloseRequested(async (event) => {
      event.preventDefault();
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
      await win.destroy();
    });
    return () => {
      void unP.then((f) => f());
    };
  }, []);

  const addPanel = (
    kind: PanelKind,
    opts?: { loadSessionId?: string; title?: string; project?: string; path?: string },
  ) => {
    const api = apiRef.current;
    if (!api) return;
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
    api.addPanel({
      id: `${kind}-${Date.now()}`,
      component,
      title,
      params: {
        kind,
        title,
        ...(opts?.loadSessionId ? { loadSessionId: opts.loadSessionId } : {}),
        ...(opts?.project ? { project: opts.project } : {}),
        ...(opts?.path ? { path: opts.path } : {}),
      },
    });
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
    invoke("ssh_hostkey_decision", { id: p.id, accept }).catch(() => {});
  };

  // Open a file in the editor when requested (from the peek viewer or tree). Focus
  // an already-open editor for the same file instead of opening a duplicate.
  useEffect(() => {
    if (!editorOpenRequest) return;
    const api = apiRef.current;
    if (!api) return; // dock not ready (mount/project switch) — keep the request
    const path = editorOpenRequest;
    requestEditorOpen(null); // consume only once we can actually act (codex P2 E4)
    const existing = api.panels.find((p) => {
      const prm = p.params as { kind?: string; path?: string } | undefined;
      return prm?.kind === "editor" && prm.path === path;
    });
    if (existing) {
      existing.api.setActive();
      return;
    }
    addPanel("editor", { path, title: fileName(path) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest, activeProject]);

  // Open a diff panel (changed file or commit) when requested from the Git panel.
  useEffect(() => {
    if (!diffRequest) return;
    const api = apiRef.current;
    if (!api) return;
    const spec = diffRequest;
    requestDiff(null);
    const key = spec.hash ? `diff:${spec.hash}` : `diff:${spec.path}:${spec.staged ? 1 : 0}`;
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
  }, [diffRequest, activeProject]);

  // Resolve a close request from a Claude tab's × (B3-1): 닫기 keeps the saved
  // history, 삭제 also removes it; both close the panel.
  const resolveClose = async (deleteHistory: boolean) => {
    const req = closeRequest;
    clearClose();
    if (!req) return;
    // Delete must target the session's *own* project (a workspace-wide reopen can
    // open a task from a project other than the active tab) — codex P2 F1.
    const project = req.project ?? activeProject;
    if (req.kind === "claudeterm") {
      // Stop the live poll thread BEFORE deleting, so it can't recreate the
      // snapshot we're about to remove (codex session-UX F4).
      if (typeof req.ptyId === "number") {
        await invoke("claude_close", { id: req.ptyId }).catch(() => {});
      }
      if (deleteHistory && req.sessionId && project) {
        await invoke("claude_delete", {
          project,
          uuid: req.sessionId,
        }).catch(() => {});
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

  // "+ Claude(A)": open the picker — name a new task session or reopen a saved
  // (not-already-open) one, grouped into task chains. Per-project (active project).
  const openPicker = async () => {
    setExpandedChains(new Set());
    let sessions: SessionSummary[] = [];
    if (activeProject) {
      const raw = await invoke<
        {
          uuid: string;
          name: string;
          title: string;
          date: string;
          count: number;
          prev_uuid?: string | null;
        }[]
      >("claude_sessions", { project: activeProject }).catch(() => []);
      sessions = raw.map((s) => ({
        id: s.uuid,
        name: s.name,
        title: s.title,
        date: s.date,
        count: s.count,
        prev_uuid: s.prev_uuid ?? null,
        project: activeProject,
      }));
    }
    setNewName(`Claude ${sessions.length + openKindCount("claudeterm") + 1}`);
    setPicker(sessions); // open-session filtering + chain grouping happen at render
  };

  // Picker rows: group saved task sessions into chains (head + collapsed previous
  // tasks). Already-open sessions never appear as rows (their predecessors still
  // surface via the fallback below). Chain indexing keys on uuid alone — handoff
  // uuids are random v4 (globally unique); the React row key is still compounded
  // with project to be safe (codex P2 F2).
  const pickerRows = (): { s: SessionSummary; depth: number; hasPrev: boolean }[] => {
    if (picker == null) return [];
    const open = openSessionIds();
    const byUuid = new Map(picker.map((s) => [s.id, s]));
    const referenced = new Set(picker.map((s) => s.prev_uuid).filter(Boolean) as string[]);
    const rows: { s: SessionSummary; depth: number; hasPrev: boolean }[] = [];
    const visited = new Set<string>();

    // Emit a chain rooted at `head`: the head row + (when expanded) its previous
    // tasks, both skipping already-open sessions.
    const emit = (head: SessionSummary) => {
      visited.add(head.id);
      const prev: SessionSummary[] = [];
      const seen = new Set([head.id]);
      let cur = head.prev_uuid ? byUuid.get(head.prev_uuid) : undefined;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        visited.add(cur.id);
        prev.push(cur);
        cur = cur.prev_uuid ? byUuid.get(cur.prev_uuid) : undefined;
      }
      const shownPrev = prev.filter((p) => !open.has(p.id));
      rows.push({ s: head, depth: 0, hasPrev: shownPrev.length > 0 });
      if (expandedChains.has(head.id)) {
        for (const p of shownPrev) rows.push({ s: p, depth: 1, hasPrev: false });
      }
    };

    // Heads = sessions no one continues from (the latest task of each chain).
    const heads = picker
      .filter((s) => !referenced.has(s.id) && !open.has(s.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const head of heads) emit(head);
    // Fallback: any session not reached from a head (pure cycle / orphan, or a
    // predecessor whose head is currently open) — emit so nothing is silently
    // dropped (codex P2 F3).
    for (const s of picker) {
      if (!visited.has(s.id) && !open.has(s.id)) emit(s);
    }
    return rows;
  };

  const createNewSession = () => {
    const name = newName.trim() || "Claude";
    setPicker(null);
    // Give the new session a stable UUID up front so it's saved in the layout
    // immediately → resumes the same session after restart (create-or-resume in
    // claude_start handles the not-yet-chatted case). #6
    addPanel("claudeterm", { title: name, loadSessionId: crypto.randomUUID() });
  };

  // Alt+←/→/↑/↓ cycles the active session tab (dockview panel). Left/Up = prev,
  // Right/Down = next (wraps). Distinct from a Claude panel's Ctrl+←/→ pane focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const isNext = e.key === "ArrowRight" || e.key === "ArrowDown";
      const isPrev = e.key === "ArrowLeft" || e.key === "ArrowUp";
      if (!isNext && !isPrev) return;
      const api = apiRef.current;
      if (!api) return;
      const panels = api.panels;
      if (panels.length < 2) return;
      const idx = api.activePanel ? panels.indexOf(api.activePanel) : -1;
      const next = isNext
        ? (idx + 1) % panels.length
        : (idx - 1 + panels.length) % panels.length;
      e.preventDefault();
      panels[next].api.setActive();
      // The newly-active panel remounts (onlyWhenVisible) and focuses its own
      // content on mount — no focus call needed here (doing it now would race the
      // not-yet-created xterm, the original Claude-tab focus bug).
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+B from the already-focused tree asks to focus the open tab (App bumps
  // focusMainRequest). dockview's focus() only focuses the active GROUP, so also
  // drop focus into the active panel's content (xterm/CodeMirror/…) so keyboard
  // input lands there. Skip the initial 0 so a fresh mount doesn't steal focus.
  useEffect(() => {
    if (focusMainRequest === 0) return;
    const api = apiRef.current;
    if (!api) return;
    api.focus();
    // Restore the active Claude panel's last sub-area (terminal/viewer/timeline);
    // for other panels `area` is undefined → first focusable content.
    focusActivePanelContent(recallArea(api.activePanel?.id ?? ""));
  }, [focusMainRequest]);

  return (
    <div className="main-area">
      <div className="main-toolbar">
        <button className="toolbar-btn" onClick={() => setTermMenu((v) => !v)}>
          + Terminal ▾
        </button>
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
        <button className="toolbar-btn" onClick={() => openPicker()}>
          + Claude
        </button>
        <button
          className="toolbar-btn"
          title="활성 패널을 새 창으로 분리 (또는 탭을 창 밖으로 드래그)"
          onClick={() => {
            const api = apiRef.current;
            if (api?.activePanel) void movePanelToNewWindow(api, api.activePanel.id);
          }}
        >
          ⤢ 분리
        </button>
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
            {(() => {
              const rows = pickerRows();
              if (rows.length === 0) return null;
              return (
                <>
                  <div className="claude-picker-sep">저장된 task</div>
                  {rows.map(({ s, depth, hasPrev }) => (
                    <div
                      key={`${s.project}:${s.id}`}
                      className="claude-picker-row"
                      style={{ paddingLeft: 4 + depth * 16 }}
                    >
                      <span
                        className="claude-picker-caret"
                        onClick={(e) => {
                          if (!hasPrev) return;
                          e.stopPropagation();
                          toggleChain(s.id);
                        }}
                        style={{ visibility: hasPrev ? "visible" : "hidden" }}
                        title={expandedChains.has(s.id) ? "이전 task 접기" : "이전 task 펼치기"}
                      >
                        {expandedChains.has(s.id) ? "▾" : "▸"}
                      </span>
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
                        <span className="claude-picker-title">
                          {depth > 0 ? "↳ " : ""}
                          {s.name || "(이름 없음)"}
                        </span>
                        <span className="claude-picker-meta">
                          {s.title ? `${s.title.slice(0, 40)} · ` : ""}
                          {s.date} · 변경 {s.count}
                        </span>
                      </button>
                    </div>
                  ))}
                </>
              );
            })()}
            <button className="claude-picker-item claude-picker-cancel" onClick={() => setPicker(null)}>
              취소
            </button>
          </div>
        )}
      </div>
      <DockviewReact
        key={activeProject ?? "none"}
        className={`dockview-theme-${theme === "light" ? "light" : "dark"} main-dock`}
        components={components}
        defaultTabComponent={AppTab}
        onReady={onReady}
      />

      {closeRequest && (
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

      {sshForm && (
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

      {hostKeyQueue[0] && (
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
