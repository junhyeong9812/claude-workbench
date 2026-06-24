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
  // Unit tests (vitest). jsdom gives DOMPurify a window to sanitize against.
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
