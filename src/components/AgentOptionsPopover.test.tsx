/**
 * 새 세션 옵션 팝오버의 **규칙** 실증.
 *
 * 어휘·기억의 순수 규칙은 `state/agentOptions.test.ts`가 본다. 여기서 보는 건 그
 * 위 한 칸 — 팝오버가 (a) 열릴 때 마지막 설정을 실제로 채워 넣는가, (b) [시작]이
 * 그 선택을 기억하고 호출자에게 넘기는가, (c) 아무것도 안 고르면 **플래그가 하나도
 * 안 붙는 형태**로 넘기는가(현행 스폰 바이트 동일의 UI 쪽 끝), (d) Codex를 표시는
 * 하되 고를 수 없게 두는가다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AgentOptionsPopover } from "./AgentOptionsPopover";
import { spawnOptionFields, type AgentId, type AgentOptions } from "../state/agentOptions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 세션 간에 새지 않는 localStorage 대역. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

describe("AgentOptionsPopover", () => {
  let host: HTMLDivElement;
  let root: Root;
  let started: { agent: AgentId; opts: AgentOptions } | null;
  let closed: number;

  beforeEach(() => {
    started = null;
    closed = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = async (props: { disabledReason?: string } = {}) => {
    await act(async () => {
      root.render(
        <AgentOptionsPopover
          {...props}
          onStart={(agent, opts) => {
            started = { agent, opts };
          }}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });
  };

  const sel = (label: string): HTMLSelectElement => {
    const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!el) throw new Error(`select "${label}" not found`);
    return el;
  };
  const btn = (text: string): HTMLButtonElement => {
    const el = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
    if (!el) throw new Error(`button "${text}" not found`);
    return el as HTMLButtonElement;
  };
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const choose = async (label: string, value: string) => {
    const el = sel(label);
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("마지막 설정을 채운 채로 열린다 (기억)", async () => {
    installStorage({ "agentOptions:claude": '{"model":"sonnet","effort":"max"}' });
    await render();
    expect(sel("모델").value).toBe("sonnet");
    expect(sel("추론 강도").value).toBe("max");
  });

  it("저장된 값이 어휘 밖이면 미지정으로 열린다 (검증 파서)", async () => {
    installStorage({ "agentOptions:claude": '{"model":"gpt-5","effort":"turbo"}' });
    await render();
    expect(sel("모델").value).toBe("");
    expect(sel("추론 강도").value).toBe("");
  });

  it("[시작]이 선택을 기억하고 호출자에게 넘긴다", async () => {
    const store = installStorage();
    await render();
    await choose("모델", "opus");
    await choose("추론 강도", "xhigh");
    await click(btn("시작"));

    expect(started).toEqual({ agent: "claude", opts: { model: "opus", effort: "xhigh" } });
    expect(store.get("agentOptions:claude")).toBe('{"model":"opus","effort":"xhigh"}');
    expect(store.get("agentOptionsAgent")).toBe("claude");
    // 다른 에이전트 키는 건드리지 않는다.
    expect(store.has("agentOptions:codex")).toBe(false);
  });

  it("아무것도 안 고르면 플래그가 하나도 안 붙는다 (현행 스폰 바이트 동일)", async () => {
    installStorage();
    await render();
    await click(btn("시작"));
    expect(started?.opts).toEqual({ model: "", effort: "" });
    expect(spawnOptionFields(started!.opts)).toEqual({});
  });

  it("한쪽만 골라도 고른 쪽만 실린다", async () => {
    installStorage();
    await render();
    await choose("추론 강도", "low");
    await click(btn("시작"));
    expect(spawnOptionFields(started!.opts)).toEqual({ effort: "low" });
  });

  it("Codex는 보이되 고를 수 없다 (작업② 전)", async () => {
    installStorage();
    await render();
    expect(btn("Codex").disabled).toBe(true);
    expect(btn("Claude").disabled).toBe(false);
    expect(btn("Claude").getAttribute("aria-pressed")).toBe("true");
  });

  it("시작할 수 없는 상태면 [시작]이 잠기고 이유를 보여준다", async () => {
    installStorage();
    await render({ disabledReason: "프로젝트를 연 뒤 세션을 시작할 수 있습니다" });
    expect(btn("시작").disabled).toBe(true);
    expect(host.textContent).toContain("프로젝트를 연 뒤");
    await click(btn("시작"));
    expect(started).toBeNull();
  });

  it("Escape로 닫는다", async () => {
    installStorage();
    await render();
    const pop = host.querySelector<HTMLElement>(".agent-opt-pop");
    await act(async () => {
      pop?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closed).toBe(1);
  });
});
