/** Shared markdown helpers for the file viewers (peek), study viewer, and the
 * change timeline. Single source of truth for "is this path markdown?" — the
 * regex previously lived duplicated in FilePeekViewer/StudyFileView/TimelineView. */

/** A path whose content is markdown (.md/.markdown/.mdx) — shown in 뷰모드
 * (rendered HTML) rather than raw source. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);
