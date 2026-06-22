import { invoke } from "@tauri-apps/api/core";

type PanelParams = { kind?: unknown; sessionId?: unknown } | undefined;

/** The backend close command for a panel kind: claude panels stop their PTY +
 * poll thread, everything else (terminal/ssh) closes the PTY. */
export function sessionCloseCmd(kind: unknown): "claude_close" | "terminal_close" {
  return kind === "claudeterm" ? "claude_close" : "terminal_close";
}

/** Close the backend session behind a panel's params (no-op without a numeric
 * session id). Awaited so callers (e.g. window close) can guarantee teardown
 * ran before the window is destroyed (review R1-7). */
export async function closePanelSession(params: PanelParams): Promise<void> {
  if (!params || typeof params.sessionId !== "number") return;
  await invoke(sessionCloseCmd(params.kind), { id: params.sessionId }).catch(() => {});
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
