/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and should not clear the screen on rebuild.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Split large eager vendors out of the main entry chunk (caching +
        // smaller main chunk). pdfjs is left out — it's lazy via PdfView, so it
        // already gets its own on-demand chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@codemirror") || id.includes("/codemirror/")) return "codemirror";
          if (id.includes("dockview")) return "dockview";
          if (id.includes("@xterm")) return "xterm";
        },
      },
    },
  },
  // Unit tests (vitest). jsdom gives DOMPurify a window to sanitize against.
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
