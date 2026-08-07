import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CHOICES,
  DEFAULT_AGENT,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  UNSET_OPTIONS,
  loadAgentOptions,
  loadLastAgent,
  parseAgentOptions,
  saveAgentOptions,
  saveLastAgent,
  spawnOptionFields,
} from "./agentOptions";

/** localStorage 대역 — jsdom 없이 순수 모듈만 돌린다. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

describe("agentOptions 어휘", () => {
  it("강도 어휘가 CLI 실측 5종(max 포함)", () => {
    expect([...EFFORT_CHOICES]).toEqual(["max", "xhigh", "high", "medium", "low"]);
  });
  it("Codex는 표시하되 아직 고를 수 없다", () => {
    const codex = AGENT_CHOICES.find((a) => a.id === "codex");
    expect(codex).toBeDefined();
    expect(codex?.enabled).toBe(false);
    expect(AGENT_CHOICES.find((a) => a.id === "claude")?.enabled).toBe(true);
  });
});

describe("parseAgentOptions — 검증 파서", () => {
  it("없음/깨진 JSON/객체 아님은 전부 미지정", () => {
    expect(parseAgentOptions(null)).toEqual(UNSET_OPTIONS);
    expect(parseAgentOptions("")).toEqual(UNSET_OPTIONS);
    expect(parseAgentOptions("{oops")).toEqual(UNSET_OPTIONS);
    expect(parseAgentOptions("42")).toEqual(UNSET_OPTIONS);
    expect(parseAgentOptions("null")).toEqual(UNSET_OPTIONS);
  });
  it("어휘 밖 값은 조용히 미지정으로 떨어진다", () => {
    expect(parseAgentOptions('{"model":"gpt-5","effort":"turbo"}')).toEqual(UNSET_OPTIONS);
    // 한쪽만 유효해도 다른 쪽은 그대로 산다
    expect(parseAgentOptions('{"model":"opus","effort":"turbo"}')).toEqual({
      model: "opus",
      effort: "",
    });
  });
  it("유효 값은 그대로 통과", () => {
    expect(parseAgentOptions('{"model":"sonnet","effort":"max"}')).toEqual({
      model: "sonnet",
      effort: "max",
    });
  });
});

describe("기억 — agent별 키 분리", () => {
  beforeEach(() => {
    installStorage();
  });

  it("claude에 저장한 값이 codex 조회에 새지 않는다", () => {
    saveAgentOptions("claude", { model: "opus", effort: "xhigh" });
    expect(loadAgentOptions("claude")).toEqual({ model: "opus", effort: "xhigh" });
    expect(loadAgentOptions("codex")).toEqual(UNSET_OPTIONS);
  });

  it("저장 키가 agent별로 다르다", () => {
    const map = installStorage();
    saveAgentOptions("claude", { model: "opus", effort: "" });
    saveAgentOptions("codex", { model: "haiku", effort: "low" });
    expect([...map.keys()].sort()).toEqual(["agentOptions:claude", "agentOptions:codex"]);
  });

  it("마지막 agent는 비활성 값이면 기본으로 되돌린다", () => {
    saveLastAgent("claude");
    expect(loadLastAgent()).toBe("claude");
    saveLastAgent("codex"); // 아직 비활성
    expect(loadLastAgent()).toBe(DEFAULT_AGENT);
  });

  it("저장소가 막혀 있어도 미지정으로 계속 동작한다", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadAgentOptions("claude")).toEqual(UNSET_OPTIONS);
    expect(loadLastAgent()).toBe(DEFAULT_AGENT);
    expect(() => saveAgentOptions("claude", { model: "opus", effort: "max" })).not.toThrow();
    expect(() => saveLastAgent("claude")).not.toThrow();
  });
});

describe("spawnOptionFields — 미지정은 키째 사라진다", () => {
  it("둘 다 미지정이면 빈 객체 (= 플래그 미부착 · 현행 바이트 동일)", () => {
    expect(spawnOptionFields(UNSET_OPTIONS)).toEqual({});
    expect(Object.keys(spawnOptionFields({ model: "", effort: "" }))).toHaveLength(0);
  });
  it("고른 것만 실린다", () => {
    expect(spawnOptionFields({ model: "opus", effort: "" })).toEqual({ model: "opus" });
    expect(spawnOptionFields({ model: "", effort: "max" })).toEqual({ effort: "max" });
    expect(spawnOptionFields({ model: MODEL_CHOICES[0], effort: EFFORT_CHOICES[0] })).toEqual({
      model: "opus",
      effort: "max",
    });
  });
});
