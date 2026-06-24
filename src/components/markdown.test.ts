import { describe, it, expect } from "vitest";
import { isMarkdownPath, sanitizeMarkdown } from "./markdown";

describe("isMarkdownPath", () => {
  it("matches markdown extensions (case-insensitive)", () => {
    for (const p of ["a.md", "a.markdown", "a.mdx", "README.MD", "deep/path/Notes.Markdown"]) {
      expect(isMarkdownPath(p)).toBe(true);
    }
  });

  it("rejects non-markdown paths", () => {
    for (const p of ["a.tsx", "a.json", "a.txt", "README", "mdx", "a.md.txt", "notes.mdown"]) {
      expect(isMarkdownPath(p)).toBe(false);
    }
  });
});

describe("sanitizeMarkdown", () => {
  it("renders basic markdown to HTML", () => {
    const html = sanitizeMarkdown("# Title\n\nhello **world**", false);
    expect(html).toContain("<h1");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>world</strong>");
  });

  it("always strips scripts regardless of blockMedia", () => {
    const evil = "ok\n\n<script>alert(1)</script>";
    expect(sanitizeMarkdown(evil, true)).not.toContain("<script");
    expect(sanitizeMarkdown(evil, false)).not.toContain("<script");
  });

  it("blockMedia=true forbids media tags (tool/session output)", () => {
    const html = sanitizeMarkdown("![x](https://e/x.png)", true);
    expect(html).not.toContain("<img");
  });

  it("blockMedia=false keeps images (study viewer renders local .md images)", () => {
    const html = sanitizeMarkdown("![x](https://e/x.png)", false);
    expect(html).toContain("<img");
  });

  it("blockMedia=true blocks iframes; blockMedia=false is governed by DOMPurify defaults", () => {
    const withIframe = '<iframe src="https://e"></iframe>';
    expect(sanitizeMarkdown(withIframe, true)).not.toContain("<iframe");
  });
});
