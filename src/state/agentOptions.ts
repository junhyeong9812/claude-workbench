/**
 * 에이전트 세션 옵션(에이전트 · 모델 · 추론 강도)의 **어휘와 기억** — 순수 모듈.
 *
 * 왜 세션을 만들기 *전에* 골라야 하나: 세션은 스폰될 때 모델·강도가 정해진다.
 * 뜬 뒤에 바꾸려면 PTY를 파기하고 다시 띄워야 하고 그건 대화 파기다
 * (promptRefine의 같은 판단 · `runtime.rs`의 mirror 브랜치는 model을 무시한다).
 * 그래서 선택 UI는 "새 세션" 버튼 옆에 있고, 고른 값은 기억된다.
 *
 * **미지정("")은 1급 값이다** — 플래그를 아예 붙이지 않는다는 뜻이고, 그때의
 * argv는 이 기능이 없던 때와 바이트 단위로 같다(`spawn.rs::build_claude_args`).
 */

/** 세션을 돌리는 CLI. */
export type AgentId = "claude" | "codex";

export interface AgentChoice {
  id: AgentId;
  label: string;
  /** false면 팝오버에서 표시하되 고를 수 없다. */
  enabled: boolean;
  hint: string;
}

export const AGENT_CHOICES: readonly AgentChoice[] = [
  { id: "claude", label: "Claude", enabled: true, hint: "claude CLI 세션" },
  {
    id: "codex",
    label: "Codex",
    enabled: true,
    hint: "codex CLI 세션 (순수 터미널 탭 — 타임라인·아카이브 없음)",
  },
];

export const DEFAULT_AGENT: AgentId = "claude";

/**
 * 모델 별칭 — claude CLI에 목록 명령이 없어 큐레이션한다. 자유 입력을 노출하지
 * 않는 것은 의도적이다: 오타 모델명은 경고가 아니라 **세션 즉사**로 나타나고
 * (`"…" is not a model this version of Claude Code recognizes`), 사용자에겐 빈
 * 터미널로만 보인다. 자유 입력이 필요한 곳(아카이브 추출)은 자기 화면에서
 * 따로 제공한다.
 */
export const MODEL_CHOICES = ["opus", "sonnet", "haiku"] as const;

/**
 * 추론 강도 — `claude --effort <level>` 실측 어휘(강한 순). 모델과 달리 **잘못된
 * 값도 세션을 죽이지 않는다**(CLI가 경고 후 기본값으로 폴백) — 그래서 하드코딩이
 * 안전하다.
 *
 * 값 어휘는 지금 claude 것뿐이다. codex는 강도 어휘가 다르므로(`-c
 * model_reasoning_effort=`) 작업②가 자기 목록을 이 모듈에 추가한다 — 기억 키가
 * 이미 agent별로 갈려 있어(아래 `optionsKey`) 교차 오염은 그때도 일어나지 않는다.
 */
export const EFFORT_CHOICES = ["max", "xhigh", "high", "medium", "low"] as const;

/**
 * codex 모델 — codex 자신의 `/model` 피커가 내놓는 목록 그대로다(실측
 * 2026-08-07, codex-cli 0.144.1). 피커는 이 6개를 보여주고 그 아래에
 * "Access legacy models by running codex -m <model_name>"이라고 적는다 — 즉
 * 이것이 CLI가 스스로 정한 큐레이션이고, 우리가 따로 고를 이유가 없다.
 *
 * 순서는 피커 순서(강한 것 먼저). `~/.codex/config.toml`의 기본은 여기서
 * 건드리지 않는다 — 미지정으로 두면 그 설정이 그대로 산다.
 */
export const CODEX_MODEL_CHOICES = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

/**
 * codex 추론 강도 — `-c model_reasoning_effort=<v>`로 나간다(전용 플래그 없음).
 * 목록은 codex `/model` 피커의 2단계("Select Reasoning Level") 그대로다:
 * Low·Medium·High·Extra high(=xhigh)·Max·Ultra.
 *
 * **claude와 달리 오값이 안전하지 않다** — 그래서 목록이 claude 것과 우연히
 * 겹치더라도 상수를 나눠 둔다. claude CLI는 모르는 `--effort`를 경고 후
 * 기본값으로 폴백하지만, codex는 값을 로컬에서 검증하지 않고 그대로 API에
 * 보내고 **첫 요청이 400으로 죽는다**(실측):
 *
 * ```
 * -c model_reasoning_effort=bogusvalue
 *   → 400 invalid_enum_value: Supported values are: 'none','minimal','low',
 *     'medium','high','xhigh','max'
 * -c model_reasoning_effort=minimal
 *   → 400 unsupported_value: 'minimal' is not supported with the 'gpt-5.6-sol…'
 *     model. Supported values are: 'none','low','medium','high','xhigh','max'
 * ```
 *
 * 두 번째가 이 목록을 피커에 맞춘 이유다: **지원 값이 모델마다 다르다.**
 * 팝오버는 모델별 목록을 들고 있지 않으므로, 어느 모델에서나 codex 자신이
 * 제시하는 집합(=피커)만 노출하는 것이 유일하게 안전한 큐레이션이다.
 * 그래서 `minimal`·`none`은 API가 받더라도 뺐다(피커가 안 내놓고, `minimal`은
 * 현재 기본 모델이 거부한다 — 골랐다면 첫 질문에서 세션이 죽는다).
 */
export const CODEX_EFFORT_CHOICES = ["ultra", "max", "xhigh", "high", "medium", "low"] as const;

/** 이 에이전트의 모델 어휘. */
export function modelChoices(agent: AgentId): readonly string[] {
  return agent === "codex" ? CODEX_MODEL_CHOICES : MODEL_CHOICES;
}

/** 이 에이전트의 강도 어휘. */
export function effortChoices(agent: AgentId): readonly string[] {
  return agent === "codex" ? CODEX_EFFORT_CHOICES : EFFORT_CHOICES;
}

/** 한 에이전트에 대해 기억되는 선택. `""` = 미지정(= 플래그 미부착). */
export interface AgentOptions {
  model: string;
  effort: string;
}

export const UNSET_OPTIONS: AgentOptions = { model: "", effort: "" };

const optionsKey = (agent: AgentId): string => `agentOptions:${agent}`;
const LAST_AGENT_KEY = "agentOptionsAgent";

/**
 * 저장된 JSON을 **검증 파서**로 통과시킨다 — 모르는 값(구 버전이 쓴 값, 손으로
 * 고친 값, 어휘에서 빠진 값)은 조용히 "미지정"으로 떨어뜨린다. 기억은 편의지
 * 계약이 아니므로 손상된 저장값이 세션 스폰을 망가뜨려선 안 된다.
 *
 * 검증은 **그 에이전트의 어휘로만** 한다 — 키가 갈려 있어도(`agentOptions:*`)
 * 사용자가 손으로 고치거나 어휘가 개정되면 남의 값이 들어올 수 있고, codex 쪽은
 * 오값이 경고가 아니라 첫 요청 400이다.
 */
export function parseAgentOptions(raw: string | null, agent: AgentId = DEFAULT_AGENT): AgentOptions {
  if (!raw) return UNSET_OPTIONS;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return UNSET_OPTIONS;
  }
  if (typeof obj !== "object" || obj === null) return UNSET_OPTIONS;
  const rec = obj as Record<string, unknown>;
  const model = modelChoices(agent).some((m) => m === rec.model) ? (rec.model as string) : "";
  const effort = effortChoices(agent).some((e) => e === rec.effort) ? (rec.effort as string) : "";
  return { model, effort };
}

/** 이 에이전트로 마지막에 연 세션의 설정 (없거나 이상하면 미지정). */
export function loadAgentOptions(agent: AgentId): AgentOptions {
  try {
    return parseAgentOptions(localStorage.getItem(optionsKey(agent)), agent);
  } catch {
    return UNSET_OPTIONS; // 저장소가 막힌 환경 — 미지정으로 계속 동작한다
  }
}

/** 고른 설정을 기억한다 (실패는 무시 — 기억은 편의지 계약이 아니다). */
export function saveAgentOptions(agent: AgentId, opts: AgentOptions): void {
  try {
    localStorage.setItem(optionsKey(agent), JSON.stringify(opts));
  } catch {
    /* 저장 실패는 무해 */
  }
}

/** 마지막으로 고른 에이전트 — 고를 수 없게 된 값은 기본값으로 되돌린다. */
export function loadLastAgent(): AgentId {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return DEFAULT_AGENT;
  }
  const hit = AGENT_CHOICES.find((a) => a.id === saved);
  return hit && hit.enabled ? hit.id : DEFAULT_AGENT;
}

export function saveLastAgent(agent: AgentId): void {
  try {
    localStorage.setItem(LAST_AGENT_KEY, agent);
  } catch {
    /* 저장 실패는 무해 */
  }
}

/**
 * 패널 params / `claude_open_or_attach` 인자에 실을 필드.
 *
 * 빈 문자열을 **키째 없애는** 것이 요점이다: params는 dockview 레이아웃 JSON으로
 * 직렬화되므로 `""`를 남기면 "미지정"이 아니라 "빈 값"이 저장되고, 구 레이아웃과
 * 새 레이아웃이 서로 다른 모양이 된다. 백엔드도 빈 문자열을 unset으로 취급하니
 * 결과는 같지만, 저장 형태가 하나여야 회귀 테스트가 의미를 가진다.
 */
export function spawnOptionFields(opts: AgentOptions): { model?: string; effort?: string } {
  return {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
}
