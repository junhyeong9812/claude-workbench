import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveLayerMode,
  integratedConsumesEditorOpen,
  devConsumesEditorOpen,
  devLayerMounted,
  type MainLayerMode,
} from "./layerRouting";
import { useAppStore } from "./store";

const P = "/repo/proj";

describe("resolveLayerMode", () => {
  it("defaults to integrated when the project is absent from the sparse map", () => {
    // T2: a project that never entered dev routes to the integrated layer.
    expect(resolveLayerMode({}, P)).toBe("integrated");
    expect(resolveLayerMode({ other: "dev" }, P)).toBe("integrated");
  });

  it("defaults to integrated when there is no active project", () => {
    expect(resolveLayerMode({ [P]: "dev" }, null)).toBe("integrated");
  });

  it("returns dev only for a project explicitly in dev mode", () => {
    expect(resolveLayerMode({ [P]: "dev" }, P)).toBe("dev");
  });
});

describe("editorOpen consume gates (XOR — 불변식 ③)", () => {
  // T3: for ANY mode, exactly one layer consumes — never both, never neither.
  const modes: MainLayerMode[] = ["integrated", "dev"];
  it("integrated consumes iff integrated mode", () => {
    expect(integratedConsumesEditorOpen("integrated")).toBe(true);
    expect(integratedConsumesEditorOpen("dev")).toBe(false);
  });
  it("dev consumes iff dev mode", () => {
    expect(devConsumesEditorOpen("dev")).toBe(true);
    expect(devConsumesEditorOpen("integrated")).toBe(false);
  });
  it("exactly one gate is true for every mode (XOR)", () => {
    for (const m of modes) {
      expect(integratedConsumesEditorOpen(m) !== devConsumesEditorOpen(m)).toBe(true);
    }
  });
});

describe("devLayerMounted latch (④ never-dev = no mount / ② toggle preserves state)", () => {
  it("T11: not mounted before the project ever enters dev", () => {
    expect(devLayerMounted("integrated", false)).toBe(false);
  });
  it("mounted while in dev mode", () => {
    expect(devLayerMounted("dev", false)).toBe(true);
  });
  it("T12: stays mounted after toggling back to integrated within the run", () => {
    // Entered dev once (visited=true); returning to integrated keeps it mounted
    // so the dev session's PTY/tabs survive the round trip.
    expect(devLayerMounted("integrated", true)).toBe(true);
  });
});

// Gate + real-store integration: exercises setProjectMode's sparse-map shape
// feeding resolveLayerMode, and the request-retention contract the effects rely
// on. (Effect *ordering* — side effect before clear, T1 — is verified by code
// review / manual GUI M-scenarios; no component mount here since the project has
// no @testing-library/react.)
describe("store-driven routing (T1/T4/T5)", () => {
  beforeEach(() => {
    useAppStore.setState({ projectModes: {}, activeProject: P, editorOpenRequest: null });
  });

  it("T1: integrated mode routes editorOpen to the integrated layer", () => {
    useAppStore.getState().requestEditorOpen("/repo/proj/a.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    expect(mode).toBe("integrated");
    expect(integratedConsumesEditorOpen(mode)).toBe(true);
    expect(devConsumesEditorOpen(mode)).toBe(false);
    expect(s.editorOpenRequest).toBe("/repo/proj/a.ts");
  });

  it("T4: in dev mode the integrated gate is closed, so it must not clear the request", () => {
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().requestEditorOpen("/repo/proj/b.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    // The integrated consumer returns early (gate false) BEFORE requestEditorOpen(null),
    // so the request survives for the dev layer to consume.
    expect(integratedConsumesEditorOpen(mode)).toBe(false);
    expect(devConsumesEditorOpen(mode)).toBe(true);
    expect(s.editorOpenRequest).toBe("/repo/proj/b.ts");
  });

  it("T5: setProjectMode(dev) then editorOpen routes to the dev layer", () => {
    // Same-tick ✓확인 order: flip to dev, then request the editor open.
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().requestEditorOpen("/repo/proj/c.ts");
    const s = useAppStore.getState();
    const mode = resolveLayerMode(s.projectModes, s.activeProject);
    expect(mode).toBe("dev");
    expect(devConsumesEditorOpen(mode)).toBe(true);
  });

  it("setProjectMode('integrated') deletes the key (sparse map) → resolves integrated", () => {
    useAppStore.getState().setProjectMode(P, "dev");
    useAppStore.getState().setProjectMode(P, "integrated");
    expect(useAppStore.getState().projectModes[P]).toBeUndefined();
    expect(resolveLayerMode(useAppStore.getState().projectModes, P)).toBe("integrated");
  });
});
