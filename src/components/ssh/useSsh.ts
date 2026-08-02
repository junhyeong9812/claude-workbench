/**
 * SSH 연결 UI의 상태·부수효과 — MainArea에서 순수 이동 (P5 F-c).
 * 규칙(비밀 취급·저장 실패 처리)은 순수 모듈 `sshConnect`에 있다.
 */
import { useEffect, useState } from "react";
import type { DockviewApi } from "dockview-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../state/store";
import {
  EMPTY_SSH_FORM,
  createSshSession,
  submitSshForm,
  type HostKeyPrompt,
  type SshConnectOpts,
  type SshForm,
} from "./sshConnect";

export interface SshController {
  /** null = 새 연결 다이얼로그 닫힘. */
  sshForm: SshForm | null;
  setSshForm: (f: SshForm | null) => void;
  /** 빈 폼으로 새 연결 다이얼로그 열기. */
  openNewSshDialog: () => void;
  /** TOFU 확인 대기열 — [0]만 표시한다. */
  hostKeyQueue: HostKeyPrompt[];
  /** 저장된 연결로 바로 접속 (다이얼로그 없음). */
  connectSaved: (id: string) => void;
  /** 다이얼로그 제출 = (선택) 저장 후 접속. */
  submit: () => Promise<void>;
  answerHostKey: (accept: boolean) => void;
}

export function useSsh(deps: {
  /** 전역 알림/모달은 주 surface 1곳만. */
  isPrimary: boolean;
  /** 리마운트 stale 방지 — 호출마다 다시 읽는다. */
  getApi: () => DockviewApi | null;
  setTermMenu: (v: boolean) => void;
}): SshController {
  const { isPrimary, getApi, setTermMenu } = deps;
  const savedConnections = useAppStore((s) => s.savedConnections);
  const upsertConnection = useAppStore((s) => s.upsertConnection);
  const [sshForm, setSshForm] = useState<SshForm | null>(null);
  // A queue (not a single slot) so two connections prompting for unknown host
  // keys at once don't clobber each other — each is answered in turn (P3-R2).
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPrompt[]>([]);

  const connectSsh = async (o: SshConnectOpts) => {
    const api = getApi();
    if (!api) return;
    await createSshSession(o, {
      invoke: (cmd, args) => invoke(cmd, args),
      addPanel: (p) => api.addPanel(p),
      // 구독값이 아니라 호출 시점의 store 값 (원 동작 — review F11).
      getPersistScrollback: () => useAppStore.getState().persistScrollback,
      now: () => Date.now(),
      onError: (err) => console.error("ssh_create failed", err),
    });
  };

  // Connect to a previously saved connection (no dialog). The secret comes from
  // the keychain via the connection id.
  const connectSaved = (id: string) => {
    setTermMenu(false);
    const c = savedConnections.find((x) => x.id === id);
    if (!c) return;
    void connectSsh({
      title: c.label || `${c.username}@${c.host}`,
      host: c.host,
      port: c.port,
      username: c.username,
      authKind: c.auth_kind,
      keyPath: c.key_path ?? null,
      connectionId: c.id,
    });
  };

  const submit = async () => {
    const f = sshForm;
    if (!f) return;
    await submitSshForm(f, {
      storeSecret: async (id, secret) => {
        await invoke("ssh_store_secret", { id, secret });
      },
      upsertConnection,
      connect: connectSsh,
      notify: (msg) => alert(msg),
      closeDialog: () => {
        setSshForm(null);
        setTermMenu(false);
      },
      newId: () => crypto.randomUUID(),
    });
  };

  // Global host-key (TOFU) prompt: the backend raises `ssh-hostkey-prompt` for a
  // first-seen host; we enqueue it and show the fingerprint. Also surface SSH
  // connect/auth **failures** here — a not-yet-mounted panel can miss the
  // `ssh-status` event, so handling it globally guarantees it's never silent
  // (review P3-R1).
  useEffect(() => {
    if (!isPrimary) return; // 전역 알림/모달은 주 surface 1곳만
    const unPrompt = listen<HostKeyPrompt>("ssh-hostkey-prompt", (e) => {
      setHostKeyQueue((q) => [...q, e.payload]);
    });
    const unStatus = listen<{ id: number; phase: string; reason?: string | null }>(
      "ssh-status",
      (e) => {
        if (e.payload.phase === "failed") {
          alert(`SSH 연결 실패: ${e.payload.reason ?? "알 수 없는 오류"}`);
        }
      },
    );
    return () => {
      unPrompt.then((f) => f()).catch(() => {});
      unStatus.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answerHostKey = (accept: boolean) => {
    const p = hostKeyQueue[0];
    setHostKeyQueue((q) => q.slice(1));
    if (!p) return;
    invoke("ssh_hostkey_decision", { id: p.id, accept }).catch((e) => {
      // Surface the failure: the backend never got the decision, so the SSH
      // connect will hang — at least make the cause findable in devtools.
      console.error("ssh_hostkey_decision failed", e);
    });
  };

  return {
    sshForm,
    setSshForm,
    openNewSshDialog: () => setSshForm({ ...EMPTY_SSH_FORM }),
    hostKeyQueue,
    connectSaved,
    submit,
    answerHostKey,
  };
}
