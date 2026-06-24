/**
 * Normalize an unknown thrown value to a display string. Tauri `invoke` rejects
 * with a string, JS throws `Error`, so we accept either: a string passes through;
 * an object's `.message` is used; otherwise `fallback` (or `String(e)` when no
 * fallback is given). Replaces the per-component `errText` helpers and the inline
 * `typeof e === "string" ? e : ((e as {message?}).message ?? …)` casts.
 */
export function errText(e: unknown, fallback?: string): string {
  if (typeof e === "string") return e;
  const msg = (e as { message?: string } | null)?.message;
  return msg ?? fallback ?? String(e);
}
