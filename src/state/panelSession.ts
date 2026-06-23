import { invoke } from "@tauri-apps/api/core";

type PanelParams = { kind?: unknown; sessionId?: unknown } | undefined;

/** Release this window's hold on the session behind a panel's params (no-op
 * without a numeric session id). Awaited so callers (e.g. window close) can
 * guarantee teardown ran before the window is destroyed (review R1-7).
 *
 * Claude sessions are reference-counted across windows (mirror, P6): `detach`
 * removes this window and closes the PTY only when no viewers remain
 * (`closeIfLast`, false during a transfer since the target re-attaches). Plain
 * terminals/SSH are single-owner — closing the panel closes the PTY. */
export async function closePanelSession(
  params: PanelParams,
  opts?: { closeIfLast?: boolean },
): Promise<void> {
  if (!params || typeof params.sessionId !== "number") return;
  if (params.kind === "claudeterm") {
    await invoke("claude_detach", {
      id: params.sessionId,
      closeIfLast: opts?.closeIfLast ?? true,
    }).catch(() => {});
  } else {
    await invoke("terminal_close", { id: params.sessionId }).catch(() => {});
  }
}

/** Pull `{sessionId, kind}` out of a dockview-serialized layout's panels. Used
 * to find sessions that are detached (a project-swap remounted them away) but
 * still alive, so closing a popout window leaks nothing (review R1-5). */
export function sessionsInLayout(layout: unknown): { sessionId: number; kind: unknown }[] {
  const panels = (layout as { panels?: Record<string, { params?: PanelParams }> } | null)?.panels;
  if (!panels) return [];
  const out: { sessionId: number; kind: unknown }[] = [];
  for (const p of Object.values(panels)) {
    const sid = p?.params?.sessionId;
    if (typeof sid === "number") out.push({ sessionId: sid, kind: p?.params?.kind });
  }
  return out;
}
