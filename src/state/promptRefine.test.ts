import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REFINE_MODEL,
  PROMPT_FENCE,
  REFINE_KIND,
  applyBlockReason,
  bracketedPaste,
  extractLatestPromptBlock,
  extractPromptBlock,
  injectDeliveryDecision,
  isRefineParams,
  openPromptRefine,
  refinePanelId,
  refineSeedPrompt,
  resolveApplyAck,
  type RefineDock,
} from "./promptRefine";

/** 최소 dock 스텁 — addPanel은 호출 인자를 기록하고 패널 목록에 반영한다. */
function fakeDock(initial: { id: string; params?: unknown }[] = []) {
  const added: Parameters<RefineDock["addPanel"]>[0][] = [];
  const setActive = vi.fn();
  const close = vi.fn();
  type FakePanel = { id: string; params?: unknown; api: { setActive: () => void; close: () => void } };
  const panels: FakePanel[] = initial.map((p) => ({ ...p, api: { setActive, close } }));
  const dock: RefineDock = {
    getPanel: (id) => panels.find((p) => p.id === id),
    addPanel: (opts) => {
      added.push(opts);
      panels.push({ id: opts.id, params: opts.params, api: { setActive, close } });
      return null;
    },
  };
  return { dock, added, setActive };
}

const args = {
  sourcePanelId: "claudeterm-m-1-1",
  targetUuid: "u-main",
  workdir: "/tmp/claude-workbench-refine",
  sessionUuid: "u-refine",
  model: DEFAULT_REFINE_MODEL,
  title: "작업 A",
};

describe("openPromptRefine — 우측 배치 · 탭당 1개", () => {
  it("없으면 결정적 id로 원 탭 오른쪽에 claudeterm을 연다", () => {
    const { dock, added } = fakeDock([{ id: args.sourcePanelId, params: { kind: "claudeterm" } }]);
    expect(openPromptRefine(dock, args)).toBe("opened");
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(refinePanelId(args.sourcePanelId));
    // 컴포넌트는 claudeterm 그대로 — 세션 수명 경로를 물려받아야 PTY가 새지 않는다.
    expect(added[0].component).toBe("claudeterm");
    expect(added[0].position).toEqual({ referencePanel: args.sourcePanelId, direction: "right" });
    expect(added[0].params).toMatchObject({
      kind: "claudeterm",
      refineKind: REFINE_KIND,
      project: args.workdir,
      loadSessionId: args.sessionUuid,
      model: "opus",
      sourcePanelId: args.sourcePanelId,
      targetUuid: args.targetUuid,
    });
    // 격리: cwd는 프로젝트가 아니라 스크래치 디렉토리여야 한다.
    expect((added[0].params as { project: string }).project).toContain("refine");
    // 시드는 기계 추출 규약(```prompt)을 반드시 포함한다.
    expect((added[0].params as { seed: string }).seed).toContain(`${PROMPT_FENCE}prompt`);
  });

  it("같은 탭에서 다시 열면 새로 만들지 않고 기존 패널을 포커스한다", () => {
    const { dock, added, setActive } = fakeDock([
      { id: args.sourcePanelId, params: { kind: "claudeterm" } },
    ]);
    openPromptRefine(dock, args);
    added.length = 0;
    expect(openPromptRefine(dock, args)).toBe("focused");
    expect(added).toHaveLength(0);
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it("다른 탭은 별도 패널", () => {
    const { dock, added } = fakeDock();
    openPromptRefine(dock, args);
    openPromptRefine(dock, { ...args, sourcePanelId: "claudeterm-m-1-2" });
    expect(added.map((a) => a.id)).toEqual([
      refinePanelId("claudeterm-m-1-1"),
      refinePanelId("claudeterm-m-1-2"),
    ]);
  });

  it("모델은 고른 값이 그대로 실린다", () => {
    const { dock, added } = fakeDock();
    openPromptRefine(dock, { ...args, model: "fable" });
    expect(added[0].params).toMatchObject({ model: "fable" });
  });
});

describe("isRefineParams", () => {
  it("refineKind로만 판정한다 (kind는 claudeterm 그대로)", () => {
    expect(isRefineParams({ kind: "claudeterm", refineKind: REFINE_KIND })).toBe(true);
    expect(isRefineParams({ kind: "claudeterm" })).toBe(false);
    expect(isRefineParams({ kind: REFINE_KIND })).toBe(false);
    expect(isRefineParams(undefined)).toBe(false);
    expect(isRefineParams(null)).toBe(false);
    expect(isRefineParams("promptrefine")).toBe(false);
  });
});

describe("extractPromptBlock — 마지막으로 닫힌 prompt 블록", () => {
  it("실계약: 4중 fence 안의 3중 코드블록이 최종본을 자르지 않는다", () => {
    const text = [
      "정리했어.",
      "",
      "````prompt",
      "아래 코드를 고쳐라:",
      "```ts",
      "const x = 1;",
      "```",
      "완료 기준: 테스트 green.",
      "````",
      "",
      "어때?",
    ].join("\n");
    expect(extractPromptBlock(text)).toBe(
      "아래 코드를 고쳐라:\n```ts\nconst x = 1;\n```\n완료 기준: 테스트 green.",
    );
  });

  it("시드가 요구한 형식(PROMPT_FENCE)으로 쓴 최종본을 읽는다", () => {
    const text = `${PROMPT_FENCE}prompt\n본문\n${PROMPT_FENCE}`;
    expect(extractPromptBlock(text)).toBe("본문");
  });

  it("**3중 fence는 인정하지 않는다** — 규약 미준수 응답은 최종본 없음으로 본다", () => {
    // 받아 주면 본문의 코드 예제 ```에서 잘린 프롬프트를 최종본이라 부르게 된다.
    expect(extractPromptBlock("```prompt\n로그인 버그를 고쳐라.\n재현: 1) …\n```")).toBeNull();
    expect(
      extractLatestPromptBlock(new Map([[1, "```prompt\n3중으로 낸 최종본\n```"]])),
    ).toBeNull();
  });

  it("5중 이상으로 더 크게 열어도 인정한다(하한만 강제)", () => {
    expect(extractPromptBlock("`````prompt\n본문\n`````")).toBe("본문");
  });

  it("여러 개면 **마지막** 것을 고른다 (수정 라운드마다 새 블록이 붙으므로)", () => {
    const text = [
      "1차:",
      "````prompt",
      "첫 번째",
      "````",
      "2차로 다듬었다:",
      "````prompt",
      "두 번째",
      "````",
    ].join("\n");
    expect(extractPromptBlock(text)).toBe("두 번째");
  });

  it("prompt가 아닌 펜스는 무시한다", () => {
    expect(extractPromptBlock("```ts\nconst x = 1;\n```\n```\nplain\n```")).toBeNull();
  });

  it("더 긴 펜스로 감싼 예시 안의 prompt 블록은 열림으로 오인하지 않는다", () => {
    const text = [
      "`````markdown",
      "````prompt",
      "예시일 뿐 최종본이 아님",
      "````",
      "`````",
      "",
      "진짜 최종본:",
      "````prompt",
      "진짜",
      "````",
    ].join("\n");
    expect(extractPromptBlock(text)).toBe("진짜");
  });

  it("바깥이 긴 펜스 하나뿐이면(안쪽만 prompt) 아무것도 추출하지 않는다", () => {
    const text = ["`````markdown", "````prompt", "예시", "````", "`````"].join("\n");
    expect(extractPromptBlock(text)).toBeNull();
  });

  it("**닫히지 않은 블록은 최종본이 아니다** (스트리밍 중 반쪽 적용 차단)", () => {
    expect(extractPromptBlock("````prompt\n쓰는 중인 프롬프트")).toBeNull();
    // 앞의 닫힌 블록이 있으면 그쪽이 남는다 — 미완 블록이 그것을 덮지 않는다.
    const text = ["````prompt", "완성본", "````", "다시 쓰는 중:", "````prompt", "반쪽"].join(
      "\n",
    );
    expect(extractPromptBlock(text)).toBe("완성본");
  });

  it("블록 없음 · 빈 블록 · 빈 입력은 null (적용 버튼이 비활성으로 남는 신호)", () => {
    expect(extractPromptBlock("설명만 있고 블록이 없다")).toBeNull();
    expect(extractPromptBlock("````prompt\n\n````")).toBeNull();
    expect(extractPromptBlock("````prompt\n   \n````")).toBeNull();
    expect(extractPromptBlock("")).toBeNull();
    expect(extractPromptBlock(null)).toBeNull();
    expect(extractPromptBlock(undefined)).toBeNull();
  });

  it("들여쓴 펜스(목록 안)도 인식하고 본문 들여쓰기는 보존한다", () => {
    expect(extractPromptBlock("  ````prompt\n  들여쓴 본문\n    더 들여씀\n  ````")).toBe(
      "  들여쓴 본문\n    더 들여씀",
    );
  });

  it("info string에 꼬리말이 붙어도 prompt로 본다", () => {
    expect(extractPromptBlock("````prompt (최종)\n본문\n````")).toBe("본문");
  });

  it("info string에 백틱이 섞인 줄은 펜스가 아니다", () => {
    expect(extractPromptBlock("````prompt `x`\n본문\n````")).toBeNull();
  });

  it("병리적 입력에서도 즉시 끝난다(정규식 백트래킹 완화)", () => {
    const pathological = "`".repeat(3) + "a".repeat(20000) + " ";
    const t0 = Date.now();
    expect(extractPromptBlock(pathological)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("extractLatestPromptBlock — 턴 역방향 탐색", () => {
  it("최종본 뒤에 확인 턴이 더 붙어도 직전 최종본을 찾는다", () => {
    const answers = new Map<number, string>([
      [1, "질문부터 할게요."],
      [2, "````prompt\n최종본 A\n````"],
      [3, "이대로 적용하시겠어요?"],
    ]);
    expect(extractLatestPromptBlock(answers)).toBe("최종본 A");
  });

  it("여러 턴에 블록이 있으면 가장 큰 턴 번호 쪽", () => {
    const answers: [number, string][] = [
      [2, "````prompt\n구버전\n````"],
      [5, "````prompt\n신버전\n````"],
      [3, "````prompt\n중간\n````"],
    ];
    expect(extractLatestPromptBlock(answers)).toBe("신버전");
  });

  it("어디에도 닫힌 블록이 없으면 null", () => {
    expect(extractLatestPromptBlock(new Map([[1, "설명뿐"]]))).toBeNull();
    expect(extractLatestPromptBlock(new Map())).toBeNull();
  });
});

describe("applyBlockReason — [적용] 게이트", () => {
  const ok = {
    block: "본문",
    targetUuid: "u-main",
    targetBlocked: false,
    slotBusy: false,
    pending: false,
  };

  it("모든 조건이 맞으면 막지 않는다", () => {
    expect(applyBlockReason(ok)).toBeNull();
  });

  it("대상 세션이 blocked면 거부한다 (페이스트가 키 입력으로 소비되는 경로 차단)", () => {
    const reason = applyBlockReason({ ...ok, targetBlocked: true });
    expect(reason).toContain("입력을 기다리는 상태");
    expect(reason).toContain("키 입력");
  });

  it("최종본 없음 · 대상 없음 · 슬롯 점유 · 이미 대기 중을 각각 구분해 안내한다", () => {
    expect(applyBlockReason({ ...ok, block: null })).toContain("최종본이 없습니다");
    expect(applyBlockReason({ ...ok, targetUuid: null })).toContain("찾을 수 없습니다");
    expect(applyBlockReason({ ...ok, slotBusy: true })).toContain("아직 처리되지 않았습니다");
    expect(applyBlockReason({ ...ok, pending: true })).toContain("기다리는 중");
  });

  it("우선순위: 대기 중 > 최종본 없음 > 대상 없음 > blocked > 슬롯 점유", () => {
    expect(applyBlockReason({ ...ok, pending: true, block: null })).toContain("기다리는 중");
    expect(applyBlockReason({ ...ok, block: null, targetBlocked: true })).toContain(
      "최종본이 없습니다",
    );
    expect(applyBlockReason({ ...ok, targetBlocked: true, slotBusy: true })).toContain(
      "입력을 기다리는 상태",
    );
  });
});

describe("bracketedPaste — 제출 금지 불변식", () => {
  const ESC = "\x1b";

  it("본문을 페이스트 시퀀스로 감싸고 **CR을 절대 붙이지 않는다**", () => {
    const out = bracketedPaste("첫 줄\n둘째 줄");
    expect(out).toBe(`${ESC}[200~첫 줄\n둘째 줄${ESC}[201~`);
    // 실측(2026-08-05): claude TUI는 `\r`만 제출로 읽는다 — 한 글자도 있으면 안 된다.
    expect(out).not.toContain("\r");
    expect(out.endsWith("~")).toBe(true);
  });

  it("본문의 CRLF/CR는 LF로 정규화한다", () => {
    expect(bracketedPaste("a\r\nb\rc")).toBe(`${ESC}[200~a\nb\nc${ESC}[201~`);
  });

  it("본문에 숨어 있는 페이스트 시퀀스는 제거한다(붙여넣기 조기 종료 방지)", () => {
    const evil = `앞${ESC}[201~ 뒤${ESC}[200~`;
    const out = bracketedPaste(evil);
    expect(out).toBe(`${ESC}[200~앞 뒤${ESC}[201~`);
    expect(out.split(`${ESC}[201~`)).toHaveLength(2);
  });

  it("빈 본문도 시퀀스 형태는 지킨다", () => {
    expect(bracketedPaste("")).toBe(`${ESC}[200~${ESC}[201~`);
  });
});

describe("refineSeedPrompt — 기계 추출 규약", () => {
  it("추출기가 읽는 펜스(4중)를 시드가 그대로 명시한다 — 계약이 한 상수로 묶인다", () => {
    expect(refineSeedPrompt()).toContain(`${PROMPT_FENCE}prompt`);
    expect(PROMPT_FENCE).toBe("````");
  });

  it("한 줄이다 — 실측상 여러 줄 버퍼는 CR로 제출되지 않으므로 시드는 접혀 있어야 한다", () => {
    expect(refineSeedPrompt()).not.toContain("\n");
  });

  it("시드 자체가 추출 대상이 되지 않는다(정리 세션 첫 답변 전 [적용] 오작동 방지)", () => {
    expect(extractPromptBlock(refineSeedPrompt())).toBeNull();
  });
});

describe("injectDeliveryDecision — 미배달과 소비를 가르는 규칙", () => {
  const base = {
    request: { id: "r1", uuid: "u-main" },
    myUuid: "u-main",
    isDriver: true,
    sessionOpen: true,
    blocked: false,
    handledId: null,
  };

  it("조건이 다 맞으면 쓴다", () => {
    expect(injectDeliveryDecision(base)).toBe("write");
  });

  it("남의 세션 요청·요청 없음·내 uuid 미확정은 무시", () => {
    expect(injectDeliveryDecision({ ...base, request: null })).toBe("ignore");
    expect(injectDeliveryDecision({ ...base, myUuid: null })).toBe("ignore");
    expect(injectDeliveryDecision({ ...base, request: { id: "r1", uuid: "other" } })).toBe(
      "ignore",
    );
  });

  it("이미 착수한 요청은 무시 (리마운트·deps 재평가로 두 번 쓰지 않는다)", () => {
    expect(injectDeliveryDecision({ ...base, handledId: "r1" })).toBe("ignore");
    // 다른 id면 새 요청이니 쓴다.
    expect(injectDeliveryDecision({ ...base, handledId: "r0" })).toBe("write");
  });

  it("미러·세션 미오픈은 **defer** — 요청을 소비하지 않는다", () => {
    expect(injectDeliveryDecision({ ...base, isDriver: false })).toBe("defer");
    expect(injectDeliveryDecision({ ...base, sessionOpen: false })).toBe("defer");
  });

  it("blocked면 쓰기 직전이라도 **defer** — 페이스트가 키 입력으로 소비되는 것을 막는다", () => {
    expect(injectDeliveryDecision({ ...base, blocked: true })).toBe("defer");
    // 해소되면 (호출부의 deps가 다시 물어) 바로 쓴다.
    expect(injectDeliveryDecision({ ...base, blocked: false })).toBe("write");
  });

  it("defer는 착수 여부보다 우선한다 — 보류 중인 요청이 '처리됨'으로 굳지 않는다", () => {
    expect(injectDeliveryDecision({ ...base, blocked: true, handledId: "r1" })).toBe("defer");
  });
});

describe("resolveApplyAck — 내 요청 id의 결과만 신뢰", () => {
  it("id가 맞고 ok면 배달 확인", () => {
    expect(resolveApplyAck("r1", { id: "r1", ok: true })).toEqual({ kind: "delivered" });
  });

  it("id가 맞고 실패면 사유와 함께 실패 (정리 세션 보존)", () => {
    expect(resolveApplyAck("r1", { id: "r1", ok: false, reason: "권한 없음" })).toEqual({
      kind: "failed",
      reason: "권한 없음",
    });
    expect(resolveApplyAck("r1", { id: "r1", ok: false })).toEqual({
      kind: "failed",
      reason: "알 수 없는 이유",
    });
  });

  it("남의 id·결과 없음·대기 id 없음은 계속 대기", () => {
    expect(resolveApplyAck("r1", { id: "r2", ok: true })).toEqual({ kind: "wait" });
    expect(resolveApplyAck("r1", null)).toEqual({ kind: "wait" });
    expect(resolveApplyAck(null, { id: "r1", ok: true })).toEqual({ kind: "wait" });
  });

  it("남의 성공 결과를 내 성공으로 오인하지 않는다 (슬롯 추론 회귀 방지)", () => {
    expect(resolveApplyAck("mine", { id: "dev-seed", ok: true }).kind).toBe("wait");
  });
});
