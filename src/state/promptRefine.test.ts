import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REFINE_MODEL,
  REFINE_KIND,
  bracketedPaste,
  extractPromptBlock,
  isRefineParams,
  openPromptRefine,
  refinePanelId,
  refineSeedPrompt,
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
    expect((added[0].params as { seed: string }).seed).toContain("```prompt");
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

describe("extractPromptBlock — 마지막 ```prompt 블록", () => {
  it("블록이 하나면 그 본문(펜스 제외)", () => {
    const text = "정리했어.\n\n```prompt\n로그인 버그를 고쳐라.\n재현: 1) …\n```\n\n어때?";
    expect(extractPromptBlock(text)).toBe("로그인 버그를 고쳐라.\n재현: 1) …");
  });

  it("여러 개면 **마지막** 것을 고른다 (수정 라운드마다 새 블록이 붙으므로)", () => {
    const text = [
      "1차:",
      "```prompt",
      "첫 번째",
      "```",
      "2차로 다듬었다:",
      "```prompt",
      "두 번째",
      "```",
    ].join("\n");
    expect(extractPromptBlock(text)).toBe("두 번째");
  });

  it("prompt가 아닌 펜스는 무시한다", () => {
    const text = "```ts\nconst x = 1;\n```\n```\nplain\n```";
    expect(extractPromptBlock(text)).toBeNull();
  });

  it("긴 펜스로 감싼 예시 안의 ```prompt 는 열림으로 오인하지 않는다", () => {
    const text = [
      "````markdown",
      "```prompt",
      "예시일 뿐 최종본이 아님",
      "```",
      "````",
      "",
      "진짜 최종본:",
      "```prompt",
      "진짜",
      "```",
    ].join("\n");
    expect(extractPromptBlock(text)).toBe("진짜");
  });

  it("바깥이 긴 펜스 하나뿐이면(안쪽만 prompt) 아무것도 추출하지 않는다", () => {
    const text = ["````markdown", "```prompt", "예시", "```", "````"].join("\n");
    expect(extractPromptBlock(text)).toBeNull();
  });

  it("본문 안의 코드 펜스는 더 긴 prompt 펜스로 감싸면 그대로 살아난다", () => {
    const text = ["````prompt", "다음 코드를 고쳐라:", "```ts", "const x = 1;", "```", "````"].join(
      "\n",
    );
    expect(extractPromptBlock(text)).toBe("다음 코드를 고쳐라:\n```ts\nconst x = 1;\n```");
  });

  it("블록 없음 · 빈 블록 · 빈 입력은 null (적용 버튼이 비활성으로 남는 신호)", () => {
    expect(extractPromptBlock("설명만 있고 블록이 없다")).toBeNull();
    expect(extractPromptBlock("```prompt\n\n```")).toBeNull();
    expect(extractPromptBlock("```prompt\n   \n```")).toBeNull();
    expect(extractPromptBlock("")).toBeNull();
    expect(extractPromptBlock(null)).toBeNull();
    expect(extractPromptBlock(undefined)).toBeNull();
  });

  it("아직 닫히지 않은 마지막 블록(스트리밍 중)도 보이는 만큼 준다", () => {
    expect(extractPromptBlock("```prompt\n쓰는 중인 프롬프트")).toBe("쓰는 중인 프롬프트");
  });

  it("들여쓴 펜스(목록 안)도 인식하고 본문 들여쓰기는 보존한다", () => {
    const text = "  ```prompt\n  들여쓴 본문\n    더 들여씀\n  ```";
    expect(extractPromptBlock(text)).toBe("  들여쓴 본문\n    더 들여씀");
  });

  it("info string에 꼬리말이 붙어도 prompt로 본다", () => {
    expect(extractPromptBlock("```prompt (최종)\n본문\n```")).toBe("본문");
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
  it("추출기가 읽는 펜스 이름을 시드가 명시한다", () => {
    expect(refineSeedPrompt()).toContain("```prompt");
  });

  it("한 줄이다 — 실측상 여러 줄 버퍼는 CR로 제출되지 않으므로 시드는 접혀 있어야 한다", () => {
    expect(refineSeedPrompt()).not.toContain("\n");
  });

  it("시드 자체가 추출 대상이 되지 않는다(정리 세션 첫 답변 전 [적용] 오작동 방지)", () => {
    expect(extractPromptBlock(refineSeedPrompt())).toBeNull();
  });
});
