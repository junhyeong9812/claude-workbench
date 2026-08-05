import { describe, expect, it } from "vitest";
import { openArgs, paramsAfterOpen } from "./claudeTermParams";

/** 레이아웃 저장→복원(앱 재시작)을 그대로 흉내낸다: undefined 키는 사라진다. */
const persistRoundTrip = <T>(params: T): T => JSON.parse(JSON.stringify(params));

describe("openArgs — cwd와 adopt는 서로 다른 수명이다", () => {
  it("보통 세션: project에서 띄우고 재검증 없음", () => {
    expect(openArgs({}, "/home/jun/proj")).toEqual({ cwd: "/home/jun/proj", adopt: false });
  });

  it("인수 클릭 직후: 원 cwd에서 띄우고 재검증 요청", () => {
    expect(openArgs({ spawnCwd: "/home/jun/proj", adoptPending: true }, "/home/jun/proj")).toEqual({
      cwd: "/home/jun/proj",
      adopt: true,
    });
  });

  it("spawnCwd만으로는 재검증이 켜지지 않는다 (감사 B1의 핵심)", () => {
    expect(openArgs({ spawnCwd: "/home/jun/proj" }, "/home/jun/proj").adopt).toBe(false);
  });

  it("spawnCwd가 project를 덮어쓴다 — resume은 원 디렉토리에서만 된다", () => {
    expect(openArgs({ spawnCwd: "/orig" }, "/other").cwd).toBe("/orig");
    expect(openArgs({}, null).cwd).toBeNull();
  });
});

describe("paramsAfterOpen — 1회성만 지우고 나머지는 보존", () => {
  const before = {
    kind: "claudeterm" as const,
    title: "외부 세션",
    project: "/home/jun/proj",
    spawnCwd: "/home/jun/proj",
    adoptPending: true,
    seed: "리뷰해줘",
    loadSessionId: "88b05349-b927-42aa-ad5c-57155ed29ec5",
  };
  const after = paramsAfterOpen(before, { id: 7, session_uuid: "88b05349-b927-42aa-ad5c-57155ed29ec5" });

  it("세션 식별자를 채운다", () => {
    expect(after.sessionId).toBe(7);
    expect(after.sessionUuid).toBe("88b05349-b927-42aa-ad5c-57155ed29ec5");
  });

  it("무관한 필드는 스프레드로 그대로 보존된다", () => {
    expect(after.kind).toBe("claudeterm");
    expect(after.title).toBe("외부 세션");
    expect(after.project).toBe("/home/jun/proj");
    expect(after.loadSessionId).toBe(before.loadSessionId);
  });

  it("spawnCwd는 남는다 — 재시작 후에도 원 디렉토리에서 띄워야 한다", () => {
    expect(after.spawnCwd).toBe("/home/jun/proj");
    expect(persistRoundTrip(after).spawnCwd).toBe("/home/jun/proj");
  });

  it("1회성 필드는 사라진다 (직렬화 후 키 자체가 없다)", () => {
    expect(after.adoptPending).toBeUndefined();
    expect(after.seed).toBeUndefined();
    const restored = persistRoundTrip(after);
    expect("adoptPending" in restored).toBe(false);
    expect("seed" in restored).toBe(false);
  });

  it("입력 params를 변형하지 않는다", () => {
    expect(before.adoptPending).toBe(true);
    expect(before.seed).toBe("리뷰해줘");
  });
});

describe("리마운트·앱 재시작 시나리오 (감사 B1)", () => {
  it("인수 1회 뒤에는 재검증이 다시 돌지 않는다 — 탭 전환도, 재시작도", () => {
    const project = "/home/jun/proj";
    const adopted = { project, spawnCwd: project, adoptPending: true, loadSessionId: "u1" };

    // 1) 인수 클릭 → 재검증 ON
    expect(openArgs(adopted, project).adopt).toBe(true);

    // 2) 세션이 열린 뒤 저장되는 params → 리마운트(탭 전환)에서 재검증 OFF,
    //    그러나 PTY는 여전히 원 디렉토리에서 뜬다.
    const saved = paramsAfterOpen(adopted, { id: 3, session_uuid: "u1" });
    expect(openArgs(saved, project)).toEqual({ cwd: project, adopt: false });

    // 3) 앱 재시작(레이아웃 직렬화 왕복) 후에도 마찬가지 — 같은 디렉토리에서
    //    무관한 claude가 돌아도 앱이 자기 세션을 못 여는 일이 없다.
    expect(openArgs(persistRoundTrip(saved), project)).toEqual({ cwd: project, adopt: false });
  });
});
