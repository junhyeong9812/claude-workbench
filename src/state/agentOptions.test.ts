import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CHOICES,
  CODEX_EFFORT_CHOICES,
  CODEX_MODEL_CHOICES,
  DEFAULT_AGENT,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  UNSET_OPTIONS,
  effortChoices,
  loadAgentOptions,
  loadLastAgent,
  modelChoices,
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
  it("두 에이전트 다 고를 수 있다", () => {
    expect(AGENT_CHOICES.map((a) => [a.id, a.enabled])).toEqual([
      ["claude", true],
      ["codex", true],
    ]);
  });
  it("codex 어휘는 codex `/model` 피커 실측 그대로다", () => {
    // 모델: 피커가 내놓는 6개(그 아래 legacy는 -m 직접 지정 안내라 목록 아님).
    expect([...CODEX_MODEL_CHOICES]).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    // 강도: 피커 2단계(Low·Medium·High·Extra high·Max·Ultra), 강한 순.
    expect([...CODEX_EFFORT_CHOICES]).toEqual([
      "ultra",
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    // API가 받더라도 피커가 안 내놓는 값은 뺀다 — `minimal`은 현재 기본 모델이
    // 거부하고(400 unsupported_value), codex는 오값을 로컬 검증 없이 보낸다.
    expect(CODEX_EFFORT_CHOICES).not.toContain("minimal");
    expect(CODEX_EFFORT_CHOICES).not.toContain("none");
  });
  it("어휘 선택기가 에이전트별로 다른 목록을 준다", () => {
    expect(modelChoices("claude")).toBe(MODEL_CHOICES);
    expect(modelChoices("codex")).toBe(CODEX_MODEL_CHOICES);
    expect(effortChoices("claude")).toBe(EFFORT_CHOICES);
    expect(effortChoices("codex")).toBe(CODEX_EFFORT_CHOICES);
    // 두 모델 어휘는 겹치는 값이 하나도 없다 — 교차 오염이 나면 눈에 띈다.
    expect(modelChoices("claude").filter((m) => modelChoices("codex").includes(m))).toEqual([]);
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
  it("검증은 그 에이전트의 어휘로만 한다", () => {
    const codexish = '{"model":"gpt-5.6-sol","effort":"ultra"}';
    expect(parseAgentOptions(codexish, "codex")).toEqual({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    // 같은 JSON을 claude 어휘로 읽으면 둘 다 어휘 밖이라 미지정.
    expect(parseAgentOptions(codexish, "claude")).toEqual(UNSET_OPTIONS);
    // 반대 방향도 — claude 모델은 codex에서 미지정으로 떨어진다.
    expect(parseAgentOptions('{"model":"opus","effort":"low"}', "codex")).toEqual({
      model: "",
      effort: "low", // low는 양쪽 어휘에 다 있다(교차 오염이 아니라 진짜 유효값)
    });
  });
  it("agent를 안 주면 claude 어휘 (기존 호출 호환)", () => {
    expect(parseAgentOptions('{"model":"opus","effort":"max"}')).toEqual({
      model: "opus",
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

  it("마지막 agent를 그대로 되살린다", () => {
    saveLastAgent("claude");
    expect(loadLastAgent()).toBe("claude");
    saveLastAgent("codex");
    expect(loadLastAgent()).toBe("codex");
  });

  it("모르는/비활성 agent 값은 기본으로 되돌린다", () => {
    const map = installStorage();
    map.set("agentOptionsAgent", "gemini"); // 목록에 없는 값(손편집·구버전)
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
