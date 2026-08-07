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
import { describe, expect, it } from "vitest";
import { components } from "./panelRegistry";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudeTermPanel } from "./ClaudeTermPanel";

describe("codexterm은 순수 터미널 패널이다", () => {
  it("레지스트리가 codexterm을 TerminalPanel로 푼다 (ClaudeTermPanel 아님)", () => {
    expect(components.codexterm).toBe(TerminalPanel);
    expect(components.codexterm).not.toBe(ClaudeTermPanel);
    // 대조군 — claudeterm은 그대로 claude 패널이어야 한다(회귀 0).
    expect(components.claudeterm).toBe(ClaudeTermPanel);
  });

  it("일반 터미널·SSH와 같은 컴포넌트를 공유한다 (SSH 선례)", () => {
    expect(components.codexterm).toBe(components.terminal);
    expect(components.codexterm).toBe(components.ssh);
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
