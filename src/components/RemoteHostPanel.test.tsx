/**
 * 원격 패널의 **무음 유실 0** 회귀 — 리뷰 loop 1 의 R1·R3·R4·R17·R18.
 *
 * 전부 "화면은 멀쩡한데 뒤에서 조용히 잘못되는" 종류라 단위 함수로는 잡히지
 * 않는다. 여기서는 진짜 패널을 마운트하고 `invoke`/`listen` 만 가짜로 바꿔,
 * **호출 횟수와 순서**로 못박는다:
 *
 * - R1  빈 성공 응답이 자동 회수를 무한 반복시키지 않는다 (`remote_timeline` = 세션당 1회)
 * - R17 같은 세션에 회수가 **병렬로** 나가지 않는다 (동시 N 클릭 → invoke 1회)
 * - R3  구독보다 **먼저** 발행된 종료 사유가 유실되지 않는다
 * - R4  호스트 목록·seed 조회 실패가 빈 화면/낡은 화면으로 축소되지 않는다
 * - R18 구독 자체가 실패해도 화면에 뜬다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

type Handler = (e: { payload: unknown }) => void;
const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
  /** 이 이름의 구독이 실패하게 만든다(R18). */
  failing: new Set<string>(),
  /** 구독이 걸린 순서 — R3 의 "먼저 구독했나"를 순서로 본다. */
  order: [] as string[],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, h: Handler) => {
    if (bus.failing.has(name)) throw new Error(`listen(${name}) 실패`);
    bus.order.push(name);
    const set = bus.handlers.get(name) ?? new Set<Handler>();
    set.add(h);
    bus.handlers.set(name, set);
    return () => set.delete(h);
  }),
  emit: vi.fn(async () => {}),
  once: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    listen: async () => () => {},
    onCloseRequested: async () => () => {},
    setTitle: async () => {},
  }),
}));

// xterm 은 이 테스트의 대상이 아니다(레이아웃·렌더러). 원격 터미널 뷰가 사유를
// 화면과 터미널 양쪽에 실제로 쓰는지만 보면 되므로 최소 가짜로 바꾼다.
const written = vi.hoisted(() => ({ text: [] as string[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write(d: unknown) {
      written.text.push(typeof d === "string" ? d : "<bytes>");
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { RemoteHostPanel } from "./RemoteHostPanel";
import { REMOTE_ID_BASE, type RemoteHostSnapshot, type RemoteSessionMeta } from "../state/remoteHosts";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;

const SID = REMOTE_ID_BASE + 1;
const LOCAL_ID = 4242;

function session(over: Partial<RemoteSessionMeta> = {}): RemoteSessionMeta {
  return {
    id: SID,
    key: "h1/abcd",
    uuid: "h1/u",
    session_id: "abcdefgh",
    agent: "claude",
    cwd: "/w",
    label: null,
    state: "exited",
    started_at_ms: 1,
    exit_code: 0,
    signal: null,
    adopted: null,
    // 아무것도 하지 않고 끝난 세션 — 데몬이 본문을 싣지 않았고(생략), 실을 것도
    // 없다. 회수는 **성공**하고 빈 본문이 온다. R1 이 사는 자리가 정확히 여기다.
    body_omitted: true,
    timeline_len: 0,
    turns: 0,
    items: 0,
    model: null,
    ctx_tokens: 0,
    last_title: null,
    last_hook: null,
    closed: true,
    ...over,
  };
}

function snapshot(sessions: RemoteSessionMeta[]): RemoteHostSnapshot {
  return {
    host_id: "h1",
    label: "원격 h1",
    incarnation: 1,
    phase: "live",
    daemon: null,
    resume: null,
    cursor: null,
    last_error: null,
    attempts: 1,
    last_frame_at_ms: Date.now(),
    running: 1,
    sessions,
    notices: [],
  };
}

const emptyReply = {
  session_id: "abcdefgh",
  total: 0,
  items: [],
  turns: [],
  answers: [],
  dates: [],
  tokens: [],
  model: null,
  last_usage: null,
};

/** 커맨드별 응답 — 테스트마다 갈아 끼운다. */
let routes: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
let container: HTMLDivElement;
let root: Root;

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
};

function emitEvent(name: string, payload: unknown) {
  for (const h of bus.handlers.get(name) ?? []) h({ payload });
}

function text(): string {
  return container.textContent ?? "";
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(label),
  ) as HTMLButtonElement | undefined;
}

function calls(cmd: string): number {
  return invoke.mock.calls.filter((c) => c[0] === cmd).length;
}

beforeEach(() => {
  bus.handlers.clear();
  bus.failing.clear();
  bus.order.length = 0;
  written.text.length = 0;
  invoke.mockReset();
  routes = {
    remote_hosts: async () => [snapshot([session()])],
    remote_timelines: async () => [],
    remote_timeline: async () => emptyReply,
    remote_attach: async () => LOCAL_ID,
    terminal_snapshot: async () => ({ data: [], last_seq: 0 }),
  };
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    const r = routes[cmd];
    return r ? r(args ?? {}) : Promise.resolve(null);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(<RemoteHostPanel />);
  });
  await flush(5);
}

/** 세션 행을 펼친다(자동 회수의 방아쇠). */
async function openRow() {
  const head = container.querySelector(".remote-session-head") as HTMLButtonElement;
  expect(head).toBeTruthy();
  await act(async () => {
    head.click();
  });
}

describe("R1 — 빈 성공 응답이 자동 회수를 무한 반복시키지 않는다", () => {
  it("회수가 성공했는데 본문이 비어도 `remote_timeline` 은 세션당 정확히 1회다", async () => {
    // 매 회차가 `Registry::call` → **새 SSH 연결 1회**다. 백오프도 지연도 없어
    // 원격 sshd 에 무제한 연결을 보낸다 — 이 패널에서 가장 즉각적인 운영 위험.
    await mount();
    await openRow();
    await flush(30);
    expect(calls("remote_timeline")).toBe(1);
  });

  it("재시도는 사용자 버튼에만 남는다 — 누르면 정확히 한 번 더 나간다", async () => {
    await mount();
    await openRow();
    await flush(30);
    expect(calls("remote_timeline")).toBe(1);
    const retry = findButton("원격에서 가져오기");
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });
    await flush(30);
    expect(calls("remote_timeline")).toBe(2);
  });
});

describe("R17 — 회수가 병렬로 나가지 않는다", () => {
  it("연속 클릭 N 회 → 실제 invoke 는 1회", async () => {
    // `setFetching` 업데이터로 거는 가드는 **상태**에만 걸리고 호출에는 안 걸렸다.
    let release: (() => void) | undefined;
    routes.remote_timeline = () =>
      new Promise((resolve) => {
        release = () => resolve(emptyReply);
      });
    await mount();
    await openRow();
    await flush(3);
    const retry = () => findButton("원격에서 가져오기");
    // 첫 자동 회수가 떠 있는 동안 버튼을 여러 번 누른다(같은 렌더 안에서 연속).
    const btn = retry();
    if (btn) {
      await act(async () => {
        btn.click();
        btn.click();
        btn.click();
      });
    }
    await flush(3);
    expect(calls("remote_timeline")).toBe(1);
    await act(async () => {
      release?.();
    });
    await flush(10);
    expect(calls("remote_timeline")).toBe(1);
  });
});

describe("R3 — 구독보다 먼저 발행된 종료 사유가 유실되지 않는다", () => {
  it("attach 가 돌아오기 **전에** 온 종료 이벤트도 화면에 뜬다", async () => {
    routes.remote_hosts = async () => [snapshot([session({ state: "running", closed: false })])];
    // 빠른 connect/auth/exec 실패: 백엔드가 attach 응답보다 먼저 사유를 낸다.
    routes.remote_attach = async () => {
      emitEvent("remote-terminal-ended", {
        id: LOCAL_ID,
        host_id: "h1",
        code: null,
        signal: null,
        detail: "cwcd: command not found",
      });
      return LOCAL_ID;
    };
    await mount();
    const btn = findButton("터미널");
    expect(btn?.disabled).toBe(false);
    await act(async () => {
      btn!.click();
    });
    await flush(20);
    expect(text()).toContain("cwcd: command not found");
  });

  it("종료 사유 구독이 attach 요청보다 먼저 걸린다", async () => {
    routes.remote_hosts = async () => [snapshot([session({ state: "running", closed: false })])];
    let subscribedAtAttach = false;
    routes.remote_attach = async () => {
      subscribedAtAttach = (bus.handlers.get("remote-terminal-ended")?.size ?? 0) > 0;
      return LOCAL_ID;
    };
    await mount();
    await act(async () => {
      findButton("터미널")!.click();
    });
    await flush(10);
    expect(subscribedAtAttach).toBe(true);
  });
});

describe("R4 — 조회 실패가 조용히 낡은 화면/빈 화면이 되지 않는다", () => {
  it("호스트 목록 조회가 실패하면 그 사실이 화면에 뜬다", async () => {
    routes.remote_hosts = async () => {
      throw new Error("데몬 연결 없음");
    };
    await mount();
    await flush(10);
    expect(text()).toContain("데몬 연결 없음");
  });

  it("seed 조회 실패는 정상 빈 배열이 아니라 재시도 가능한 실패다", async () => {
    routes.remote_timelines = async () => {
      throw new Error("seed 실패");
    };
    await mount();
    await flush(10);
    // 바로 위 주석이 스스로 적어 둔 자리 — "seed 가 없으면 영구 빈 화면이다".
    expect(text()).toContain("seed 실패");
    const retry = findButton("다시 시도");
    expect(retry).toBeTruthy();
    routes.remote_timelines = async () => [];
    await act(async () => {
      retry!.click();
    });
    await flush(10);
    expect(text()).not.toContain("seed 실패");
  });
});

describe("R18 — 구독 실패가 무음화되지 않는다", () => {
  it("`claude-timeline` 구독이 실패하면 화면에 오류가 뜬다", async () => {
    bus.failing.add("claude-timeline");
    await mount();
    await flush(10);
    expect(text()).toContain("listen(claude-timeline) 실패");
  });

  it("종료 사유 구독이 실패해도 조용하지 않다", async () => {
    bus.failing.add("remote-terminal-ended");
    await mount();
    await flush(10);
    expect(text()).toContain("listen(remote-terminal-ended) 실패");
  });
});
