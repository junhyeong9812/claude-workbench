/**
 * SurfaceContext(P0 무동작 인프라) 계약 실증.
 *
 * 보는 것 세 칸: (a) 프로바이더가 primary/secondary에 각자 올바른 project·
 * surfaceId를 주입하는가, (b) 훅이 그 값을 정확히 되돌려주는가, (c) 프로바이더
 * 밖에서 훅을 호출하면(개발 오용) 명확히 실패하는가.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SurfaceProvider,
  useSurface,
  useSurfaceProject,
  useSurfaceId,
  type SurfaceContextValue,
} from "./surfaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SurfaceContext", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** 컨텍스트 값을 잡아채는 프로브. */
  function Probe({ sink }: { sink: (v: SurfaceContextValue) => void }) {
    sink(useSurface());
    return null;
  }

  it("primary 프로바이더가 자기 project·surfaceId를 주입한다", () => {
    let captured: SurfaceContextValue | null = null;
    act(() => {
      root.render(
        <SurfaceProvider surfaceId="primary" project="/proj/a">
          <Probe sink={(v) => (captured = v)} />
        </SurfaceProvider>,
      );
    });
    expect(captured).toEqual({ surfaceId: "primary", project: "/proj/a" });
  });

  it("secondary 프로바이더가 자기 project·surfaceId를 주입한다", () => {
    let captured: SurfaceContextValue | null = null;
    act(() => {
      root.render(
        <SurfaceProvider surfaceId="secondary" project="/proj/b">
          <Probe sink={(v) => (captured = v)} />
        </SurfaceProvider>,
      );
    });
    expect(captured).toEqual({ surfaceId: "secondary", project: "/proj/b" });
  });

  it("project=null(hydration 전·닫힘)도 그대로 반사한다", () => {
    let captured: SurfaceContextValue | null = null;
    act(() => {
      root.render(
        <SurfaceProvider surfaceId="primary" project={null}>
          <Probe sink={(v) => (captured = v)} />
        </SurfaceProvider>,
      );
    });
    expect(captured).toEqual({ surfaceId: "primary", project: null });
  });

  it("useSurfaceProject / useSurfaceId 단축 훅이 각 필드를 되돌린다", () => {
    let proj: string | null = "unset";
    let id: string | null = null;
    function ShortProbe() {
      proj = useSurfaceProject();
      id = useSurfaceId();
      return null;
    }
    act(() => {
      root.render(
        <SurfaceProvider surfaceId="secondary" project="/proj/c">
          <ShortProbe />
        </SurfaceProvider>,
      );
    });
    expect(proj).toBe("/proj/c");
    expect(id).toBe("secondary");
  });

  it("프로바이더 밖 호출은 명확한 에러(개발 오용 방지)", () => {
    // React는 렌더 중 throw를 콘솔에 찍으므로 캡처 없이 렌더하면 시끄럽다 —
    // 에러 경계로 잡아 던져진 에러 자체를 검증한다.
    let thrown: unknown = null;
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError(err: unknown) {
        thrown = err;
        return { failed: true };
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    function OrphanProbe() {
      useSurface();
      return null;
    }
    // React는 에러 경계가 잡은 예외도 stderr에 다시 찍는다 — 이 테스트에서만
    // 억제해 CI 로그 오염을 막는다(예외 자체는 아래 단언이 검증).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      act(() => {
        root.render(
          <Boundary>
            <OrphanProbe />
          </Boundary>,
        );
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain("SurfaceProvider");
  });
});
