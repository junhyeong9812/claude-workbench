import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";

// Vite resolves the worker URL at build time (pdf.js v4 ships an .mjs worker).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** PDF viewer rendering each page to a canvas (pdf.js) — reliable inside
 * WebKitGTK where a plain <iframe> often can't display PDFs. */
export function PdfView({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = ref.current;
    if (!container) return;
    container.innerHTML = "";
    setErr(null);
    (async () => {
      try {
        const doc = await pdfjs.getDocument(convertFileSrc(path)).promise;
        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return;
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.className = "study-pdf-page";
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          container.appendChild(canvas);
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        }
      } catch (e) {
        if (!cancelled)
          setErr(typeof e === "string" ? e : ((e as { message?: string })?.message ?? "PDF 로드 실패"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (err) return <div className="study-view-note">PDF를 열 수 없습니다: {err}</div>;
  return <div className="study-pdf" ref={ref} />;
}
