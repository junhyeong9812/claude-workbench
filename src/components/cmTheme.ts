import { oneDark } from "@codemirror/theme-one-dark";
import type { Extension } from "@codemirror/state";

/** CodeMirror theme extension for the app color theme: oneDark in dark mode,
 * CM's default (light) palette in light mode. Used via a Compartment so the
 * editor/viewer can switch live. */
export const cmThemeExt = (theme: "dark" | "light"): Extension => (theme === "light" ? [] : oneDark);
