/**
 * SSH 연결 생성 로직 — MainArea에서 순수 이동 (P5 F-c).
 *
 * 부수효과(invoke·addPanel·alert·UUID·시계)는 전부 주입받는다: 비밀 취급
 * 규칙(F8·F9/P3-R3)이 단위 테스트로 고정된다. React 의존 없음.
 */
import type { SshConnection } from "../../types";

/** Transient new-connection dialog form state. The secret fields never enter
 * panel params or workspace.json — they go to `ssh_create` (this session) and,
 * when "save" is on, to the OS keychain. */
export interface SshForm {
  label: string;
  host: string;
  port: string;
  username: string;
  authKind: "password" | "publickey" | "agent";
  keyPath: string;
  password: string;
  passphrase: string;
  save: boolean;
}

export const EMPTY_SSH_FORM: SshForm = {
  label: "",
  host: "",
  port: "22",
  username: "",
  authKind: "password",
  keyPath: "",
  password: "",
  passphrase: "",
  save: true,
};

export interface HostKeyPrompt {
  id: number;
  host: string;
  port: number;
  fingerprint: string;
}

export interface SshConnectOpts {
  title: string;
  host: string;
  port: number;
  username: string;
  authKind: "password" | "publickey" | "agent";
  keyPath?: string | null;
  connectionId?: string | null;
  password?: string | null;
  passphrase?: string | null;
}

export interface CreateSshDeps {
  invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
  addPanel: (p: {
    id: string;
    component: string;
    title: string;
    params: Record<string, unknown>;
  }) => void;
  /** 호출 **시점**의 값 — 구독값이 아니라 store 즉시 조회(원 동작 보존). */
  getPersistScrollback: () => boolean;
  /** panel id 생성용 시계 (테스트 주입). */
  now: () => number;
  onError: (err: unknown) => void;
}

/**
 * Create an SSH session (backend connects async) and open a panel attached to
 * it. The secret (password/passphrase) is passed to `ssh_create` only — it is
 * NOT placed in panel params (which persist in the layout): reconnect after a
 * restart pulls the secret from the keychain via `connectionId` (review F8).
 */
export async function createSshSession(o: SshConnectOpts, deps: CreateSshDeps): Promise<void> {
  try {
    // Generate the panel id up front so it can double as the scrollback
    // persistence key (opt-in — review F11).
    const panelId = `ssh-${deps.now()}`;
    const persistKey = deps.getPersistScrollback() ? panelId : null;
    const id = await deps.invoke<number>("ssh_create", {
      host: o.host,
      port: o.port,
      username: o.username,
      authKind: o.authKind,
      password: o.password ?? null,
      keyPath: o.keyPath ?? null,
      passphrase: o.passphrase ?? null,
      connectionId: o.connectionId ?? null,
      persistKey,
      cols: 80,
      rows: 24,
    });
    deps.addPanel({
      id: panelId,
      component: "ssh",
      title: o.title,
      params: {
        kind: "ssh",
        title: o.title,
        sessionId: id,
        host: o.host,
        port: o.port,
        username: o.username,
        authKind: o.authKind,
        keyPath: o.keyPath ?? null,
        connectionId: o.connectionId ?? null,
      },
    });
  } catch (err) {
    deps.onError(err);
  }
}

export interface SubmitSshDeps {
  /** OS 키체인에 비밀 저장 (`ssh_store_secret`). 거부는 throw. */
  storeSecret: (id: string, secret: string) => Promise<void>;
  upsertConnection: (c: SshConnection) => void;
  connect: (o: SshConnectOpts) => Promise<void>;
  /** 저장 실패 안내 (alert). */
  notify: (msg: string) => void;
  /** 다이얼로그·메뉴 닫기 — connect **직전**에 부른다(원 순서 보존). */
  closeDialog: () => void;
  newId: () => string;
}

/**
 * Submit the new-connection dialog: optionally save (keychain secret + store
 * metadata), then connect.
 *
 * 저장 실패는 **연결 자체를 막지 않는다**: 세션 전용으로 접속하되 저장된 연결은
 * 만들지 않는다 — 평문 폴백 없음(리뷰 F9), 재접속 때 깨질 연결을 남기지 않음
 * (P3-R3).
 */
export async function submitSshForm(f: SshForm, deps: SubmitSshDeps): Promise<void> {
  const host = f.host.trim();
  const username = f.username.trim();
  if (!host || !username) return; // minimal validation; dialog enforces more
  const port = Number(f.port) || 22;
  const label = f.label.trim() || `${username}@${host}`;
  const secret = f.authKind === "password" ? f.password : f.passphrase;

  let connectionId: string | undefined;
  if (f.save) {
    const cid = deps.newId();
    let storeOk = true;
    if (secret) {
      // No plaintext fallback (review F9): if the keychain rejects, we do NOT
      // create a saved connection (it would be broken on reconnect — P3-R3).
      try {
        await deps.storeSecret(cid, secret);
      } catch {
        storeOk = false;
      }
    }
    if (!secret || storeOk) {
      connectionId = cid;
      deps.upsertConnection({
        id: cid,
        label,
        host,
        port,
        username,
        auth_kind: f.authKind,
        key_path: f.authKind === "publickey" ? f.keyPath.trim() || null : null,
        has_stored_secret: !!secret,
      });
    } else {
      deps.notify(
        "OS 키체인에 비밀번호를 저장하지 못했습니다. 이 연결은 저장하지 않고 세션 전용으로 접속합니다.",
      );
    }
  }
  deps.closeDialog();
  await deps.connect({
    title: label,
    host,
    port,
    username,
    authKind: f.authKind,
    keyPath: f.authKind === "publickey" ? f.keyPath.trim() || null : null,
    connectionId: connectionId ?? null,
    password: f.authKind === "password" ? f.password : null,
    passphrase: f.authKind === "publickey" ? f.passphrase : null,
  });
}
