/**
 * **격리 회귀 테스트** — codexterm이 claude 배선에 붙지 않는다는 계약.
 *
 * 이 작업의 불변식은 "codex 세션은 순수 터미널 탭"이다(spec ②). 그 격리는 좋은
 * 의도가 아니라 **구조**로 지켜진다: codexterm은 ClaudeTermPanel을 아예 안 지나고
 * (그래서 타임라인·스냅샷·시드·adopt 배선이 붙을 자리가 없고), 패널 params에는
 * claude 전용 필드가 실리지 않는다.
 *
 * 그 두 가지가 나중에 조용히 무너지는 것을 막는 게 이 파일이다. 무너지는 방식이
 * 조용한 이유: 잘못 배선해도 **화면은 멀쩡히 뜬다**. 타임라인이 영원히 빈 화면이
 * 되거나 스냅샷이 claude 목록을 오염시키는 식으로만 드러난다(survey R1 10지점).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IDockviewPanelProps } from "dockview-react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// 무거운 패널 둘을 **가짜로 바꿔 놓고** 래퍼를 실제로 렌더한다: TerminalPanel이
// 정확히 한 번 쓰이는지(= PTY 경로가 공용 그대로), ClaudeTermPanel이 한 번도
// 쓰이지 않는지(= claude 배선 미경유)를 렌더로 확인하기 위해서다.
const termMounts = vi.hoisted(() => ({ n: 0 }));
const claudeMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock("./TerminalPanel", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPanel: () => {
      useEffect(() => {
        termMounts.n += 1;
      }, []);
      return <div data-testid="term" />;
    },
  };
});
vi.mock("./ClaudeTermPanel", async () => {
  const { useEffect } = await import("react");
  return {
    ClaudeTermPanel: () => {
      useEffect(() => {
        claudeMounts.n += 1;
      }, []);
      return <div data-testid="claude" />;
    },
  };
});

import { components } from "./panelRegistry";
import { CodexTermPanel, shortTranscriptName } from "./CodexTermPanel";
import { TerminalPanel, type TerminalParams } from "./TerminalPanel";
import { ClaudeTermPanel } from "./ClaudeTermPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** CodexTermPanel이 실제로 읽는 최소 표면. */
function panelProps(params: TerminalParams): IDockviewPanelProps<TerminalParams> {
  return {
    params,
    api: { id: "p1", onDidParametersChange: () => ({ dispose: () => {} }) },
  } as unknown as IDockviewPanelProps<TerminalParams>;
}

describe("codexterm은 claude 배선을 지나지 않는다", () => {
  /** 작업③에서 codexterm이 TerminalPanel 직결에서 **얇은 래퍼**로 바뀌었다
   * (터미널 옆에 rollout 타임라인 컬럼이 붙었다). 바뀐 것은 그 한 겹뿐이고
   * 불변식은 그대로다 — 터미널 자체는 여전히 TerminalPanel이고, claude 패널은
   * 어느 경로로도 지나지 않는다. */
  it("레지스트리가 codexterm을 CodexTermPanel로 푼다 (ClaudeTermPanel 아님)", () => {
    expect(components.codexterm).toBe(CodexTermPanel);
    expect(components.codexterm).not.toBe(ClaudeTermPanel);
    // 대조군 — claudeterm은 그대로 claude 패널이어야 한다(회귀 0).
    expect(components.claudeterm).toBe(ClaudeTermPanel);
  });

  it("일반 터미널·SSH는 건드리지 않는다 (SSH 선례 보존)", () => {
    expect(components.terminal).toBe(TerminalPanel);
    expect(components.ssh).toBe(TerminalPanel);
  });

  it("래퍼는 claude 패널과 다른 컴포넌트다", () => {
    expect(CodexTermPanel).not.toBe(ClaudeTermPanel);
    expect(CodexTermPanel).not.toBe(TerminalPanel);
  });
});

describe("래퍼를 실제로 렌더해도 격리가 유지된다", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    termMounts.n = 0;
    claudeMounts.n = 0;
    invoke.mockReset();
    invoke.mockResolvedValue({
      status: "searching",
      note: "전사를 찾지 못했습니다",
      path: null,
      alive: true,
      fingerprint: null,
      unchanged: false,
      snapshot: null,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** PTY 수명·스폰·재부착이 codex 전용으로 갈라지지 않았다는 확인. 터미널이 두
   * 번 렌더되거나(중복 마운트=PTY 두 개) 아예 없으면(자체 구현으로 갈아탐) 여기서
   * 걸린다. */
  it("터미널은 공용 TerminalPanel 하나뿐이고 claude 패널은 지나지 않는다", async () => {
    await act(async () => {
      root.render(<CodexTermPanel {...panelProps({ kind: "codexterm", cwd: "/proj", sessionId: 7 })} />);
    });
    // 인스턴스 하나 — 둘이면 PTY가 둘, 없으면 자체 구현으로 갈아탄 것이다.
    expect(host.querySelectorAll('[data-testid="term"]').length).toBe(1);
    expect(host.querySelectorAll('[data-testid="claude"]').length).toBe(0);
    // 폴링이 돌아 상태가 갱신돼도 **다시 마운트되지는 않는다**(재마운트=PTY 재부착).
    expect(termMounts.n, "TerminalPanel은 한 번만 마운트돼야 한다").toBe(1);
    expect(claudeMounts.n, "ClaudeTermPanel은 마운트되면 안 된다").toBe(0);
  });

  /** 타임라인이 부르는 커맨드는 codex 전용 하나뿐 — `claude_*`가 하나라도 나가면
   * 그 세션은 claude 파이프라인 취급을 받기 시작한다(survey R1 10지점). */
  it("codex 전용 커맨드만 부른다", async () => {
    await act(async () => {
      root.render(<CodexTermPanel {...panelProps({ kind: "codexterm", cwd: "/proj", sessionId: 7 })} />);
    });
    const names = invoke.mock.calls.map((c) => c[0] as string);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n === "codex_timeline_snapshot")).toBe(true);
    expect(names.some((n) => n.startsWith("claude_"))).toBe(false);
  });
});

describe("전사 파일명 표시 (무음 깨기)", () => {
  it("rollout 접두·확장자를 떼고 시각+uuid만 남긴다", () => {
    expect(
      shortTranscriptName(
        "/home/u/.codex/sessions/2026/08/07/rollout-2026-08-07T21-08-10-019fdc1f-abbe-7293-b347-7dc82b11c8d0.jsonl",
      ),
    ).toBe("2026-08-07T21-08-10-019fdc1f-abbe-7293-b347-7dc82b11c8d0");
  });

  it("전사가 없으면 표시할 것도 없다", () => {
    expect(shortTranscriptName(null)).toBeNull();
  });
});

describe("codexterm params에 claude 전용 필드가 실리지 않는다", () => {
  /** MainArea.addPanel이 codexterm에 만들어 주는 params의 형태.
   * (addPanel은 per-mount 클로저라 직접 부를 수 없어 그 조건부 스프레드 결과를
   * 그대로 옮겼다 — 필드가 늘면 이 테스트가 같이 늘어야 한다.) */
  const codexParams = (opts: { model?: string; effort?: string } = {}) => ({
    kind: "codexterm",
    title: "Codex 1",
    project: "/home/jun/proj",
    cwd: "/home/jun/proj",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });

  /** claude 파이프라인이 params에서 읽어 가는 것들. 하나라도 실리면 그 세션은
   * claude 취급을 받기 시작한다(uuid 선채번·시드 주입·인수 재검증). */
  const CLAUDE_ONLY = ["loadSessionId", "seed", "adoptPending", "spawnCwd"] as const;

  it("uuid 선채번·시드·인수 필드가 없다", () => {
    const p = codexParams({ model: "gpt-5.6-sol", effort: "xhigh" });
    for (const key of CLAUDE_ONLY) {
      expect(p, `codexterm params에 ${key}가 있으면 안 된다`).not.toHaveProperty(key);
    }
  });

  it("레이아웃 왕복(재시작) 후에도 안 생긴다", () => {
    const restored = JSON.parse(JSON.stringify(codexParams({ effort: "low" })));
    for (const key of CLAUDE_ONLY) {
      expect(restored).not.toHaveProperty(key);
    }
    // 스폰 옵션은 반대로 **살아남아야** 한다 — 재시작 후 같은 설정으로 재스폰.
    expect(restored.effort).toBe("low");
  });

  it("미지정 옵션은 키째 없다 (= 플래그 미부착)", () => {
    const p = codexParams();
    expect(p).not.toHaveProperty("model");
    expect(p).not.toHaveProperty("effort");
  });
});
