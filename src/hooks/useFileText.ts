import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";

/**
 * Read a file's text via the `acp_read_file` command into state, cancelling a
 * stale read on path change / unmount and resetting text+error each time so a
 * previous file's content/error can't linger. `path === null` clears and skips
 * the read (for conditional viewers like the timeline detail pane). Returns the
 * text (`null` while loading) and an error message (`null` when none).
 *
 * The CodeMirror-backed editors (StudyFileView main, EditorPanel) keep their own
 * read loop — they also build an editor + save handler around the same fetch, so
 * they're not a fit for this read-only hook.
 *
 * `refreshKey` forces a reset + re-read when it changes even if `path` is the
 * same — the timeline detail pane keys it on the item id so re-selecting the same
 * file (e.g. after a failed read, or a file that changed on disk) re-fetches.
 */
export function useFileText(path: string | null, fallback = "읽기 실패", refreshKey?: unknown) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setErr(null);
    if (path == null) return;
    invoke<string>("acp_read_file", { path })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(errText(e, fallback));
      });
    return () => {
      cancelled = true;
    };
  }, [path, fallback, refreshKey]);
  return { text, err };
}
