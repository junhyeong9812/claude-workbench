/**
 * 원격 호스트 데이터(R2)의 **무음 유실 0** 규칙.
 *
 * 여기 있는 것은 전부 한 가지 질문이다: *더 있는데 안 보여줄 때, 화면이 그것을
 * 말하는가.* 트리는 `from/limit` 로, 히스토리는 `cursor` 로 페이징되고, git-roots
 * 는 이어받을 주소조차 없는 상한을 갖는다 — 셋 다 아무 말 없이 "이게 전부"처럼
 * 보일 수 있는 모양이다. 이 프로젝트에 등재된 무음 유실(로컬 `git_roots` 의 조용한
 * 절단)을 원격에서 재생산하지 않는다는 계약을 여기에 못박는다.
 */
import { describe, expect, it } from "vitest";
import {
  appendDirPage,
  appendLogPage,
  dirCutNote,
  dirHasMore,
  logCutNote,
  logHasMore,
  parentPath,
  relPath,
  rootsCutNote,
  staleNote,
  GIT_ROOTS_CAVEAT,
  type RemoteDir,
  type RemoteDirEntry,
  type RemoteGitLog,
  type RemoteGitRoots,
} from "./remoteHostData";
import { shouldAutoFetch, type Fetched } from "./autoFetch";

function entry(name: string, over: Partial<RemoteDirEntry> = {}): RemoteDirEntry {
  return {
    name,
    path: `/r/${name}`,
    is_dir: false,
    project_types: [],
    is_ignored: false,
    ...over,
  };
}

function dir(over: Partial<RemoteDir> = {}): RemoteDir {
  return {
    root: "/r",
    path: "/r",
    entries: [entry("a"), entry("b")],
    from_index: 0,
    total: 2,
    truncated: false,
    ...over,
  };
}

function logPage(over: Partial<RemoteGitLog> = {}): RemoteGitLog {
  return {
    root: "/r",
    commits: [
      {
        hash: "4dc8e5a",
        short: "4dc8e5a",
        parents: [],
        author: "jun",
        date: "2026-08-13",
        refs: "",
        subject: "fix(remote)",
      },
    ],
    truncated: false,
    next_cursor: null,
    ...over,
  };
}

describe("트리 — 페이지가 폴더 전체인 척하지 않는다", () => {
  it("다 보이면 아무 말도 하지 않는다", () => {
    expect(dirHasMore(dir())).toBe(false);
    expect(dirCutNote(dir())).toBeNull();
  });

  it("잘렸으면 몇 개 중 몇 개인지 말한다", () => {
    const d = dir({ entries: [entry("a")], total: 4000, truncated: true });
    expect(dirHasMore(d)).toBe(true);
    expect(dirCutNote(d)).toContain("4000");
    expect(dirCutNote(d)).toContain("1");
  });

  /**
   * **잘림 신호가 하나뿐이면 그 하나가 사라지는 순간 화면이 조용해진다.**
   *
   * 생산자가 `truncated` 를 빠뜨려도 `from_index + 보인 개수 < total` 이 같은
   * 사실을 말한다. 플래그 하나에만 기대지 않는다는 것이 이 테스트의 전부다.
   */
  it("`truncated` 가 빠져도 개수만으로 잘림을 알아챈다", () => {
    const d = dir({ entries: [entry("a")], total: 900, truncated: false });
    expect(dirHasMore(d)).toBe(true);
    expect(dirCutNote(d)).toContain("900");
  });

  /**
   * **없는 잘림을 지어내지 않는다** (L2-11).
   *
   * 마지막 페이지에 `truncated:true` 가 실려 오면(생산자가 "상한만큼 읽었다"를
   * 그대로 말하는 흔한 모양) 개수는 이미 다 왔다고 말하는데 화면은 "더 있다"를
   * 지어낸다. 그리고 「더 보기」는 `from == total` 로 조회한다 — 사용자는 누를
   * 것이 있는데 아무것도 오지 않는 화면을 본다. 개수가 정본이고, 플래그는 개수를
   * 믿을 수 없을 때의 백스톱이다.
   */
  it("마지막 페이지의 `truncated` 로 없는 잘림을 지어내지 않는다", () => {
    const d = dir({ entries: [entry("a"), entry("b")], from_index: 0, total: 2, truncated: true });
    expect(dirHasMore(d)).toBe(false);
    expect(dirCutNote(d)).toBeNull();
  });

  it("이어 붙인 마지막 페이지에서도 마찬가지다", () => {
    const first = dir({ entries: [entry("a")], from_index: 0, total: 2, truncated: true });
    const last = dir({ entries: [entry("b")], from_index: 1, total: 2, truncated: true });
    const m = appendDirPage(first, last);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(dirHasMore(m.value)).toBe(false);
    expect(dirCutNote(m.value)).toBeNull();
  });

  /** 개수를 믿을 수 없을 때(본 것이 `total` 보다 많다)는 플래그가 백스톱이다. */
  it("total 이 개수와 모순이면 truncated 를 백스톱으로 쓴다", () => {
    const d = dir({ entries: [entry("a"), entry("b")], from_index: 0, total: 0, truncated: true });
    expect(dirHasMore(d)).toBe(true);
    const quiet = dir({ entries: [entry("a")], from_index: 0, total: 0, truncated: false });
    expect(dirHasMore(quiet)).toBe(false);
  });

  it("두 번째 페이지 뒤에도 남은 것이 있으면 계속 말한다", () => {
    const first = dir({ entries: [entry("a")], from_index: 0, total: 3, truncated: true });
    const second = dir({ entries: [entry("b")], from_index: 1, total: 3, truncated: true });
    const m = appendDirPage(first, second);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(dirCutNote(m.value)).toContain("3개 중 2개");
  });
});

describe("트리 — 구멍은 조용히 이어 붙이지 않는다", () => {
  it("이어지지 않는 페이지는 거절하고 사유를 돌려준다", () => {
    const first = dir({ entries: [entry("a")], from_index: 0, total: 10, truncated: true });
    // 3번째부터가 왔다 — 1·2번째가 빠졌다. 그대로 붙이면 화면은 빠진 줄 모른다.
    const skipped = dir({ entries: [entry("d")], from_index: 3, total: 10, truncated: true });
    const m = appendDirPage(first, skipped);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.error).toContain("1번째");
    expect(m.error).toContain("3번째");
  });

  it("첫 페이지가 0번째가 아니면 앞부분을 버리지 않고 거절한다", () => {
    const m = appendDirPage(null, dir({ from_index: 5 }));
    expect(m.ok).toBe(false);
  });

  it("다른 폴더의 페이지는 이어 붙이지 않고 새로 시작한다", () => {
    const first = dir({ path: "/r/one", entries: [entry("a")], total: 1 });
    const other = dir({ path: "/r/two", entries: [entry("z")], from_index: 0, total: 1 });
    const m = appendDirPage(first, other);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.entries.map((e) => e.name)).toEqual(["z"]);
  });
});

describe("히스토리 — 이어받을 주소가 있는 잘림과 없는 잘림은 다른 답이다", () => {
  it("끝이면 아무 말도 하지 않는다", () => {
    expect(logCutNote(logPage())).toBeNull();
    expect(logHasMore(logPage())).toBe(false);
  });

  it("주소가 있으면 더 받을 수 있다고 말한다", () => {
    const p = logPage({ truncated: true, next_cursor: "c1" });
    expect(logHasMore(p)).toBe(true);
    expect(logCutNote(p)).toContain("더 있습니다");
  });

  /** 데몬의 5만 커밋 페이징 상한 — 잘렸는데 누를 것이 없다. 그것을 말해야 한다. */
  it("주소가 없는 잘림은 '더 보기'가 아니라 사실로 말한다", () => {
    const p = logPage({ truncated: true, next_cursor: null });
    expect(logHasMore(p)).toBe(false);
    const note = logCutNote(p);
    expect(note).toContain("이어받을 주소가 없습니다");
    expect(note).toContain("git");
  });

  it("페이지는 그대로 이어 붙는다 — 정렬도 중복 제거도 하지 않는다", () => {
    const a = logPage({ truncated: true, next_cursor: "c1" });
    const b = logPage({
      commits: [{ ...logPage().commits[0], hash: "e56cc06", short: "e56cc06" }],
    });
    const m = appendLogPage(a, b);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.commits.map((c) => c.short)).toEqual(["4dc8e5a", "e56cc06"]);
    expect(m.value.truncated).toBe(false);
  });
});

describe("git-roots — 이어받을 주소가 없는 상한, 그리고 말할 수 없는 상한", () => {
  const roots = (over: Partial<RemoteGitRoots> = {}): RemoteGitRoots => ({
    root: "/r",
    roots: [{ path: "/r", branch: "main" }],
    at_cap: false,
    ...over,
  });

  it("상한에 걸리면 이어받을 방법이 없다는 것까지 말한다", () => {
    const note = rootsCutNote(roots({ at_cap: true }));
    expect(note).toContain("이어받을 주소가 없습니다");
    expect(note).toContain("좁은");
  });

  it("상한이 아니면 조용하다", () => {
    expect(rootsCutNote(roots())).toBeNull();
  });

  /**
   * `at_cap:false` 를 "완전함"으로 읽으면 안 된다 — 같은 스캐너가 2만 디렉터리에서
   * **표시 없이** 포기한다. 응답으로는 알 수 없는 잘림이라 화면이 늘 말한다.
   */
  it("응답으로 알 수 없는 무음 절단은 상시 단서로 남는다", () => {
    expect(GIT_ROOTS_CAVEAT).toContain("2만");
    expect(GIT_ROOTS_CAVEAT).toContain("부분");
  });
});

describe("경로 — '위로' 가 루트 밖으로 나가지 않는다", () => {
  it("루트에서는 더 올라갈 곳이 없다", () => {
    expect(parentPath("/home/jun/p", "")).toBeNull();
    expect(parentPath("/home/jun/p", "/home/jun/p")).toBeNull();
  });

  it("한 단계 위는 루트에서 멈춘다", () => {
    expect(parentPath("/home/jun/p", "/home/jun/p/a/b")).toBe("/home/jun/p/a");
    expect(parentPath("/home/jun/p", "/home/jun/p/a")).toBe("");
  });

  it("루트 밖 경로로는 올라가지 않는다 — 데몬이 거절할 조회를 만들지 않는다", () => {
    expect(parentPath("/home/jun/p", "/home/jun/other/x")).toBeNull();
  });

  it("표시 경로는 루트 기준이다", () => {
    expect(relPath("/home/jun/p", "/home/jun/p")).toBe("");
    expect(relPath("/home/jun/p", "/home/jun/p/core/src")).toBe("core/src");
  });
});

describe("자동 조회의 축은 내용이 아니라 시도다 (R1)", () => {
  const slot = (over: Partial<Fetched<number>> = {}): Fetched<number> => ({
    value: null,
    sig: null,
    error: null,
    loading: false,
    attempted: false,
    at: null,
    ...over,
  });

  it("아직 시도한 적 없으면 한 번 읽는다", () => {
    expect(shouldAutoFetch(slot())).toBe(true);
  });

  /**
   * **여기가 R1 이 사는 자리다.** 조회는 성공했는데 화면에 채울 것이 없다 —
   * 빈 폴더, 읽을 수 없는 모양. `!value` 로 판정하면 이 상태가 영원히 "다시
   * 읽어라"가 되고, 한 바퀴마다 새 SSH 연결이 나간다.
   */
  it("성공했는데 채울 것이 없어도 다시 읽지 않는다", () => {
    expect(shouldAutoFetch(slot({ attempted: true, at: 1 }))).toBe(false);
  });

  it("실패해도 자동으로 되풀이하지 않는다 — 재시도는 버튼의 몫이다", () => {
    expect(shouldAutoFetch(slot({ attempted: true, error: "읽지 못했습니다" }))).toBe(false);
  });

  it("나가 있는 조회를 두 번 보내지 않는다", () => {
    expect(shouldAutoFetch(slot({ attempted: true, loading: true }))).toBe(false);
  });
});

describe("낡은 화면 — 오류가 떴는데 값이 남아 있으면 그 값은 과거다", () => {
  it("언제 것인지 말한다", () => {
    const now = 1_000_000;
    expect(
      staleNote({ value: 1, sig: null, error: "읽지 못했습니다", loading: false, attempted: true, at: now - 5000 }, now),
    ).toContain("5초 전");
    expect(
      staleNote({ value: 1, sig: null, error: "읽지 못했습니다", loading: false, attempted: true, at: now - 180_000 }, now),
    ).toContain("3분 전");
  });

  it("오류가 없거나 값이 없으면 할 말이 없다", () => {
    expect(staleNote({ value: 1, sig: null, error: null, loading: false, attempted: true, at: 1 })).toBeNull();
    expect(staleNote({ value: null, sig: null, error: "x", loading: false, attempted: true, at: null })).toBeNull();
  });
});
