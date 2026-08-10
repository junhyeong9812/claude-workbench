import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errText } from "../utils/error";
import { parentDir } from "./treeDnd";
import { planNewFiles, normalizeRel } from "../utils/treePaths";

/**
 * 트리 우클릭 CRUD 공용 UI — 컨텍스트 메뉴 + 입력/확인 다이얼로그.
 *
 * 파일 탭 트리(FolderTree, PR#39)가 원본이고, 스터디 트리·개발 모드 트리가
 * 같은 동작을 갖도록 그 마크업·핸들러를 여기로 올린 것이다. 트리마다 다른 것은
 * **호스트 계약**(`TreeCrudHost`)으로만 갈린다: containment 루트, 새로고침 방법,
 * 생성/삭제 후 후속(에디터 열기·탭 정리), 메뉴에 덧붙일 항목.
 *
 * 백엔드는 기존 커맨드를 그대로 쓴다 — `create_files`(다중·전부 아니면 전무)·
 * `create_dir`·`rename_path`·`delete_path`. 모두 `root`를 받아 그 밖으로 나가는
 * 경로를 거부하므로(ensure_within), 스터디 좌/우 트리는 각자의 루트에 봉쇄된다
 * (반대쪽 폴더로의 탈출도 거부).
 */

/** 트리 노드의 최소 형태 — `DirEntry`의 부분집합(스터디·파일 탭 공용). */
export interface CrudNode {
  path: string;
  name: string;
  is_dir: boolean;
}

/** 메뉴에 덧붙일 항목 (드롭 존·경로 복사 등 트리별 고유 기능). */
export interface TreeMenuItem {
  label: string;
  title?: string;
  danger?: boolean;
  onClick: () => void;
}

/** 열려 있는 다이얼로그 — 입력형(새 파일/새 폴더/이름 변경)과 확인형(삭제). */
export type CrudDialogState =
  | { kind: "newfile" | "newfolder"; dir: string }
  | { kind: "rename"; node: CrudNode }
  | { kind: "delete"; node: CrudNode };

/** Quick file-type picks for "새 파일" (fills the extension; the user can also
 * just type a full name like `Foo.java`). Our supported languages + markdown. */
const FILE_EXTS: [string, string][] = [
  ["Rust", "rs"],
  ["Java", "java"],
  ["Kotlin", "kt"],
  ["Python", "py"],
  ["TS", "ts"],
  ["TSX", "tsx"],
  ["JS", "js"],
  ["HTML", "html"],
  ["CSS", "css"],
  ["MD", "md"],
];

export interface TreeCrudHost {
  /** containment 루트 = 이 트리의 루트 (스터디는 그 쪽 폴더). null이면 메뉴가 열리지 않는다. */
  root: string | null;
  /** 디스크 변경을 화면에 반영 — 이 디렉토리를 다시 읽는다. */
  reloadDir: (dir: string) => void | Promise<void>;
  /** 생성 후 그 폴더를 펼친다(루트는 제외 — 훅이 걸러 준다). */
  expandDir?: (dir: string) => void;
  /** 생성 성공 후: 만들어진 경로 전부(생성 순서). 호스트가 열지 말지 정한다. */
  onCreated?: (paths: string[]) => void;
  /** 삭제 성공 후: 지워진 경로(죽은 탭 정리 등). */
  onDeleted?: (path: string) => void;
  /** 메뉴 하단(이름 변경/삭제 위)에 덧붙일 트리 고유 항목. */
  extraItems?: (node: CrudNode | null, dir: string) => TreeMenuItem[];
  /** 주면 "여기서 터미널 열기" 항목이 붙는다 (그 폴더 cwd의 터미널 탭). */
  onOpenTerminal?: (dir: string) => void;
}

export interface TreeCrud {
  /** 우클릭 → 메뉴 열기. `node=null`은 빈 영역(루트 대상). */
  openMenu: (node: CrudNode | null, x: number, y: number) => void;
  /** 메뉴·다이얼로그 렌더 — 트리 컨테이너 안에 그대로 넣는다. */
  ui: ReactNode;
}

export function useTreeCrud(host: TreeCrudHost): TreeCrud {
  const [menu, setMenu] = useState<{
    node: CrudNode | null;
    dir: string;
    x: number;
    y: number;
  } | null>(null);
  const [dialog, setDialog] = useState<CrudDialogState | null>(null);
  const [name, setName] = useState("");
  const [opErr, setOpErr] = useState<string | null>(null);

  // 작업 대상 dir: 폴더는 자신, 파일은 그 부모, 빈 영역은 트리 루트.
  const dirOf = (node: CrudNode | null): string => {
    if (!node) return host.root ?? "";
    return node.is_dir ? node.path : parentDir(node.path);
  };

  const openMenu = (node: CrudNode | null, x: number, y: number) => {
    if (!host.root) return;
    setMenu({ node, dir: dirOf(node), x, y });
  };

  const openDialog = (d: CrudDialogState, initial = "") => {
    setMenu(null);
    setOpErr(null);
    setName(initial);
    setDialog(d);
  };

  // Run a filesystem op, refresh the affected dir, surface errors in the dialog.
  // Returns true only on success, so callers can chain (e.g. open the new file)
  // without firing on failure.
  const runOp = async (
    fn: () => Promise<void>,
    reloadTarget: string,
    afterExpand?: string,
  ): Promise<boolean> => {
    setOpErr(null);
    try {
      await fn();
      await host.reloadDir(reloadTarget);
      // 루트는 항상 보이므로 펼칠 필요가 없다(스터디 트리의 확장 목록 오염 방지).
      if (afterExpand && afterExpand !== host.root) host.expandDir?.(afterExpand);
      setDialog(null);
      setName("");
      return true;
    } catch (e) {
      setOpErr(errText(e, "작업 실패"));
      return false;
    }
  };

  const submitDialog = () => {
    const root = host.root;
    if (!dialog || !root) return;
    const trimmed = name.trim();
    if (dialog.kind === "newfile") {
      // brace 다중 생성 포함 — `sub/Foo.java`는 하위 폴더도 만든다. 확장 실패
      // (중첩 {}·빈 항목·상한 초과·무효 세그먼트)는 아무것도 만들지 않는다.
      const plan = planNewFiles(trimmed, dialog.dir);
      if (!plan.ok) {
        setOpErr(plan.error);
        return;
      }
      const paths = plan.paths;
      void runOp(() => invoke("create_files", { paths, root }), dialog.dir, dialog.dir).then(
        (ok) => {
          if (ok) host.onCreated?.(paths);
        },
      );
    } else if (dialog.kind === "newfolder") {
      // `.` (Java package style) or `/` → nested dirs. Reject empty segments so
      // `.` / `/` / `...` don't silently no-op on an existing dir.
      const rel = normalizeRel(trimmed.replace(/\./g, "/"));
      if (!rel) {
        setOpErr("올바른 폴더명을 입력하세요");
        return;
      }
      void runOp(
        () => invoke("create_dir", { path: `${dialog.dir}/${rel}`, root }),
        dialog.dir,
        dialog.dir,
      );
    } else if (dialog.kind === "rename") {
      const rel = normalizeRel(trimmed);
      if (!rel) {
        setOpErr("올바른 이름을 입력하세요");
        return;
      }
      const parent = parentDir(dialog.node.path);
      void runOp(
        () => invoke("rename_path", { from: dialog.node.path, to: `${parent}/${rel}`, root }),
        parent,
      );
    }
  };

  const menuItems: TreeMenuItem[] = menu
    ? [
        { label: "새 파일", onClick: () => openDialog({ kind: "newfile", dir: menu.dir }) },
        { label: "새 폴더", onClick: () => openDialog({ kind: "newfolder", dir: menu.dir }) },
        ...(host.onOpenTerminal
          ? [
              {
                label: "여기서 터미널 열기",
                title: `${menu.dir} 에서 터미널 탭을 엽니다`,
                onClick: () => host.onOpenTerminal!(menu.dir),
              },
            ]
          : []),
        ...(host.extraItems?.(menu.node, menu.dir) ?? []),
      ]
    : [];

  const ui = (
    <>
      {menu && (
        <>
          <div
            className="tree-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="tree-menu" style={{ left: menu.x, top: menu.y }}>
            {menuItems.map((it) => (
              <button
                key={it.label}
                className={`tree-menu-item${it.danger ? " tree-menu-danger" : ""}`}
                title={it.title}
                onClick={() => {
                  setMenu(null);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
            {menu.node && (
              <>
                <div className="tree-menu-sep" />
                <button
                  className="tree-menu-item"
                  onClick={() => openDialog({ kind: "rename", node: menu.node! }, menu.node!.name)}
                >
                  이름 변경
                </button>
                <button
                  className="tree-menu-item tree-menu-danger"
                  onClick={() => {
                    setDialog({ kind: "delete", node: menu.node! });
                    setMenu(null);
                    setOpErr(null);
                  }}
                >
                  삭제
                </button>
              </>
            )}
          </div>
        </>
      )}

      {dialog && (
        <div className="tree-dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="tree-dialog" onClick={(e) => e.stopPropagation()}>
            {dialog.kind === "delete" ? (
              <>
                <div className="tree-dialog-head">삭제 확인</div>
                <div className="tree-dialog-msg">
                  <code>{dialog.node.name}</code> 을(를) 삭제할까요?
                  {dialog.node.is_dir && " (폴더 내용 전부)"}
                </div>
                {opErr && <div className="tree-dialog-err">{opErr}</div>}
                <div className="tree-dialog-foot">
                  <button onClick={() => setDialog(null)}>취소</button>
                  <button
                    className="tree-menu-danger"
                    onClick={() => {
                      // 루트 없이 지우면 백엔드 containment가 꺼진 채로 도는 옛
                      // 경로가 된다 — 프로젝트 전환 등으로 루트가 사라졌으면 거부.
                      if (!host.root) {
                        setOpErr("트리 루트를 확인할 수 없습니다");
                        return;
                      }
                      void runOp(
                        () =>
                          invoke("delete_path", { path: dialog.node.path, root: host.root }),
                        parentDir(dialog.node.path),
                      ).then((ok) => {
                        if (ok) host.onDeleted?.(dialog.node.path);
                      });
                    }}
                  >
                    삭제
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tree-dialog-head">
                  {dialog.kind === "newfile"
                    ? "새 파일"
                    : dialog.kind === "newfolder"
                      ? "새 폴더"
                      : "이름 변경"}
                </div>
                {dialog.kind === "newfolder" && (
                  <div className="tree-dialog-hint">. 또는 / 로 중첩 폴더 (예: com.example.foo)</div>
                )}
                {dialog.kind === "newfile" && (
                  <div className="tree-dialog-hint">
                    {"{a,b}.ts · x.{ts,tsx} 로 여러 개 한 번에 (중첩 {} 불가)"}
                  </div>
                )}
                <input
                  className="tree-dialog-input"
                  autoFocus
                  value={name}
                  placeholder={dialog.kind === "newfile" ? "파일명 (예: Foo.java)" : "이름"}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitDialog();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setDialog(null);
                    }
                  }}
                />
                {dialog.kind === "newfile" && (
                  <div className="tree-dialog-exts">
                    {FILE_EXTS.map(([label, ext]) => (
                      <button
                        key={ext}
                        className="tree-ext-btn"
                        onClick={() =>
                          setName((n) => {
                            const base = n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
                            return `${base || "Untitled"}.${ext}`;
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {opErr && <div className="tree-dialog-err">{opErr}</div>}
                <div className="tree-dialog-foot">
                  <button onClick={() => setDialog(null)}>취소</button>
                  <button onClick={submitDialog}>확인</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );

  return { openMenu, ui };
}
