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
import {
  useRemoteHosts,
  REMOTE_ID_BASE,
  type RemoteHostsView,
  type RemoteHostSnapshot,
  type RemoteSessionMeta,
} from "../state/remoteHosts";

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
  it("같은 tick 안의 N 회 호출 → 실제 invoke 는 1회 (상태가 아니라 호출에 건 가드)", async () => {
    // `setFetching` 업데이터로 거는 가드는 **상태**에만 걸리고 호출에는 안 걸렸다:
    // `invoke` 가 그 바깥의 형제 문장이라 effect·수동 버튼·연속 클릭이 겹치면
    // 같은 세션에 SSH 회수가 병렬로 나갔다. 상태는 렌더를 기다리므로, 같은 tick
    // 안의 두 번째 호출은 첫 번째의 `fetching:true` 를 아직 보지 못한다.
    let release: (() => void) | undefined;
    routes.remote_timeline = () =>
      new Promise((resolve) => {
        release = () => resolve(emptyReply);
      });
    let view: RemoteHostsView | undefined;
    function Probe() {
      view = useRemoteHosts(100_000); // 폴링은 이 테스트의 대상이 아니다
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
    await flush(3);
    await act(async () => {
      view!.fetchBody("h1", SID);
      view!.fetchBody("h1", SID);
      view!.fetchBody("h1", SID);
    });
    await flush(3);
    expect(calls("remote_timeline")).toBe(1);
    // 답이 오기 전까지는 몇 번을 더 눌러도 하나뿐이다.
    await act(async () => {
      view!.fetchBody("h1", SID);
    });
    await flush(3);
    expect(calls("remote_timeline")).toBe(1);
    // …그리고 끝난 뒤에는 다시 나갈 수 있다(영구 잠금이 아니다).
    await act(async () => {
      release?.();
    });
    await flush(5);
    await act(async () => {
      view!.fetchBody("h1", SID);
    });
    await flush(5);
    expect(calls("remote_timeline")).toBe(2);
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

// ---------------------------------------------------------------------------
// R15 — "떼기"는 카드가 아니라 **제어**에 대한 말이다
// ---------------------------------------------------------------------------

describe("R15 — 떼기 뒤 터미널이 살아 있는 것처럼 보이지 않는다", () => {
  /**
   * 한 터미널이 두 번 말할 수 있다: 백엔드의 closer 가 "떼어져 닫았습니다"를 낸
   * 뒤, 그 때문에 세션이 사라지면서 SSH 상태 릴레이가 "연결이 끊어졌습니다"를
   * 잇달아 낸다. 나중 것으로 덮으면 화면은 **원인이 아니라 결과**를 말한다 —
   * 백엔드가 한 attach 안에서 `said` 플래그로 지키는 규칙과 같은 규칙이다.
   */
  it("떼기 사유가 뒤따라온 막연한 사유에 덮이지 않는다", async () => {
    routes.remote_hosts = async () => [snapshot([session({ state: "running", closed: false })])];
    await mount();
    await act(async () => {
      findButton("터미널")!.click();
    });
    await flush(10);

    await act(async () => {
      emitEvent("remote-terminal-ended", {
        id: LOCAL_ID,
        host_id: "h1",
        code: null,
        signal: null,
        detail: "이 호스트에서 떼어져 터미널을 닫았습니다 — 원격 세션은 계속 돕니다.",
      });
      // …그리고 그 결과로 SSH 채널이 죽으면서 나오는, 덜 정확한 두 번째 사유.
      emitEvent("remote-terminal-ended", {
        id: LOCAL_ID,
        host_id: "h1",
        code: null,
        signal: null,
        detail: "원격 호스트와의 연결이 끊어졌습니다.",
      });
    });
    await flush(10);
    expect(text()).toContain("떼어져 터미널을 닫았습니다");
    expect(text()).not.toContain("연결이 끊어졌습니다");
  });
});

// ---------------------------------------------------------------------------
// R2 — 원격 호스트의 데이터(트리·git·워크트리). 규칙 하나: **잘림은 말한다**
// ---------------------------------------------------------------------------

/** 데이터 패널을 펼치고 프로젝트 하나를 고른다. */
async function openData(root = "/home/jun/p") {
  await act(async () => {
    findButton("데이터")!.click();
  });
  await flush(10);
  const select = container.querySelector('select[aria-label="원격 프로젝트"]') as HTMLSelectElement;
  expect(select).toBeTruthy();
  await act(async () => {
    select.value = root;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(10);
}

const PROJECTS = {
  projects: [{ path: "/home/jun/p", name: "p", branch: "main", source: "workbench", project_types: [] }],
  scanned: [],
  notes: [],
};

function tabButton(label: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button.remote-data-tab")).find(
    (x) => (x.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
  expect(b).toBeTruthy();
  return b!;
}

describe("R2 — 원격 트리가 페이지를 폴더 전체인 척 보여주지 않는다", () => {
  beforeEach(() => {
    routes.remote_projects = async () => PROJECTS;
  });

  it("잘린 폴더는 '몇 개 중 몇 개'를 화면에 적고, 더 보기로 이어 받는다", async () => {
    routes.remote_tree = async (a) =>
      (a.from as number) === 0
        ? {
            root: "/home/jun/p",
            path: "/home/jun/p",
            entries: [{ name: "aaa", path: "/home/jun/p/aaa", is_dir: false, project_types: [], is_ignored: false }],
            from_index: 0,
            total: 4000,
            truncated: true,
          }
        : {
            root: "/home/jun/p",
            path: "/home/jun/p",
            entries: [{ name: "bbb", path: "/home/jun/p/bbb", is_dir: false, project_types: [], is_ignored: false }],
            from_index: 1,
            total: 4000,
            truncated: true,
          };
    await mount();
    await openData();
    expect(text()).toContain("aaa");
    // 이 한 줄이 없으면 200개짜리 화면이 4,000개짜리 폴더처럼 보인다.
    expect(text()).toContain("4000개 중 1개");

    await act(async () => {
      findButton("더 보기")!.click();
    });
    await flush(10);
    expect(text()).toContain("bbb");
    expect(text()).toContain("4000개 중 2개");
  });

  it("이어지지 않는 페이지는 조용히 붙지 않고 사유가 뜬다", async () => {
    routes.remote_tree = async (a) =>
      (a.from as number) === 0
        ? {
            root: "/home/jun/p",
            path: "/home/jun/p",
            entries: [{ name: "aaa", path: "/home/jun/p/aaa", is_dir: false, project_types: [], is_ignored: false }],
            from_index: 0,
            total: 10,
            truncated: true,
          }
        : {
            // 데몬이 3번째부터 돌려줬다 — 1·2번째가 빠졌다.
            root: "/home/jun/p",
            path: "/home/jun/p",
            entries: [{ name: "ddd", path: "/home/jun/p/ddd", is_dir: false, project_types: [], is_ignored: false }],
            from_index: 3,
            total: 10,
            truncated: true,
          };
    await mount();
    await openData();
    await act(async () => {
      findButton("더 보기")!.click();
    });
    await flush(10);
    expect(text()).toContain("이어지지 않습니다");
    expect(text()).not.toContain("ddd");
  });

  it("조회 실패는 빈 트리가 아니라 재시도 가능한 실패다", async () => {
    routes.remote_tree = async () => {
      throw new Error("no such project root");
    };
    await mount();
    await openData();
    expect(text()).toContain("no such project root");
    expect(findButton("다시 시도")).toBeTruthy();
  });

  /** 64MB 상한에 걸린 응답은 "JSON 이 아니다"가 아니라 잘렸다고 말해야 한다. */
  it("응답이 상한에 걸려 잘리면 그 사실이 그대로 화면에 온다", async () => {
    routes.remote_tree = async () => {
      throw new Error("원격 응답이 너무 커서(64MB 상한) 앞부분이 잘렸습니다 — 잘린 조각을 읽으려 하지 않았습니다.");
    };
    await mount();
    await openData();
    expect(text()).toContain("64MB 상한");
    expect(text()).not.toContain("JSON");
  });
});

describe("R2 — 자동 조회는 갈래당 한 번이다 (R1 이 남긴 규칙)", () => {
  /**
   * 판정의 축이 *내용*이면 **성공했는데 빈 응답**이 오는 순간 다시 true 가 되어
   * effect 가 무한히 재발화한다. 한 바퀴가 `Registry::call` → 새 SSH 연결 1회라
   * 백오프도 지연도 없다. R1 이 세션 타임라인에서 실측한 그 사고이고, 이 화면을
   * 만들면서 **그대로 재현됐다**(빈 응답을 주는 폴더 하나로). 축을 시도로 옮긴
   * 것을 여기서 못박는다.
   */
  it("빈 폴더가 와도 `remote_tree` 는 갈래당 정확히 1회다", async () => {
    routes.remote_projects = async () => PROJECTS;
    routes.remote_tree = async () => ({
      root: "/home/jun/p",
      path: "/home/jun/p",
      entries: [],
      from_index: 0,
      total: 0,
      truncated: false,
    });
    await mount();
    await openData();
    await flush(30);
    expect(calls("remote_tree")).toBe(1);
    expect(text()).toContain("빈 폴더입니다");
  });

  /**
   * **판정이 시도가 아니라 내용이면 여기서 무너진다.**
   *
   * 화면에 채울 것이 하나도 남지 않는 응답 — 이 워크벤치를 만드는 동안 실제로
   * 밟은 상태다 — 이 오면 "값이 비었으니 다시 읽는다"가 영원히 참이 되고, 그
   * 한 바퀴가 `Registry::call` → 새 SSH 연결 1회다(백오프도 지연도 없다).
   * 화면은 멀쩡해 보이는 채로 원격 sshd 에 무제한 연결을 보낸다.
   */
  it("화면에 채울 것이 없는 응답도 재조회 루프가 되지 않는다", async () => {
    routes.remote_projects = async () => PROJECTS;
    routes.remote_tree = async () => null;
    await mount();
    await openData();
    await flush(30);
    expect(calls("remote_tree")).toBe(1);
  });

  it("실패해도 무한 재시도하지 않는다 — 재시도는 버튼에만 남는다", async () => {
    routes.remote_projects = async () => PROJECTS;
    routes.remote_git_status = async () => {
      throw new Error("git 이 없습니다");
    };
    routes.remote_git_log = async () => {
      throw new Error("git 이 없습니다");
    };
    await mount();
    await openData();
    await act(async () => {
      tabButton("Git").click();
    });
    await flush(30);
    expect(calls("remote_git_status")).toBe(1);
    expect(text()).toContain("git 이 없습니다");
  });
});

describe("R2 — 원격 git 이 한 페이지를 전체 히스토리로 보이지 않는다", () => {
  beforeEach(() => {
    routes.remote_projects = async () => PROJECTS;
    routes.remote_git_status = async () => ({
      is_repo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      has_remote: true,
      merging: false,
      reverting: false,
      changes: [{ path: "core/src/remote.rs", code: "M", staged: false, conflicted: false }],
    });
  });

  const commit = (short: string) => ({
    hash: `${short}0000`,
    short,
    parents: [],
    author: "jun",
    date: "2026-08-13",
    refs: "",
    subject: `subject ${short}`,
  });

  it("이어받을 주소가 있는 잘림에는 '더 보기'가 붙고 실제로 이어진다", async () => {
    routes.remote_git_log = async (a) =>
      a.cursor
        ? { root: "/home/jun/p", commits: [commit("e56cc06")], truncated: false, next_cursor: null }
        : { root: "/home/jun/p", commits: [commit("4dc8e5a")], truncated: true, next_cursor: "c1" };
    await mount();
    await openData();
    await act(async () => {
      tabButton("Git").click();
    });
    await flush(10);
    expect(text()).toContain("main");
    expect(text()).toContain("core/src/remote.rs");
    expect(text()).toContain("subject 4dc8e5a");
    expect(text()).toContain("히스토리가 더 있습니다");

    await act(async () => {
      findButton("더 보기")!.click();
    });
    await flush(10);
    expect(text()).toContain("subject e56cc06");
    expect(text()).not.toContain("히스토리가 더 있습니다");
  });

  it("주소 없는 잘림은 누를 것이 없다는 사실까지 말한다", async () => {
    routes.remote_git_log = async () => ({
      root: "/home/jun/p",
      commits: [commit("4dc8e5a")],
      truncated: true,
      next_cursor: null,
    });
    await mount();
    await openData();
    await act(async () => {
      tabButton("Git").click();
    });
    await flush(10);
    expect(text()).toContain("이어받을 주소가 없습니다");
    expect(findButton("더 보기")).toBeFalsy();
  });
});

describe("R2 — 워크트리·하위 저장소의 잘림", () => {
  beforeEach(() => {
    routes.remote_projects = async () => PROJECTS;
    routes.remote_worktrees = async () => ({
      root: "/home/jun/p",
      worktrees: [{ path: "/home/jun/p", head: "4dc8e5a0", branch: "main", is_main: true }],
    });
  });

  it("상한에 걸린 스캔은 이어받을 방법이 없다는 것까지 말한다", async () => {
    routes.remote_git_roots = async () => ({
      root: "/home/jun/p",
      roots: [{ path: "/home/jun/p", branch: "main" }],
      at_cap: true,
    });
    await mount();
    await openData();
    await act(async () => {
      tabButton("워크트리").click();
    });
    await flush(10);
    expect(text()).toContain("main");
    expect(text()).toContain("상한에 걸려 멈췄습니다");
    expect(text()).toContain("이어받을 주소가 없습니다");
  });

  /**
   * `at_cap:false` 는 "완전함"이 아니다 — 같은 스캐너가 2만 디렉터리에서 **표시
   * 없이** 포기한다. 이 프로젝트에 등재된 무음 유실이라 화면이 늘 말한다.
   */
  it("응답으로 알 수 없는 절단은 상시 단서로 화면에 남는다", async () => {
    routes.remote_git_roots = async () => ({
      root: "/home/jun/p",
      roots: [{ path: "/home/jun/p", branch: "main" }],
      at_cap: false,
    });
    await mount();
    await openData();
    await act(async () => {
      tabButton("워크트리").click();
    });
    await flush(10);
    expect(text()).toContain("2만");
    expect(text()).toContain("부분일 수 있습니다");
  });
});

describe("R2 — 프로젝트 목록: 빈 목록과 못 읽은 설정은 다른 화면이다", () => {
  it("호스트가 붙인 메모가 그대로 보인다", async () => {
    routes.remote_projects = async () => ({
      projects: [],
      scanned: [],
      notes: ["CWC_PROJECT_ROOTS 항목 /nope 이 없습니다"],
    });
    await mount();
    await act(async () => {
      findButton("데이터")!.click();
    });
    await flush(10);
    expect(text()).toContain("/nope");
  });

  it("목록 조회 실패는 '프로젝트 없음'이 아니다", async () => {
    routes.remote_projects = async () => {
      throw new Error("데몬이 응답하지 않습니다");
    };
    await mount();
    await act(async () => {
      findButton("데이터")!.click();
    });
    await flush(10);
    expect(text()).toContain("데몬이 응답하지 않습니다");
    expect(findButton("다시 시도")).toBeTruthy();
  });
});
