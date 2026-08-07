import { useEffect, useRef } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../state/store";
import { xtermTheme } from "./xtermTheme";
import type { TerminalOutputEvent, SnapshotResult } from "../types";
import { decodePtyData, ptyEventName, pushPendingCapped } from "./pty";
import { errText } from "../utils/error";

/** Params attached to a terminal panel. `sessionId` is persisted into the
 * dockview layout so a remount (tab/project switch) re-attaches the same PTY.
 *
 * SSH panels carry **non-secret** connection metadata only (host/port/user/auth
 * method/key path/connection id) — never a password or passphrase. After a
 * restart the live session is gone; the panel recreates it via `ssh_create`,
 * and the secret comes from the OS keychain (by `connectionId`), not from here
 * (review F8). An unsaved ad-hoc connection has no `connectionId`, so it cannot
 * auto-reconnect after restart (expected). */
export interface TerminalParams {
  kind?: "terminal" | "editor" | "ssh" | "codexterm";
  title?: string;
  sessionId?: number;
  /** One-shot command run once when a fresh terminal starts (build/test runner).
   * Cleared from params after running so a remount won't re-run it. */
  runCmd?: string;
  /** Working directory for a fresh terminal (build/test runner pins it to the
   * target project); falls back to the active project when absent. */
  cwd?: string;
  /** codexterm 전용 스폰 옵션 — `-m <model>` / `-c model_reasoning_effort=<e>`.
   * 미지정이면 키가 실리지 않고 백엔드도 플래그를 붙이지 않는다(= `~/.codex/
   * config.toml` 그대로). 레이아웃에 직렬화되므로 재시작 후 같은 모델·강도로
   * 다시 뜬다 — claudeterm의 model/effort와 같은 계약. */
  model?: string;
  effort?: string;
  // SSH-only (non-secret):
  host?: string;
  port?: number;
  username?: string;
  authKind?: "password" | "publickey" | "agent";
  keyPath?: string | null;
  connectionId?: string;
}

interface SshStatusEvent {
  id: number;
  phase: "connecting" | "ready" | "failed" | "closed";
  reason?: string | null;
}

/**
 * A real PTY-backed terminal (xterm.js) living in a dockview panel.
 *
 * Lifecycle (spec P2b-1 §0.1): mount = create-or-attach a session; unmount =
 * **detach only** (the PTY survives in the Rust `SessionManager`); the session
 * is closed on real panel removal by `MainArea`'s `onDidRemovePanel`.
 *
 * Backfill/live contract (spec §0 ③): we register the output listener *before*
 * snapshotting, buffer chunks until the snapshot resolves, then replay the
 * snapshot and apply only chunks with `seq > last_seq` — no loss, no dup.
 */
export function TerminalPanel(props: IDockviewPanelProps<TerminalParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Live-update the xterm palette when the app theme or custom colors change.
  const theme = useAppStore((s) => s.theme);
  const termColors = useAppStore((s) => s.termColors);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, termColors);
  }, [theme, termColors]);

  // When this panel becomes the active tab without remounting (e.g. it stays
  // mounted in a split while another group is clicked), pull DOM focus into the
  // terminal — dockview's group focus alone wouldn't deliver keystrokes here.
  useEffect(() => {
    const d = props.api.onDidActiveChange(() => {
      if (props.api.isActive) termRef.current?.focus();
    });
    return () => d.dispose();
  }, [props.api]);

  // Live-update terminal font size (+ refit).
  const fontSize = useAppStore((s) => s.fontSize);
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
    }
  }, [fontSize]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: useAppStore.getState().fontSize,
      theme: xtermTheme(useAppStore.getState().theme, useAppStore.getState().termColors),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host not laid out yet — ResizeObserver will fit shortly */
    }
    // onlyWhenVisible: a tab switch (Alt/click/programmatic) remounts the now-
    // active panel, so focusing here lands keystrokes in the terminal without a
    // second click. dockview's setActive() only focuses the group, not content.
    term.focus();

    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenSsh: UnlistenFn | undefined;
    let sessionId: number | null = null;
    let lastApplied = 0;
    let ready = false;
    const pending: TerminalOutputEvent[] = [];
    const isSsh = props.params.kind === "ssh";
    // codex 세션 — 스폰 커맨드만 다르고 그 뒤(구독·스냅샷·drain·입력·리사이즈·
    // 닫기)는 일반 터미널과 완전히 같다.
    const isCodex = props.params.kind === "codexterm";

    const write = (bytes: Uint8Array | number[]) => {
      if (!disposed) term.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    };
    const writeText = (s: string) => {
      if (!disposed) term.write(s);
    };
    const applyLive = (ev: TerminalOutputEvent) => {
      if (ev.session_id === sessionId && ev.seq > lastApplied) {
        write(decodePtyData(ev.data));
        lastApplied = ev.seq;
      }
    };
    // P3: 세션별 이벤트 구독 — 전역 단일 이벤트를 전 패널이 역직렬화하던
    // 것을 제거. 구독 → 스냅샷 → drain 순서(R1-1 계약)는 아래에서 유지.
    let pendingTotal = 0;
    let pendingDropped = false;
    const subscribeOutput = async (id: number) => {
      if (unlisten) unlisten();
      unlisten = undefined;
      const un = await listen<TerminalOutputEvent>(ptyEventName(id), (e) => {
        if (!ready) {
          const r = pushPendingCapped(pending, e.payload, pendingTotal);
          pendingTotal = r.total;
          pendingDropped ||= r.dropped;
        } else applyLive(e.payload);
      });
      // await 중 언마운트됐으면 즉시 해제 — cleanup은 이미 지나갔다(리뷰 P1,
      // 구 코드의 P3-R5 방어선 복원).
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
    };
    // pending 드롭이 있었으면 drain 직전 스냅샷을 다시 떠 갭을 잇는다(리뷰
    // P1/P2 — 스냅샷 이후 도착분 드롭은 상단 소실이 아니라 중간 절단이 된다).
    // 중복 방지 초기화는 term.reset()이 아니라 RIS(ESC c)를 **write 큐로**
    // 보낸다 — reset()은 동기라 큐에 남은 이전 도장분이 reset 뒤에 그려져
    // 순서가 깨진다(감사 B1). heal 왕복 중 재드롭이 나면 신호가 사라질 때까지
    // 반복(감사 B2 — 상한은 연속 홍수 방어, 각 반복이 더 새 스냅샷으로 전진).
    const healDroppedGap = async () => {
      // 반복 불변식: 매 회 pending을 비우고 스냅샷을 뜨면 그 스냅샷이 비운
      // 분량 전체를 대체한다(≤ last_seq). 왕복 중 새 도착분은 새 pending —
      // 그것도 넘치면 dropped가 다시 서고 한 번 더 돈다. 상한 없이 안전:
      // 지속 홍수에서는 "스냅샷 폴링 + RIS 재도장"으로 자연 강등(await로
      // 양보, disposed/세션 소멸로 탈출)이고 홍수가 멎으면 즉시 종료(감사
      // B2 잔존 경계 — 10회 뒤 갭 대신 무갭 강등을 선택).
      while (pendingDropped && sessionId != null && !disposed) {
        pendingDropped = false;
        pending.length = 0;
        pendingTotal = 0;
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: sessionId });
          if (disposed) return;
          write(new TextEncoder().encode("\x1bc")); // RIS — 큐 순서로 전체 초기화
          write(decodePtyData(snap.data));
          lastApplied = snap.last_seq;
        } catch {
          return; /* 세션 소멸 — drain이 남은 pending을 seq 게이트로 처리 */
        }
      }
    };

    (async () => {
      // SSH status: show a "closed" line in-terminal. Connect/auth **failures**
      // are surfaced by MainArea's global listener (it can't be missed by a
      // not-yet-mounted panel — review P3-R1), so we don't duplicate them here.
      if (isSsh) {
        unlistenSsh = await listen<SshStatusEvent>("ssh-status", (e) => {
          if (e.payload.id !== sessionId) return;
          if (e.payload.phase === "closed") {
            writeText(`\r\n\x1b[2m[SSH 연결 종료]\x1b[0m\r\n`);
          }
        });
      }
      // If the panel was disposed while the listeners were being registered,
      // unlisten them now (the cleanup ran before they were assigned) — no leak
      // (review P3-R5).
      if (disposed) {
        if (unlisten) unlisten();
        if (unlistenSsh) unlistenSsh();
        return;
      }

      // 1) Re-attach to a persisted session, else create a fresh one.
      const existing = props.params.sessionId;
      if (existing != null) {
        // Subscribe BEFORE snapshotting so the live listener buffers matching
        // chunks into `pending` from the first frame. Otherwise chunks emitted
        // between the backend computing the snapshot and this point are missed
        // AND absent from the snapshot → lost (review R1-1, relied on by
        // cross-window transfer). The `seq > last_seq` drain below skips any
        // chunk already included in the snapshot.
        sessionId = existing;
        await subscribeOutput(existing);
        try {
          const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: existing });
          write(decodePtyData(snap.data));
          lastApplied = snap.last_seq;
        } catch {
          sessionId = null; // session gone (e.g. after restart) -> recreate
        }
      }
      if (disposed) return;
      if (sessionId == null) {
        // Opt-in scrollback persistence keys on the (layout-stable) panel id, so
        // a restored panel restores its own prior output (review F11).
        // codex는 이 opt-in을 **의도적으로 안 탄다**(아래 분기가 persistKey를 안
        // 넘긴다): 전체화면 TUI의 지난 프레임을 재도장하면 살아 있는 화면처럼
        // 보이는 죽은 그림이 남고, 곧이어 새 TUI가 그 위에 그린다.
        const persistKey = useAppStore.getState().persistScrollback ? props.api.id : null;
        if (isSsh) {
          // Recreate after restart: no secret here — the backend reads it from
          // the keychain via connectionId. An ad-hoc (unsaved) connection has no
          // connectionId, so auth will fail and ssh-status surfaces the reason.
          const p = props.params;
          writeText(`\x1b[2m[${p.username}@${p.host}:${p.port ?? 22} 재접속 중...]\x1b[0m\r\n`);
          sessionId = await invoke<number>("ssh_create", {
            host: p.host,
            port: p.port ?? 22,
            username: p.username,
            authKind: p.authKind ?? "password",
            password: null,
            keyPath: p.keyPath ?? null,
            passphrase: null,
            connectionId: p.connectionId ?? null,
            persistKey,
            cols: term.cols,
            rows: term.rows,
          });
        } else if (isCodex) {
          // codex TUI를 프로젝트에 뿌리내려 띄운다. 스폰 실패는 **터미널 안에
          // 찍는다**: 가장 흔한 실패가 "설치 안 됨"(백엔드가 바이너리를 못 찾아
          // 스폰조차 시도하지 않는 경우)인데, 그때 아무것도 안 하면 사용자에게는
          // 원인 없는 검은 화면만 남는다. 일반 터미널 경로는 이 분기를 지나지
          // 않으므로 기존 동작 불변.
          const cwd = props.params.cwd ?? useAppStore.getState().activeProject ?? null;
          // 재부착에 실패해 여기까지 온 경우(재시작·PTY 소멸) = **새 세션**이다.
          // codex에는 `--session-id`가 없어 앱이 이전 대화를 이어 줄 수 없으므로
          // (그래서 이 탭은 지속성이 없다) 조용히 빈 TUI를 띄우면 사용자는 이전
          // 대화가 사라진 것을 화면으로만 추측하게 된다. 한 줄로 밝힌다.
          if (existing != null) {
            writeText(
              "\r\n\x1b[2m[새 codex 세션 — 이전 대화는 codex resume으로만 이어집니다]\x1b[0m\r\n",
            );
          }
          // 초기 크기에도 아래 onResize와 같은 퇴화 가드(감사) — 마운트 직후
          // 호스트가 아직 0px이면 FitAddon이 2×1을 주고, 그걸로 만들면 TUI가
          // 부서진 채 시작한다. 유효 크기는 첫 정상 resize가 곧바로 따라온다.
          const initCols = term.cols < 10 ? 80 : term.cols;
          const initRows = term.rows < 3 ? 24 : term.rows;
          try {
            sessionId = await invoke<number>("codex_create", {
              cwd,
              model: props.params.model ?? null,
              effort: props.params.effort ?? null,
              cols: initCols,
              rows: initRows,
            });
          } catch (e) {
            writeText(`\r\n\x1b[31m${errText(e, "codex 세션을 시작하지 못했습니다.")}\x1b[0m\r\n`);
            return; // 세션 없음 — 구독/스냅샷/drain 할 것이 없다
          }
        } else {
          // Pin to the requested cwd (build/test runner) over the live active
          // project, so a project switch between request and create can't run in
          // the wrong directory (codex finding).
          const cwd = props.params.cwd ?? useAppStore.getState().activeProject ?? null;
          sessionId = await invoke<number>("terminal_create", {
            cmd: null,
            cwd,
            cols: term.cols,
            rows: term.rows,
            persistKey,
          });
        }
        // Build/test runner: type the command into the fresh shell once it's up,
        // then drop it from the (persisted) params so a remount won't re-run it.
        if (!isSsh && props.params.runCmd && sessionId != null) {
          const cmd = props.params.runCmd;
          const sid = sessionId;
          setTimeout(() => {
            invoke("terminal_write", {
              id: sid,
              data: Array.from(new TextEncoder().encode(cmd + "\n")),
            }).catch(() => {});
          }, 400);
        }
        if (disposed) return; // create await 중 언마운트 — 구독/파라미터 갱신 불필요
        props.api.updateParameters({ ...props.params, sessionId, runCmd: undefined });
        // 2) Fresh session: subscribe now the id exists, then snapshot-backfill.
        // 백엔드 relay는 create 반환 **전**부터 돌므로 생성~구독 사이 초기
        // 청크(프롬프트)는 이벤트로 안 오고 스냅샷에만 있다 — 구 전역 리스너
        // 시절에도 sessionId 미할당으로 동일 유실이던 갭을 여기서 회수(감사
        // B3). 부수: F11 디스크 seed(스냅샷으로만 나옴)가 이 경로로 처음
        // 실제 도장된다(ledger #4 — 의도된 동작 변경으로 기록).
        if (sessionId != null) {
          await subscribeOutput(sessionId);
          try {
            const snap = await invoke<SnapshotResult>("terminal_snapshot", { id: sessionId });
            write(decodePtyData(snap.data));
            lastApplied = snap.last_seq;
          } catch {
            /* no scrollback yet */
          }
        }
      }

      // 3) Drain buffered chunks (skipping any already in the snapshot), go live.
      await healDroppedGap();
      ready = true;
      for (const ev of pending) applyLive(ev);
      pending.length = 0;
      pendingTotal = 0;
      pendingDropped = false;
    })();

    const onData = term.onData((d) => {
      if (sessionId == null) return;
      const bytes = Array.from(new TextEncoder().encode(d));
      invoke("terminal_write", { id: sessionId, data: bytes }).catch(() => {});
    });
    const onResize = term.onResize(() => {
      if (sessionId == null) return;
      // 퇴화 크기는 codex PTY로 내보내지 않는다(ClaudeTermPanel의 같은 백스톱).
      // 어떤 실제 레이아웃도 두 자리 미만 컬럼을 만들지 않는다 — 이 값이 나온다는
      // 건 호스트가 0px로 접혔다는 뜻이고(FitAddon의 하한이 만든 2×1), 그대로
      // 보내면 **전체화면 TUI가 실제로 2×1로 리사이즈되어 화면이 파괴된다**.
      // 셸(일반 터미널)은 다시 그릴 화면이 없어 무해하므로 codex에만 건다 —
      // 기존 터미널·SSH 탭의 동작을 바꾸지 않기 위해서다.
      if (isCodex && (term.cols < 10 || term.rows < 3)) return;
      invoke("terminal_resize", { id: sessionId, cols: term.cols, rows: term.rows }).catch(
        () => {},
      );
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* ignore transient layout errors */
      }
    });
    ro.observe(host);

    return () => {
      // Detach only — the session lives on for re-attach (spec §0.1).
      disposed = true;
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      if (unlisten) unlisten();
      if (unlistenSsh) unlistenSsh();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
