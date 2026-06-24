/** Shared markdown helpers for the file viewers (peek), study viewer, and the
 * change timeline. Single source of truth for "is this path markdown?" and for
 * the marked+DOMPurify render pipeline — both previously lived duplicated across
 * FilePeekViewer/StudyFileView/TimelineView. */

import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** A path whose content is markdown (.md/.markdown/.mdx) — shown in 뷰모드
 * (rendered HTML) rather than raw source. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

/** Media tags. Blocked for tool/session output (`blockMedia`) so a
 * `![x](https://attacker/…)` can't make the webview fetch a remote URL just by
 * opening the detail pane (codex). The study viewer keeps them so local `.md`
 * images render. */
const MEDIA_TAGS = ["img", "picture", "source", "video", "audio", "iframe", "object", "embed"];

/** Parse markdown `text` to sanitized HTML. `marked` is not a sanitizer, so the
 * output is always run through DOMPurify before injection. `blockMedia` forbids
 * media tags (tool/session output); when false (study viewer) local images render.
 * Exported as a pure function so the sanitize policy is unit-testable. */
export function sanitizeMarkdown(text: string, blockMedia: boolean): string {
  const parsed = marked.parse(text, { async: false }) as string;
  return blockMedia ? DOMPurify.sanitize(parsed, { FORBID_TAGS: MEDIA_TAGS }) : DOMPurify.sanitize(parsed);
}

/** Render markdown `text` to sanitized HTML. `className` is applied to the wrapper
 * so each call site keeps its own styling. */
export function Markdown({
  text,
  className,
  blockMedia = false,
}: {
  text: string;
  className?: string;
  blockMedia?: boolean;
}) {
  const html = useMemo(() => sanitizeMarkdown(text, blockMedia), [text, blockMedia]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
