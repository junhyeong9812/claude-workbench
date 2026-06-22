// Tracks dockview panel ids that are being *transferred* to another window
// (multiwindow). A transfer removes the panel from its source dockview, but the
// backing backend session must NOT be closed (it is re-attached in the target
// window). Without this guard, MainArea's `onDidRemovePanel` would treat the
// move as a real close and call `terminal_close`/`claude_close`, killing the
// session — the detach≠close invariant (review R0-1).
//
// The real transfer flow (begin → open/notify target → endTransfer once the
// target has claimed the session) lands in P2; P1 only lays the guard so the
// removal path is correct from the start.

const transferring = new Set<string>();

/** Mark a panel id as being moved (its removal must skip session close). */
export function beginTransfer(panelId: string): void {
  transferring.add(panelId);
}

/** Clear the moving mark (call after the panel has been removed). */
export function endTransfer(panelId: string): void {
  transferring.delete(panelId);
}

/** True while `panelId` is mid-transfer — `onDidRemovePanel` skips close. */
export function isTransferring(panelId: string): boolean {
  return transferring.has(panelId);
}
