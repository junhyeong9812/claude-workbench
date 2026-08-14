/**
 * 자동 회수 원시의 **계약** — 세 번 재발한 결함 클래스가 사는 자리.
 *
 * 여기 있는 단언은 화면이 아니라 원시 자신에 건다: 잠금은 *시도*이고, 잠금 키에는
 * **가변 값이 없으며**, in-flight 가드는 조용히 삼키지 않고, 버린 칸은 되살아나지
 * 않는다. 이 넷 중 하나라도 되돌리면 그 한 바퀴가 **새 SSH 연결 1회**가 된다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { idleFetch, isStale, shouldAutoFetch, useAutoFetch, type AutoFetch } from "./autoFetch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 훅 하나를 띄우고 그 API 를 돌려준다. */
async function mountStore<T>(): Promise<() => AutoFetch<T>> {
  let api: AutoFetch<T> | undefined;
  let renders = 0;
  function Probe() {
    api = useAutoFetch<T>();
    renders += 1;
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe));
  });
  expect(renders).toBeGreaterThan(0);
  return () => api!;
}

describe("잠금 — 축은 내용이 아니라 **시도**다", () => {
  it("빈 성공 응답이 와도 자동 회수는 다시 열리지 않는다", async () => {
    const store = await mountStore<number[]>();
    let calls = 0;
    const req = () => ({
      key: "h1 s1",
      call: async () => {
        calls += 1;
        return [] as number[];
      },
    });
    await act(async () => store().run(req()));
    await flush();
    const e = store().get("h1 s1");
    expect(calls).toBe(1);
    expect(e.attempted).toBe(true);
    expect(e.value).toEqual([]);
    // 화면에 채울 것이 하나도 없는 응답 — 여기서 판정이 true 로 돌아오면 그
    // 한 바퀴가 새 SSH 연결 1회다(백오프도 지연도 없다).
    expect(shouldAutoFetch(e)).toBe(false);
  });

  it("실패해도 자동으로 다시 걸지 않는다 — 값은 남고 사유가 얹힌다", async () => {
    const store = await mountStore<number>();
    await act(async () =>
      store().run({ key: "k", call: async () => 7 }),
    );
    await flush();
    await act(async () =>
      store().run({
        key: "k",
        call: async () => {
          throw new Error("ssh: connection refused");
        },
      }),
    );
    await flush();
    const e = store().get("k");
    expect(e.value, "실패가 값을 빈 것으로 축소했다").toBe(7);
    expect(e.error).toContain("connection refused");
    expect(shouldAutoFetch(e)).toBe(false);
  });
});

describe("in-flight — 합치되 **삼키지는 않는다**", () => {
  it("같은 주소·같은 인자의 동시 호출은 한 번만 나간다 (R17)", async () => {
    const store = await mountStore<number>();
    let calls = 0;
    let release: ((v: number) => void) | undefined;
    const call = () => {
      calls += 1;
      return new Promise<number>((r) => {
        release = r;
      });
    };
    await act(async () => {
      store().run({ key: "k", call });
      store().run({ key: "k", call });
      store().run({ key: "k", call });
    });
    await flush(3);
    expect(calls).toBe(1);
    // 답이 온 뒤에는 다시 나갈 수 있다(영구 잠금이 아니다 — 버튼의 재시도).
    await act(async () => release!(1));
    await flush();
    await act(async () => store().run({ key: "k", call }));
    await flush(2);
    expect(calls).toBe(2);
  });

  /**
   * **인자가 다르면 조용히 삼키지 않는다.**
   *
   * 앞 판은 조기 반환이라 두 번째 요청이 상태를 아무것도 바꾸지 않은 채 사라졌고
   * (`attempted` 는 이미 true 라 자동 재조회도 없다), 늦게 온 첫 응답이 두 번째
   * 라벨 아래 그려졌다(L2-3).
   */
  it("다른 인자의 요청은 세대를 올려 교체하고, 늦게 온 옛 답은 버린다", async () => {
    const store = await mountStore<string>();
    const gate: { args: string; resolve: (v: string) => void }[] = [];
    const call = (args: string) => () =>
      new Promise<string>((resolve) => gate.push({ args, resolve }));
    await act(async () => store().run({ key: "k", args: "A", call: call("A") }));
    await act(async () => store().run({ key: "k", args: "B", call: call("B") }));
    expect(gate.map((g) => g.args), "두 번째 요청이 삼켜졌다").toEqual(["A", "B"]);

    await act(async () => gate[1].resolve("B값"));
    await flush();
    expect(store().get("k").value).toBe("B값");
    // 늦게 온 A 는 정본이 아니다.
    await act(async () => gate[0].resolve("A값"));
    await flush();
    expect(store().get("k").value, "늦게 온 옛 답이 새 답을 덮었다").toBe("B값");
  });
});

describe("캐시 — 정체성당 **한 벌**", () => {
  it("새 서명으로 받으면 옛 벌을 교체한다(쌓이지 않는다)", async () => {
    const store = await mountStore<string>();
    for (const sig of ["1-1", "2-2", "3-3"]) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () =>
        store().run({ key: "agent", sig, call: async () => `본문 ${sig}` }),
      );
      // eslint-disable-next-line no-await-in-loop
      await flush(3);
    }
    expect(store().entries.size, "서명마다 새 칸이 생겼다").toBe(1);
    expect(store().get("agent").value).toBe("본문 3-3");
    expect(store().get("agent").sig).toBe("3-3");
  });

  it("서명은 신선도 표시일 뿐 — 낡아도 자동 회수는 열리지 않는다", async () => {
    const store = await mountStore<string>();
    await act(async () => store().run({ key: "agent", sig: "1-1", call: async () => "본문" }));
    await flush();
    const e = store().get("agent");
    expect(isStale(e, "9-9"), "바뀐 것을 말하지 못한다").toBe(true);
    expect(shouldAutoFetch(e), "낡음이 자동 회수를 다시 열었다").toBe(false);
  });
});

describe("버린 칸 — 늦은 답이 되살리지 못한다", () => {
  it("`forget` 뒤에 도착한 응답은 자리를 다시 차지하지 않는다 (L2-9)", async () => {
    const store = await mountStore<string>();
    let release: ((v: string) => void) | undefined;
    await act(async () =>
      store().run({
        key: "gone",
        call: () =>
          new Promise<string>((r) => {
            release = r;
          }),
      }),
    );
    await flush(2);
    await act(async () => store().forget(["gone"]));
    expect(store().entries.size).toBe(0);
    await act(async () => release!("커다란 전사"));
    await flush();
    expect(store().entries.size, "버린 칸이 늦은 답으로 되살아났다").toBe(0);
    // …그리고 그 주소는 다시 조회할 수 있다(in-flight 표시가 남아 잠기지 않는다).
    let again = 0;
    await act(async () =>
      store().run({
        key: "gone",
        call: async () => {
          again += 1;
          return "다시";
        },
      }),
    );
    await flush();
    expect(again, "버린 주소가 영영 잠겼다").toBe(1);
  });

  it("`retain` 은 남길 것만 남긴다", async () => {
    const store = await mountStore<string>();
    await act(async () => {
      store().run({ key: "a", call: async () => "A" });
      store().run({ key: "b", call: async () => "B" });
    });
    await flush();
    expect(store().entries.size).toBe(2);
    await act(async () => store().retain((k) => k === "b"));
    expect([...store().entries.keys()]).toEqual(["b"]);
  });
});

describe("순수 판정", () => {
  it("빈 칸은 한 번 열려 있고, 시도한 칸은 닫혀 있다", () => {
    expect(shouldAutoFetch(idleFetch())).toBe(true);
    expect(shouldAutoFetch({ ...idleFetch(), attempted: true })).toBe(false);
  });

  it("들고 있는 게 없으면 낡음도 없고, 무효화 수단이 없으면 신선하다고 하지 않는다", () => {
    expect(isStale(idleFetch(), "1-1")).toBe(false);
    const held = { ...idleFetch<number>(), value: 1, sig: "1-1" };
    expect(isStale(held, "1-1")).toBe(false);
    expect(isStale(held, "2-2")).toBe(true);
    expect(isStale({ ...held, sig: null }, "1-1")).toBe(true);
    expect(isStale(held, null)).toBe(true);
  });
});
