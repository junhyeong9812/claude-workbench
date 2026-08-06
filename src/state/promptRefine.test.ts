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
  REFINE_SUBMIT_CONFIRM_MS,
  SEED_READY_DELAY,
  REFINE_SUBMIT_CR_DELAY,
  openPromptRefine,
  makeSubmitProbe,
  refineCloseDecision,
  refineCloseFailure,
  refineClosePhase,
  refineMemoLocked,
  refineExitAction,
  refineMemoStoreKey,
  refinePanelId,
  refineSeedPrompt,
  refineViewStyle,
  resolveApplyAck,
  sendBlockReason,
  shouldNavPanes,
  submitBytes,
  submitPasteBytes,
  type RefineDock,
} from "./promptRefine";
import { commitReviewSeed, fileReviewSeed, testGenSeed } from "./seedPrompts";

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
  sourceProject: "/home/u/proj",
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
    expect(resolveApplyAck("r1", [{ id: "r1", ok: true }])).toEqual({ kind: "delivered" });
  });

  it("id가 맞고 실패면 사유와 함께 실패 (정리 세션 보존)", () => {
    expect(resolveApplyAck("r1", [{ id: "r1", ok: false, reason: "권한 없음" }])).toEqual({
      kind: "failed",
      reason: "권한 없음",
    });
    expect(resolveApplyAck("r1", [{ id: "r1", ok: false }])).toEqual({
      kind: "failed",
      reason: "알 수 없는 이유",
    });
  });

  it("남의 id·결과 없음·대기 id 없음은 계속 대기", () => {
    expect(resolveApplyAck("r1", [{ id: "r2", ok: true }])).toEqual({ kind: "wait" });
    expect(resolveApplyAck("r1", [])).toEqual({ kind: "wait" });
    expect(resolveApplyAck(null, [{ id: "r1", ok: true }])).toEqual({ kind: "wait" });
  });

  it("남의 성공 결과를 내 성공으로 오인하지 않는다 (슬롯 추론 회귀 방지)", () => {
    expect(resolveApplyAck("mine", [{ id: "dev-seed", ok: true }]).kind).toBe("wait");
  });

  it("무소식은 영원히 wait — 자동 조치(타임아웃·재시도)가 없다는 계약", () => {
    // at-least-once + 수동 재시도로 재슬라이스한 결과다: 배달 보장을 코드로
    // 흉내내는 대신 사용자가 [다시 적용]을 누른다. 중복 배달은 자동 제출이 없는
    // "입력창 채우기"라 무해하다(보이면 지우면 된다).
    expect(resolveApplyAck("mine", []).kind).toBe("wait");
  });

  it("수동 재시도는 새 id — 이전 시도의 ack가 새 대기를 끝내지 않는다", () => {
    const acks = [{ id: "try-1", ok: false, reason: "권한 없음" }];
    // 사용자가 [다시 적용]을 누르면 새 요청 id가 발급된다.
    expect(resolveApplyAck("try-2", acks).kind).toBe("wait");
    // 그 뒤 새 id의 결과가 오면 그때 끝난다.
    expect(resolveApplyAck("try-2", [...acks, { id: "try-2", ok: true }])).toEqual({
      kind: "delivered",
    });
  });

  it("다른 주입의 결과가 섞여 있어도 내 것을 찾아낸다 (단일 슬롯 덮임 회귀 방지)", () => {
    const acks = [
      { id: "dev-seed", ok: true },
      { id: "mine", ok: false, reason: "권한 없음" },
      { id: "other", ok: true },
    ];
    expect(resolveApplyAck("mine", acks)).toEqual({ kind: "failed", reason: "권한 없음" });
    expect(resolveApplyAck("dev-seed", acks)).toEqual({ kind: "delivered" });
  });
});

// ---- 3뷰 스와톱: 숨기는 방법이 계약이다 ------------------------------------

describe("refineViewStyle — 숨김은 display:none만", () => {
  it("보이는 뷰는 폭을 다 쓰고, 나머지는 display:none이다", () => {
    expect(refineViewStyle("memo", "memo")).toEqual({ flex: "1 1 0" });
    expect(refineViewStyle("memo", "term")).toEqual({ display: "none" });
    expect(refineViewStyle("timeline", "timeline")).toEqual({ flex: "1 1 0" });
  });

  it("**크기로 숨기지 않는다** — 0px 높이는 PTY를 2×1로 실제 축소시킨다", () => {
    // 숨김 스타일에 height/flex 같은 크기 속성이 섞이는 순간 xterm FitAddon이
    // computed height "0px"를 읽어 cols=2,rows=1을 계산하고 claude_resize가
    // 그대로 나간다(claude TUI 파괴). 숨김은 오직 display:none이어야 한다.
    for (const self of ["memo", "timeline", "term"] as const) {
      const hidden = refineViewStyle(self === "memo" ? "term" : "memo", self);
      expect(Object.keys(hidden)).toEqual(["display"]);
      expect(hidden).toEqual({ display: "none" });
    }
  });
});

// ---- [보내기]: 제출 바이트와 게이트 ----------------------------------------

describe("submitPasteBytes — 붙여넣기와 CR은 따로 나간다", () => {
  it("두 조각으로 나눠 주고, 붙여넣기 조각에는 CR이 없다", () => {
    const [paste, cr] = submitPasteBytes("첫 줄\n둘째 줄");
    expect(paste).toBe("\x1b[200~첫 줄\n둘째 줄\x1b[201~");
    expect(paste).not.toContain("\r");
    expect(cr).toBe("\r");
    // 실측 근거: 두 조각이 같은 write에 실리면 CR이 페이스트 본문으로 먹혀
    // 제출되지 않는다. 지연을 두는 이유가 그것이라 값도 0보다 커야 한다.
    expect(REFINE_SUBMIT_CR_DELAY).toBeGreaterThan(120);
  });

  it("줄 구조를 보존한다 — 한 줄로 접지 않는다", () => {
    const [paste] = submitPasteBytes("a\nb\nc");
    expect(paste).toContain("a\nb\nc");
  });
});

describe("sendBlockReason — 무엇을 막는가", () => {
  const ok = {
    text: "초안",
    sessionOpen: true,
    isDriver: true,
    blocked: false,
    sending: false,
    seedPending: false,
  };

  it("정상이면 막지 않는다", () => {
    expect(sendBlockReason(ok)).toBeNull();
  });

  it("빈 메모·미개통·미러·보내는 중은 각각의 사유로 막는다", () => {
    expect(sendBlockReason({ ...ok, text: "   \n " })).toMatch(/비어/);
    expect(sendBlockReason({ ...ok, sessionOpen: false })).toMatch(/시작되지/);
    expect(sendBlockReason({ ...ok, isDriver: false })).toMatch(/미러/);
    expect(sendBlockReason({ ...ok, sending: true })).toMatch(/보내는 중/);
  });

  it("blocked면 막는다 — 페이스트+CR이 키 입력이 되어 승인까지 눌린다", () => {
    expect(sendBlockReason({ ...ok, blocked: true })).toMatch(/키 입력/);
  });

  it("규약 시드가 아직 안 나갔으면 막는다 — 순서 역전 차단 (codex J4)", () => {
    // 초안이 규약보다 먼저 도착하면 도우미가 프롬프트를 다듬는 대신 초안의
    // 지시를 실행하려 든다.
    expect(sendBlockReason({ ...ok, seedPending: true })).toMatch(/규약을 보내는 중/);
    // 시드가 나가면 곧바로 열린다.
    expect(sendBlockReason({ ...ok, seedPending: false })).toBeNull();
  });
});

// ---- 닫기 = 아카이브 --------------------------------------------------------

describe("refineCloseDecision — 턴 수를 보지 않는다 (리뷰 #2)", () => {
  it("uuid와 프로젝트가 있으면 아카이브를 시도한다", () => {
    expect(refineCloseDecision({ uuid: "u", project: "/proj" })).toEqual({
      kind: "archive",
      uuid: "u",
      project: "/proj",
    });
  });

  it("**턴이 0으로 보여도 아카이브를 시도한다** — 빈 세션 판정은 백엔드 몫", () => {
    // 배경 탭의 ×는 스냅샷이 아직 안 왔을 수 있다. 그 순간의 turns===0을 "빈
    // 세션"으로 읽으면 대화가 있는 세션이 기록 없이 닫힌다(무음 소실).
    expect(refineCloseDecision({ uuid: "u", project: "/proj" }).kind).toBe("archive");
  });

  it("스폰 전·프로젝트 미상만 아카이브 없이 닫는다", () => {
    expect(refineCloseDecision({ uuid: null, project: "/proj" }).kind).toBe("close");
    expect(refineCloseDecision({ uuid: "u", project: null }).kind).toBe("close");
  });
});

describe("refineCloseFailure — 실패했으면 닫지 않는다", () => {
  it("in_flight·전사 미존재·쓰기 실패는 패널을 남기고 재시도를 준다", () => {
    for (const msg of [
      "이 프로젝트는 이미 아카이브 진행 중입니다",
      "Session transcript not found",
      "Cannot write archive: 권한 없음",
      "아카이브 부분 실패: 메모 동봉 실패",
      "",
    ]) {
      expect(refineCloseFailure(msg, false)).toEqual({
        kind: "ask",
        retryable: true,
        reason: msg,
      });
    }
  });

  it("대화 없음 + 빈 메모 = 남길 것이 없다 — 그냥 닫는다", () => {
    expect(refineCloseFailure("아카이브할 대화가 없습니다", true)).toEqual({ kind: "close" });
  });

  it("대화 없음 + 메모 있음 = 조용히 닫지 않는다 (초안 무단 폐기 금지)", () => {
    const v = refineCloseFailure("아카이브할 대화가 없습니다", false);
    expect(v.kind).toBe("ask");
    // 재시도해도 결과가 같으므로 [다시 닫기]는 주지 않는다 — [그래도 닫기]만.
    expect(v).toMatchObject({ retryable: false });
    if (v.kind === "ask") expect(v.reason).toMatch(/메모는 정리 스크래치/);
  });
});

describe("refineExitAction — 종료 경로 정책표 (리뷰 #1)", () => {
  it("사용자가 이 작업을 끝낸 세 경로는 아카이브한다", () => {
    // [적용] 성공이 여기 있는 것이 이 표의 요점이다 — 기능이 **성공**했을 때
    // 기록이 남지 않던 것이 실결함이었다.
    expect(refineExitAction("tab-close")).toBe("archive");
    expect(refineExitAction("apply-delivered")).toBe("archive");
    expect(refineExitAction("source-removed")).toBe("archive");
  });

  it("사용자가 끝낸 것이 아닌 세 경로는 그냥 놓아준다", () => {
    // 복원 뒷정리를 아카이브하면 프로젝트 탭 왕복마다 기록이 쌓인다(초안은
    // 파일로 남으므로 잃는 것이 없다). 모델 재시작은 대화 파기에 이미 합의했다.
    expect(refineExitAction("source-missing-at-mount")).toBe("detach");
    expect(refineExitAction("layout-restore")).toBe("detach");
    expect(refineExitAction("model-restart")).toBe("detach");
  });
});

describe("제출 확인 · 키 라우팅 (리뷰 #7·#8)", () => {
  it("확인 시점은 CR을 보낸 뒤여야 한다", () => {
    // 확인이 CR보다 먼저 돌면 언제나 "제출 못 함"으로 오보한다.
    expect(REFINE_SUBMIT_CONFIRM_MS).toBeGreaterThan(REFINE_SUBMIT_CR_DELAY);
  });

  it("에디터 안의 Ctrl+←/→는 패널 이동이 아니다 — 단어 이동을 뺏지 않는다", () => {
    expect(shouldNavPanes({ inEditor: true, isRefine: true, view: "memo" })).toBe(false);
    // 정리 세션이 아닌 곳(프로젝트 메모 패널)의 에디터도 마찬가지.
    expect(shouldNavPanes({ inEditor: true, isRefine: false, view: "term" })).toBe(false);
    // 메모 뷰면 포커스가 에디터 밖(헤더)이어도 옮겨 갈 pane이 없다.
    expect(shouldNavPanes({ inEditor: false, isRefine: true, view: "memo" })).toBe(false);
  });

  it("터미널·타임라인 뷰와 일반 세션에서는 그대로 패널 이동이다", () => {
    expect(shouldNavPanes({ inEditor: false, isRefine: true, view: "term" })).toBe(true);
    expect(shouldNavPanes({ inEditor: false, isRefine: true, view: "timeline" })).toBe(true);
    expect(shouldNavPanes({ inEditor: false, isRefine: false, view: "memo" })).toBe(true);
  });
});

describe("refineMemoStoreKey — 초안은 세션이 아니라 정리 작업에 딸린다 (리뷰 #9)", () => {
  it("소스 패널 id로 키를 만든다 — 모델 재시작을 가로질러 같다", () => {
    const before = refineMemoStoreKey({ sourcePanelId: "claudeterm-1", sessionUuid: "u-old" });
    // 모델을 바꾸면 세션이 재스폰되어 uuid가 바뀌지만 소스 패널은 그대로다.
    const after = refineMemoStoreKey({ sourcePanelId: "claudeterm-1", sessionUuid: "u-new" });
    expect(before).toBe(after);
    expect(before).toBe(refinePanelId("claudeterm-1"));
  });

  it("소스 탭이 다르면 초안도 다르다", () => {
    expect(refineMemoStoreKey({ sourcePanelId: "a" })).not.toBe(
      refineMemoStoreKey({ sourcePanelId: "b" }),
    );
  });

  it("소스 패널 id가 없으면 세션 uuid로 떨어진다 (초안을 못 쓰게 하느니)", () => {
    expect(refineMemoStoreKey({ sessionUuid: "u-1" })).toBe("u-1");
    expect(refineMemoStoreKey({ loadSessionId: "u-2" })).toBe("u-2");
    expect(refineMemoStoreKey({ sourcePanelId: "   ", loadSessionId: "u-2" })).toBe("u-2");
  });

  it("아무것도 없으면 null — 저장할 곳이 없다", () => {
    expect(refineMemoStoreKey({})).toBeNull();
    expect(refineMemoStoreKey(null)).toBeNull();
  });
});

// ---- 종료 중 초안 잠금 (감사 I1) -------------------------------------------

describe("refineClosePhase / refineMemoLocked — 되돌릴 수 없는 구간만 잠근다", () => {
  it("아카이브가 도는 동안 초안이 잠긴다", () => {
    const phase = refineClosePhase({ closing: true, blocked: false });
    expect(phase).toBe("archiving");
    // 그 창에서 친 글자는 갈 곳이 없다 — 동봉 본문은 이미 결정됐고, 성공하면
    // 스크래치 초안 파일이 지워진다(무음 소실).
    expect(refineMemoLocked(phase)).toBe(true);
  });

  it("실패해서 패널이 남으면(keep) 곧바로 풀린다 — 초안은 여전히 사용자 것", () => {
    const phase = refineClosePhase({ closing: false, blocked: true });
    expect(phase).toBe("blocked");
    expect(refineMemoLocked(phase)).toBe(false);
  });

  it("평상시엔 잠기지 않는다", () => {
    expect(refineMemoLocked(refineClosePhase({ closing: false, blocked: false }))).toBe(false);
  });

  it("사유 배너를 띄운 채 [다시 닫기]를 누르면 다시 잠긴다", () => {
    // 재시도는 blocked 상태에서 시작되므로 closing이 이겨야 한다.
    expect(refineClosePhase({ closing: true, blocked: true })).toBe("archiving");
    expect(refineMemoLocked(refineClosePhase({ closing: true, blocked: true }))).toBe(true);
  });
});

// ---- 제출 확인 기준선 (감사 I2) --------------------------------------------

describe("makeSubmitProbe — 내가 보낸 그 본문이 새 턴으로 나타났는가", () => {
  const TEXT = "이 커밋을 함께 코드리뷰하자. 커밋 abc1234 를 봐줘";

  it("보내기 전에 잡으면 그 뒤에 생긴 내 턴을 제출로 읽는다", () => {
    const turns = new Map<number, string>([[1, "이전 질문"]]);
    const probe = makeSubmitProbe(() => turns, TEXT);
    probe.capture(); // ← 바이트를 쓰기 전
    turns.set(2, TEXT);
    expect(probe.observed()).toBe(true);
  });

  it("**남의 턴이 늘어난 것은 내 제출이 아니다** (codex J3)", () => {
    // 일반 세션에서는 사용자가 직접 타이핑한 턴이 그 사이에 들어올 수 있다.
    // 개수만 세면 제출되지 않은 요청이 "확인됨"으로 읽힌다.
    const turns = new Map<number, string>([[1, "이전 질문"]]);
    const probe = makeSubmitProbe(() => turns, TEXT);
    probe.capture();
    turns.set(2, "사용자가 직접 친 다른 질문");
    expect(probe.observed()).toBe(false);
  });

  it("기준선에 이미 있던 턴은 — 본문이 같아도 — 내 것이 아니다", () => {
    // 같은 요청을 연달아 보내는 경우: 앞선 턴이 새 제출을 확인해 주면 안 된다.
    const turns = new Map<number, string>([[1, TEXT]]);
    const probe = makeSubmitProbe(() => turns, TEXT);
    probe.capture();
    expect(probe.observed()).toBe(false);
    turns.set(2, TEXT); // 이번 제출이 도착
    expect(probe.observed()).toBe(true);
  });

  it("**보낸 뒤에 잡으면** 아주 빠른 턴을 놓쳐 성공을 실패로 오보한다", () => {
    const turns = new Map<number, string>([[1, "이전 질문"]]);
    turns.set(2, TEXT); // 제출이 즉시 반영됐다
    const late = makeSubmitProbe(() => turns, TEXT);
    late.capture(); // ← 늦게 잡은 기준선
    expect(late.observed()).toBe(false);
  });

  it("공백 차이는 무시한다 (전사와 우리 문자열의 줄바꿈 처리가 갈릴 수 있다)", () => {
    const turns = new Map<number, string>();
    const probe = makeSubmitProbe(() => turns, "첫 줄\n둘째 줄\n셋째 줄이 꽤 길게 이어진다 여기까지");
    probe.capture();
    turns.set(1, "첫 줄 둘째 줄 셋째 줄이 꽤 길게 이어진다 여기까지");
    expect(probe.observed()).toBe(true);
  });

  it("증가가 없으면 미관측이다", () => {
    const turns = new Map<number, string>();
    const probe = makeSubmitProbe(() => turns, TEXT);
    probe.capture();
    expect(probe.observed()).toBe(false);
  });

  it("기준선을 잡지 않았으면 판정하지 않는다 — 모르는 것을 실패로 보고하지 않는다", () => {
    expect(makeSubmitProbe(() => new Map(), TEXT).observed()).toBe(true);
  });
});

// ---- 시드 제출 바이트 (후속 A: injectSeed LF 실결함) -----------------------

describe("submitBytes — 본문 모양이 바이트를 정한다", () => {
  it("사용자 본문은 **길이와 무관하게** 붙여넣기로 감싼다 (codex J1)", () => {
    // 한 줄짜리 메모라고 raw로 흘리면 그 안의 제어문자가 키 입력이 된다 —
    // 보호가 본문 길이에 따라 있다 없다 하면 안 된다.
    const one = submitBytes("한 줄 메모", "user");
    expect(one).toHaveLength(2);
    expect(one[0]).toBe(bracketedPaste("한 줄 메모"));
    expect(one[1]).toBe("\r");
    // 멀티라인도 같은 모양(정책이 길이에 의존하지 않는다).
    expect(submitBytes("a\nb", "user")).toEqual(submitPasteBytes("a\nb"));
    // 붙여넣기 종료 시퀀스를 본문에 넣어도 빠져나올 수 없다.
    expect(submitBytes("탈출\x1b[201~시도", "user")[0]).not.toContain("\x1b[201~탈출");
  });

  it("앱 시드는 단일행이면 CR 한 조각 — LF가 아니다", () => {
    // 예전 구현은 `text + "\n"`이었다. LF는 제출이 아니라 소프트 개행이라
    // 시드가 입력창에 앉아만 있고 대화가 시작되지 않았다.
    expect(submitBytes("이 파일 검토해줘")).toEqual(["이 파일 검토해줘\r"]);
    expect(submitBytes("한 줄")[0]).not.toContain("\n");
  });

  it("앱 시드 멀티라인은 붙여넣기 + CR 두 조각 — 순서대로 따로 써야 한다", () => {
    const body = "이 커밋 리뷰하자\n- a.rs\n- b.rs";
    expect(submitBytes(body)).toEqual(submitPasteBytes(body));
    const parts = submitBytes(body);
    expect(parts).toHaveLength(2);
    expect(parts[0]).not.toContain("\r"); // 붙여넣기 조각엔 CR이 없다
    expect(parts[1]).toBe("\r");
  });

  it("꼬리 개행은 떼고 판정한다 — 안 그러면 단일행이 멀티라인 버퍼가 된다", () => {
    // "한 줄\n"을 그대로 보내면 LF가 줄을 하나 더 만들고, 멀티라인 버퍼에서는
    // CR이 제출로 동작하지 않는다 = 조용한 미제출.
    expect(submitBytes("한 줄\n")).toEqual(["한 줄\r"]);
    expect(submitBytes("한 줄   \n\n")).toEqual(["한 줄\r"]);
    // 본문 **중간**의 개행은 그대로 멀티라인이다.
    expect(submitBytes("첫 줄\n둘째 줄\n")).toHaveLength(2);
  });

  it("시드 주입 지연은 실측 준비 임계(1.8s<t≤2.0s)보다 위다", () => {
    // 1800ms는 임계 바로 아래라 시드가 통째로 사라졌다(실측 재현).
    expect(SEED_READY_DELAY).toBeGreaterThan(2000);
  });
});

// ---- 회귀 방지: "채우기만" 계약은 건드리지 않았다 --------------------------

describe("[적용] 채우기 경로 무접촉 (회귀 고정)", () => {
  it("bracketedPaste는 여전히 CR을 만들지 않는다", () => {
    // 제출 경로를 고치면서 채우기 경로에 CR이 새면, 사용자가 누른 적 없는
    // 프롬프트가 원본 세션에서 실행된다.
    const filled = bracketedPaste("첫 줄\n둘째 줄\n");
    expect(filled).not.toContain("\r");
    expect(filled.endsWith("\x1b[201~")).toBe(true);
  });

  it("submitBytes와 bracketedPaste는 다른 것을 만든다", () => {
    const body = "a\nb";
    expect(bracketedPaste(body)).not.toContain("\r");
    expect(submitBytes(body).join("")).toContain("\r");
  });
});

// ---- 소비처 전수: **실제** 시드 문안이 제출 형태로 나가는가 --------------

describe("시드 소비처 4종 — 전부 제출된다 (실결함 회귀 고정)", () => {
  /** 소비처가 **실제로 부르는 생성기**를 그대로 부른다(사본 문자열이 아니라).
   * 문안이 바뀌면 — 특히 줄바꿈이 생기거나 사라지면 — 이 테스트가 깨져야 한다.
   * 사본을 검증하면 실제 문안이 멀티라인이 돼도 태연히 통과한다(codex J5). */
  const seeds: Record<string, string> = {
    "리뷰 모드 🤖 (CommitFilesSidebar)": commitReviewSeed("abc1234", [
      "- a.rs (수정)",
      "- b.rs (추가)",
    ]),
    "개발 모드 ✓확인 (DevView)": fileReviewSeed("src/a.ts"),
    "EditorPanel ✓확인": fileReviewSeed("src/b.ts"),
    "EditorPanel 🧪 테스트 생성": testGenSeed("src/c.ts", "src/c.test.ts"),
    "EditorPanel 🧪 (미러 경로 미상)": testGenSeed("src/c.ts", null),
  };

  it("모든 소비처의 마지막 조각이 CR이다 — LF로 끝나는 것은 하나도 없다", () => {
    for (const [who, text] of Object.entries(seeds)) {
      const parts = submitBytes(text);
      expect(parts[parts.length - 1], `${who}: 제출 키가 CR이어야 한다`).toBe(
        parts.length === 1 ? `${text}\r` : "\r",
      );
      expect(parts.join(""), `${who}: LF로 제출을 시도하면 안 된다`).not.toMatch(/\n$/);
    }
  });

  it("커밋 리뷰만 멀티라인(두 조각), 나머지는 단일행(한 조각)", () => {
    // 이 분류가 바뀌면 전송 방식이 바뀐다 — 문안 수정 시 여기서 걸린다.
    expect(submitBytes(seeds["리뷰 모드 🤖 (CommitFilesSidebar)"])).toHaveLength(2);
    for (const who of [
      "개발 모드 ✓확인 (DevView)",
      "EditorPanel ✓확인",
      "EditorPanel 🧪 테스트 생성",
      "EditorPanel 🧪 (미러 경로 미상)",
    ]) {
      expect(submitBytes(seeds[who]), `${who}는 단일행이어야 한다`).toHaveLength(1);
    }
  });

  it("DevView와 EditorPanel의 ✓확인은 같은 문안이다 (한 함수에서 나온다)", () => {
    expect(fileReviewSeed("같은/경로.ts")).toBe(fileReviewSeed("같은/경로.ts"));
    // 경로만 문안에 들어간다.
    expect(fileReviewSeed("src/x.ts")).toContain("`src/x.ts`");
  });

  it("단일행 시드의 본문은 손대지 않는다 (문안 불변 — 백틱·경로 포함)", () => {
    const text = fileReviewSeed("src/a.ts");
    expect(submitBytes(text)[0]).toBe(`${text}\r`);
  });

  it("멀티라인 시드의 줄 구조는 보존된다", () => {
    const [paste] = submitBytes(seeds["리뷰 모드 🤖 (CommitFilesSidebar)"]);
    expect(paste).toContain("변경 파일 2개:\n- a.rs (수정)\n- b.rs (추가)");
  });
});
