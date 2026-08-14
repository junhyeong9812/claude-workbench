/**
 * 원격 호스트의 **데이터**(R2) — 프로젝트·파일트리·git·워크트리를 읽는 규칙.
 *
 * R2a 는 다른 PC 의 *세션* 을 보이게 했다. 그 호스트를 "데이터가 나오는 곳"으로
 * 만드는 것은 세션 둘레의 나머지 전부이고, 데몬(R1b)은 이미 그것을 전부
 * 발행한다. 여기 있는 것은 그 응답의 타입과, 화면이 쓰는 **순수 규칙**이다.
 *
 * 로컬 트리·Git·워크트리 컴포넌트는 **건드리지 않는다**(명세 ④). 같은 정보를
 * 보이되 뷰 모델을 따로 둔다 — 로컬 정본에 원격 차원을 끼워 넣는 회귀 위험이
 * 얻는 것보다 크다. 최상위 호스트 탭·평행 store 는 여전히 R3 의 몫이라 이
 * 모듈은 **원격 패널 안**에서만 산다.
 *
 * ## 이 파일의 존재 이유 한 줄: **잘림은 화면이 말한다**
 *
 * 트리는 `from/limit` 로, 히스토리는 `cursor` 로 페이징된다. 페이지를 그냥
 * 그리면 200개짜리 화면이 4,000개짜리 폴더처럼 보이고, 첫 장짜리 히스토리가
 * 전체 히스토리처럼 보인다. 이 프로젝트에는 **등재된 무음 유실**이 하나 있다 —
 * 로컬 `git_roots` 는 스캐너가 포기해도 완전해 보이는 목록을 돌려준다. 그것을
 * 원격에서 재생산하지 않는 것이 이 모듈의 계약이고, 그래서 잘림 판정은
 * 플래그 **하나에만** 의존하지 않는다(개수로도 따로 센다).
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAutoFetch, type Fetched, type Merge } from "./autoFetch";

export type { Fetched, Merge } from "./autoFetch";

// ---------------------------------------------------------------------------
// 응답 타입 — 백엔드 `core::remote::proto` 의 것과 같은 모양
// ---------------------------------------------------------------------------

export interface RemoteProjectEntry {
  path: string;
  name: string;
  branch: string | null;
  /** `explicit` | `workbench` | `scan` — 데몬이 보낸 문자열 그대로. */
  source: string;
  project_types: string[];
}

export interface RemoteProjects {
  projects: RemoteProjectEntry[];
  scanned: string[];
  /**
   * 목록이 **어떻게** 만들어졌는지 — 상한에 걸린 스캔, 없는 루트, 읽지 못한
   * 설정 파일. 프로젝트가 0개인 것은 정상적인 답이고 설정을 못 읽은 것은 아닌데,
   * 이 줄이 없으면 둘이 같은 화면이 된다.
   */
  notes: string[];
}

export interface RemoteDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  project_types: string[];
  /** gitignore 로 무시되는 항목 — 로컬 트리가 흐리게 그리는 그 플래그다. */
  is_ignored: boolean;
}

export interface RemoteDir {
  root: string;
  path: string;
  entries: RemoteDirEntry[];
  from_index: number;
  total: number;
  truncated: boolean;
}

export interface RemoteFileChange {
  path: string;
  code: string;
  staged: boolean;
  conflicted: boolean;
}

export interface RemoteGitStatus {
  is_repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_remote: boolean;
  merging: boolean;
  reverting: boolean;
  changes: RemoteFileChange[];
}

export interface RemoteCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  date: string;
  refs: string;
  subject: string;
}

export interface RemoteGitLog {
  root: string;
  commits: RemoteCommit[];
  truncated: boolean;
  next_cursor: string | null;
}

export interface RemoteWorktree {
  path: string;
  head: string;
  branch: string;
  is_main: boolean;
}

export interface RemoteWorktrees {
  root: string;
  worktrees: RemoteWorktree[];
}

export interface RemoteGitRoot {
  path: string;
  branch: string;
}

export interface RemoteGitRoots {
  root: string;
  roots: RemoteGitRoot[];
  /** 스캐너가 200개 상한에서 멈췄다 — **이어받을 주소가 없는** 유일한 잘림. */
  at_cap: boolean;
}

/** 한 번에 받아 오는 트리 한 페이지·히스토리 한 페이지의 크기. */
export const TREE_PAGE = 200;
export const LOG_PAGE = 50;

/**
 * git-roots 스캔에 **항상** 붙는 단서.
 *
 * `at_cap` 은 200개 저장소 상한만 말한다. 같은 스캐너는 2만 디렉터리를 돌면
 * 그냥 포기하고 **평범한 완전해 보이는 목록**을 돌려주는데(측정: 2.5만 디렉터리
 * 100 저장소 중 80개만, 무표시), 그 사실을 응답으로 알 방법이 없다. 이 프로젝트에
 * 등재된 무음 유실이 바로 그것이라, 조용히 두는 대신 화면이 늘 말한다.
 */
export const GIT_ROOTS_CAVEAT =
  "이 스캔은 디렉터리 2만 개에서 표시 없이 멈출 수 있습니다 — 넓은 트리에서는 목록이 부분일 수 있습니다(더 좁은 프로젝트를 고르면 확실합니다).";

// ---------------------------------------------------------------------------
// 잘림 — 화면이 말해야 하는 것들
// ---------------------------------------------------------------------------

/**
 * 이 페이지 뒤로 더 있나 — **개수가 정본이고 플래그는 백스톱이다**.
 *
 * 둘 다 보는 이유는 그대로다: 생산자가 `truncated` 를 빠뜨려도 `from_index +
 * 보인 개수 < total` 이 같은 사실을 말한다(신호가 하나뿐인 곳에서는 그 하나가
 * 사라지는 순간 화면이 조용해진다). 다만 **순서가 있다**.
 *
 * `truncated || 개수` 로 OR 하면 마지막 페이지에 `truncated:true` 가 실려 올 때
 * (생산자가 "상한만큼 읽었다"를 그대로 말하는 흔한 모양) **없는 잘림을 지어낸다**
 * — 그리고 「더 보기」는 `from == total` 로 조회해 아무것도 못 가져온다. 그래서
 * 개수를 믿을 수 있으면 개수로 판정하고, 개수가 스스로 모순일 때만
 * (`total < 지금까지 본 것`) 플래그를 백스톱으로 쓴다.
 */
export function dirHasMore(d: RemoteDir): boolean {
  const shown = d.from_index + d.entries.length;
  if (d.total >= shown) return shown < d.total;
  return d.truncated;
}

/** "N개 중 M개만 보이고 있습니다" — 없으면 `null`. */
export function dirCutNote(d: RemoteDir): string | null {
  if (!dirHasMore(d)) return null;
  const shown = d.from_index + d.entries.length;
  return `이 폴더의 항목 ${d.total}개 중 ${shown}개만 보이고 있습니다.`;
}

/** 히스토리의 잘림 한 줄 — **이어받을 주소가 있는 잘림과 없는 잘림은 다른 답이다.** */
export function logCutNote(p: RemoteGitLog): string | null {
  if (!p.truncated) return null;
  if (p.next_cursor) {
    return `히스토리가 더 있습니다 — 지금 ${p.commits.length}개를 받았습니다.`;
  }
  return `히스토리가 더 있지만 이어받을 주소가 없습니다 — 데몬의 페이징 상한(5만 커밋)을 넘었습니다. 나머지는 호스트에서 git 으로 직접 봐야 합니다.`;
}

/** git-roots 의 잘림 — 이것도 이어받을 주소가 없다. */
export function rootsCutNote(r: RemoteGitRoots): string | null {
  if (!r.at_cap) return null;
  return `저장소 ${r.roots.length}개에서 스캐너가 상한에 걸려 멈췄습니다 — 이어받을 주소가 없습니다. 더 좁은 프로젝트를 골라 다시 스캔하세요.`;
}

/** "더 보기" 를 눌러도 되나 (주소가 있는 잘림에만 있다). */
export function logHasMore(p: RemoteGitLog): boolean {
  return p.truncated && !!p.next_cursor;
}

// ---------------------------------------------------------------------------
// 페이지 이어 붙이기 — **구멍은 이어 붙이지 않는다**
// ---------------------------------------------------------------------------

/**
 * 트리의 다음 페이지를 붙인다.
 *
 * 이어지지 않는 페이지는 **거절한다**. 데몬은 `from_index` 로 자기가 어디서
 * 시작했는지 말하므로, 기대한 자리와 다르면 그 사이가 빠진 것이고 그대로 붙이면
 * 화면은 빠진 줄 모른 채 "이게 전부"라고 말하게 된다. 조용한 이어 붙이기가 곧
 * 무음 유실이다.
 */
export function appendDirPage(prev: RemoteDir | null, page: RemoteDir): Merge<RemoteDir> {
  const fresh = !prev || prev.root !== page.root || prev.path !== page.path;
  if (fresh) {
    if (page.from_index !== 0) {
      return {
        ok: false,
        error: `첫 페이지가 ${page.from_index}번째부터 왔습니다 — 앞부분을 조용히 버리지 않습니다.`,
      };
    }
    return { ok: true, value: page };
  }
  const expected = prev.from_index + prev.entries.length;
  if (page.from_index !== expected) {
    return {
      ok: false,
      error: `페이지가 이어지지 않습니다 — ${expected}번째부터를 기대했는데 ${page.from_index}번째가 왔습니다(빠진 구간을 조용히 이어 붙이지 않습니다).`,
    };
  }
  return {
    ok: true,
    value: {
      ...page,
      from_index: prev.from_index,
      entries: [...prev.entries, ...page.entries],
    },
  };
}

/**
 * 히스토리의 다음 페이지를 붙인다.
 *
 * 데몬의 계약은 "페이지는 이어 붙는다" — 이음매에서 중복도 건너뜀도 없다. 그래서
 * 여기서는 정렬하지도 중복을 지우지도 않는다(그래야 한다면 계약이 깨진 것이고,
 * 그것을 여기서 덮으면 아무도 모른다). 다른 저장소의 페이지는 이어 붙이지 않는다.
 */
export function appendLogPage(prev: RemoteGitLog | null, page: RemoteGitLog): Merge<RemoteGitLog> {
  if (!prev || prev.root !== page.root) return { ok: true, value: page };
  return {
    ok: true,
    value: { ...page, commits: [...prev.commits, ...page.commits] },
  };
}

/** 화면에 보이는 것이 지금 것인지 — 오류가 있는데 값도 있으면 그 값은 과거다. */
export function staleNote(l: Fetched<unknown>, now: number = Date.now()): string | null {
  if (!l.error || l.value == null || l.at == null) return null;
  const secs = Math.max(0, Math.round((now - l.at) / 1000));
  return secs < 60
    ? `아래 내용은 ${secs}초 전 것입니다.`
    : `아래 내용은 ${Math.round(secs / 60)}분 전 것입니다.`;
}

/** 원격 데이터 패널이 보여 주는 갈래. */
export type RemoteDataTab = "tree" | "git" | "worktrees";

// ---------------------------------------------------------------------------
// 경로 — 루트 위로는 올라가지 않는다
// ---------------------------------------------------------------------------

/** 루트 기준 표시용 경로(`root` 자신은 `""`). 화면이 절대 경로로 도배되지 않게. */
export function relPath(root: string, path: string): string {
  if (!path || path === root) return "";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/**
 * 한 단계 위 폴더 — **루트 밖으로는 나가지 않는다**.
 *
 * 데몬은 루트 밖 경로를 거절하므로 여기서 막지 않아도 읽히지는 않는다. 그래도
 * 막는 이유는 다르다: 거절당한 조회는 화면에 오류 한 줄로 남고, 사용자는 자기가
 * 누른 "위로" 가 왜 실패했는지 알 수 없다. 그리고 이 검사는 **가드레일이지 보안
 * 경계가 아니다** — 경계는 데몬 쪽에 있고 그쪽도 그렇게 쓰여 있다.
 */
export function parentPath(root: string, path: string): string | null {
  const at = path || root;
  if (!at || at === root) return null;
  const cut = at.lastIndexOf("/");
  if (cut <= 0) return null;
  const up = at.slice(0, cut);
  if (up === root) return "";
  return up.startsWith(`${root}/`) ? up : null;
}

// ---------------------------------------------------------------------------
// 조회 훅
// ---------------------------------------------------------------------------

export interface RemoteHostDataView {
  /** 이 호스트가 발행하는 프로젝트 — 나머지 모든 조회의 `root`. */
  projects: Fetched<RemoteProjects>;
  root: string;
  setRoot: (root: string) => void;
  reloadProjects: (refresh?: boolean) => void;

  /** 지금 보고 있는 폴더(빈 문자열 = 루트 자신). */
  path: string;
  openDir: (path: string) => void;
  dir: Fetched<RemoteDir>;
  moreDir: () => void;
  reloadDir: () => void;

  status: Fetched<RemoteGitStatus>;
  reloadStatus: () => void;

  log: Fetched<RemoteGitLog>;
  moreLog: () => void;
  reloadLog: () => void;

  worktrees: Fetched<RemoteWorktrees>;
  reloadWorktrees: () => void;

  roots: Fetched<RemoteGitRoots>;
  reloadRoots: () => void;
}

/**
 * 조회 하나의 **주소**.
 *
 * 이것이 자동 회수 원시({@link useAutoFetch})의 잠금 키다 — 가리키는 대상만
 * 들어간다. 앞선 판에서는 잠금 키가 `slot`("dir"/"status") **하나뿐**이라 root 가
 * 없었고, 그래서 A 를 읽는 중에 B 를 고르면 B 요청이 in-flight 가드에 걸려 **말없이
 * 삼켜졌다**(상태 갱신 0 · `attempted` 는 이미 true 라 자동 재조회도 없다). 늦게
 * 온 A 응답은 B 라벨 아래 그려졌다. 주소가 키에 들어 있으면 그 일이 일어날 수 없다.
 */
const SEP = "\u0000";
export const projectsKey = (hostId: string): string => `projects${SEP}${hostId}`;
export const dirKey = (hostId: string, root: string, path: string): string =>
  `dir${SEP}${hostId}${SEP}${root}${SEP}${path}`;
export const repoKey = (slot: string, hostId: string, root: string): string =>
  `${slot}${SEP}${hostId}${SEP}${root}`;

/**
 * 한 호스트의 데이터 조회.
 *
 * 폴링하지 않는다 — 이것은 흐르는 것이 아니라 **사용자가 볼 때 읽는 것**이고,
 * 한 번의 조회가 SSH 왕복 한 번이다(R1 이 만든 규칙: 자동 반복은 상한이 있어야
 * 한다). 그래서 갈래를 열 때 한 번 읽고, 그 뒤는 새로고침 버튼이다.
 *
 * 실패는 **빈 값으로 축소하지 않는다**. 값은 있던 것을 남기고(빈 화면보다 낫다)
 * 오류와 마지막 성공 시각을 같이 들고 있어, 화면이 "지금 이렇다"로 읽히는 일이
 * 없게 한다 — 앞 슬라이스가 `hostsError`/`hostsAt` 으로 세운 결 그대로다.
 */
export function useRemoteHostData(hostId: string): RemoteHostDataView {
  const [root, setRootState] = useState("");
  const [path, setPath] = useState("");
  // 갈래마다 자동 회수 원시 하나. 잠금·in-flight·세대·캐시 규칙은 전부 그 안에
  // 있고(`autoFetch.ts`), 여기 남은 것은 **주소를 어떻게 쓰나**뿐이다.
  const projectStore = useAutoFetch<RemoteProjects>();
  const dirStore = useAutoFetch<RemoteDir>();
  const statusStore = useAutoFetch<RemoteGitStatus>();
  const logStore = useAutoFetch<RemoteGitLog>();
  const worktreeStore = useAutoFetch<RemoteWorktrees>();
  const rootStore = useAutoFetch<RemoteGitRoots>();

  const reloadProjects = useCallback(
    (refresh = false) => {
      if (!hostId) return;
      projectStore.run({
        key: projectsKey(hostId),
        args: refresh ? "refresh" : "",
        call: () => invoke<RemoteProjects>("remote_projects", { hostId, refresh }),
      });
    },
    [hostId, projectStore],
  );

  const loadDir = useCallback(
    (at: string, from: number) => {
      if (!hostId || !root) return;
      dirStore.run({
        key: dirKey(hostId, root, at),
        // 페이지 번호는 **인자**다 — 주소가 아니다. 여기에 두면 같은 폴더의 다음
        // 페이지가 앞 페이지와 합쳐지지 않고(교체) 이어 붙기가 제대로 돈다.
        args: String(from),
        call: () =>
          invoke<RemoteDir>("remote_tree", {
            hostId,
            root,
            path: at || null,
            from,
            limit: TREE_PAGE,
          }),
        merge: (prev, got) => (from === 0 ? { ok: true, value: got } : appendDirPage(prev, got)),
      });
    },
    [dirStore, hostId, root],
  );

  const openDir = useCallback(
    (at: string) => {
      if (!hostId || !root) return;
      setPath(at);
      // 보고 있는 폴더는 하나다 — 다른 폴더의 칸은 버린다. 버리면 **세대가 올라가**
      // 그 폴더로 나가 있던 회수의 늦은 답이 새 폴더 아래 그려지지 않는다.
      dirStore.retain((k) => k === dirKey(hostId, root, at));
      loadDir(at, 0);
    },
    [dirStore, hostId, loadDir, root],
  );

  const dir = dirStore.get(dirKey(hostId, root, path));

  const moreDir = useCallback(() => {
    const d = dirStore.get(dirKey(hostId, root, path)).value;
    if (!d) return;
    loadDir(path, d.from_index + d.entries.length);
  }, [dirStore, hostId, loadDir, path, root]);

  const reloadDir = useCallback(() => loadDir(path, 0), [loadDir, path]);

  const reloadStatus = useCallback(() => {
    if (!hostId || !root) return;
    statusStore.run({
      key: repoKey("status", hostId, root),
      call: () => invoke<RemoteGitStatus>("remote_git_status", { hostId, root }),
    });
  }, [hostId, root, statusStore]);

  const loadLog = useCallback(
    (cursor: string | null) => {
      if (!hostId || !root) return;
      logStore.run({
        key: repoKey("log", hostId, root),
        args: cursor ?? "",
        call: () => invoke<RemoteGitLog>("remote_git_log", { hostId, root, limit: LOG_PAGE, cursor }),
        merge: (prev, got) => (cursor ? appendLogPage(prev, got) : { ok: true, value: got }),
      });
    },
    [hostId, logStore, root],
  );

  const log = logStore.get(repoKey("log", hostId, root));
  const reloadLog = useCallback(() => loadLog(null), [loadLog]);
  const moreLog = useCallback(() => {
    const c = log.value?.next_cursor;
    if (c) loadLog(c);
  }, [loadLog, log.value?.next_cursor]);

  const reloadWorktrees = useCallback(() => {
    if (!hostId || !root) return;
    worktreeStore.run({
      key: repoKey("worktrees", hostId, root),
      call: () => invoke<RemoteWorktrees>("remote_worktrees", { hostId, root }),
    });
  }, [hostId, root, worktreeStore]);

  const reloadRoots = useCallback(() => {
    if (!hostId || !root) return;
    rootStore.run({
      key: repoKey("roots", hostId, root),
      call: () => invoke<RemoteGitRoots>("remote_git_roots", { hostId, root }),
    });
  }, [hostId, root, rootStore]);

  /**
   * 프로젝트를 고르면 그 아래 것들은 전부 다른 저장소의 것이 된다 — 버린다.
   *
   * 버리는 것이 곧 세대를 올리는 것이라, 앞 프로젝트로 나가 있던 조회의 늦은
   * 답이 새 프로젝트 라벨 아래 그려지지 않는다.
   */
  const setRoot = useCallback(
    (next: string) => {
      setRootState(next);
      setPath("");
      for (const s of [dirStore, statusStore, logStore, worktreeStore, rootStore]) {
        s.retain(() => false);
      }
    },
    [dirStore, logStore, rootStore, statusStore, worktreeStore],
  );

  // 패널을 펼치면 프로젝트 목록 한 번. 그 뒤는 사용자가 누를 때만이다.
  useEffect(() => {
    reloadProjects(false);
  }, [reloadProjects]);

  return {
    projects: projectStore.get(projectsKey(hostId)),
    root,
    setRoot,
    reloadProjects,
    path,
    openDir,
    dir,
    moreDir,
    reloadDir,
    status: statusStore.get(repoKey("status", hostId, root)),
    reloadStatus,
    log,
    moreLog,
    reloadLog,
    worktrees: worktreeStore.get(repoKey("worktrees", hostId, root)),
    reloadWorktrees,
    roots: rootStore.get(repoKey("roots", hostId, root)),
    reloadRoots,
  };
}
