import { describe, expect, it } from "vitest";
import {
  EMPTY_SSH_FORM,
  createSshSession,
  submitSshForm,
  type CreateSshDeps,
  type SshConnectOpts,
  type SubmitSshDeps,
} from "./sshConnect";
import type { SshConnection } from "../../types";

// ---- createSshSession -----------------------------------------------------

function createHarness(opts?: { persist?: boolean; fail?: boolean }) {
  const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
  const panels: { id: string; component: string; title: string; params: Record<string, unknown> }[] =
    [];
  const errors: unknown[] = [];
  const deps: CreateSshDeps = {
    invoke: async (cmd, args) => {
      invoked.push({ cmd, args });
      if (opts?.fail) throw new Error("boom");
      return 7 as never;
    },
    addPanel: (p) => panels.push(p),
    getPersistScrollback: () => opts?.persist ?? false,
    now: () => 1234,
    onError: (e) => errors.push(e),
  };
  return { invoked, panels, errors, deps };
}

const PW_CONN: SshConnectOpts = {
  title: "prod",
  host: "example.com",
  port: 2222,
  username: "root",
  authKind: "password",
  password: "s3cret",
  connectionId: "cid-1",
};

describe("createSshSession", () => {
  it("비밀은 ssh_create 인자에만 — panel params에 절대 안 들어간다 (F8)", async () => {
    const h = createHarness();
    await createSshSession({ ...PW_CONN, passphrase: "pp" }, h.deps);

    expect(h.invoked[0].cmd).toBe("ssh_create");
    expect(h.invoked[0].args.password).toBe("s3cret");
    expect(h.invoked[0].args.passphrase).toBe("pp");

    const params = h.panels[0].params;
    expect(Object.keys(params)).not.toContain("password");
    expect(Object.keys(params)).not.toContain("passphrase");
    expect(JSON.stringify(params)).not.toContain("s3cret");
    expect(JSON.stringify(params)).not.toContain("pp");
    // 재접속에 필요한 건 keychain 조회용 connectionId뿐.
    expect(params.connectionId).toBe("cid-1");
    expect(params.sessionId).toBe(7);
  });

  it("persistKey는 opt-in일 때만 panel id, 기본은 null (F11)", async () => {
    const off = createHarness({ persist: false });
    await createSshSession(PW_CONN, off.deps);
    expect(off.invoked[0].args.persistKey).toBeNull();

    const on = createHarness({ persist: true });
    await createSshSession(PW_CONN, on.deps);
    expect(on.invoked[0].args.persistKey).toBe("ssh-1234");
    expect(on.panels[0].id).toBe("ssh-1234");
  });

  it("ssh_create 실패 시 패널을 열지 않고 오류를 표면화한다", async () => {
    const h = createHarness({ fail: true });
    await createSshSession(PW_CONN, h.deps);
    expect(h.panels).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
  });

  it("옵션 미지정 비밀·경로는 undefined가 아니라 null로 넘어간다", async () => {
    const h = createHarness();
    await createSshSession(
      { title: "t", host: "h", port: 22, username: "u", authKind: "agent" },
      h.deps,
    );
    const a = h.invoked[0].args;
    expect(a.password).toBeNull();
    expect(a.passphrase).toBeNull();
    expect(a.keyPath).toBeNull();
    expect(a.connectionId).toBeNull();
  });
});

// ---- submitSshForm --------------------------------------------------------

function submitHarness(opts?: { storeFails?: boolean }) {
  const stored: { id: string; secret: string }[] = [];
  const upserted: SshConnection[] = [];
  const connects: SshConnectOpts[] = [];
  const notices: string[] = [];
  const order: string[] = [];
  const deps: SubmitSshDeps = {
    storeSecret: async (id, secret) => {
      order.push("store");
      if (opts?.storeFails) throw new Error("keychain denied");
      stored.push({ id, secret });
    },
    upsertConnection: (c) => {
      order.push("upsert");
      upserted.push(c);
    },
    connect: async (o) => {
      order.push("connect");
      connects.push(o);
    },
    notify: (m) => {
      order.push("notify");
      notices.push(m);
    },
    closeDialog: () => order.push("close"),
    newId: () => "cid-fixed",
  };
  return { stored, upserted, connects, notices, order, deps };
}

describe("submitSshForm", () => {
  it("저장 성공: 키체인 저장 → 연결 저장 → 다이얼로그 닫기 → 접속", async () => {
    const h = submitHarness();
    await submitSshForm(
      { ...EMPTY_SSH_FORM, host: " example.com ", username: " root ", password: "pw" },
      h.deps,
    );
    expect(h.order).toEqual(["store", "upsert", "close", "connect"]);
    expect(h.stored).toEqual([{ id: "cid-fixed", secret: "pw" }]);
    expect(h.upserted[0]).toMatchObject({
      id: "cid-fixed",
      host: "example.com", // trim
      username: "root",
      has_stored_secret: true,
    });
    expect(h.connects[0].connectionId).toBe("cid-fixed");
  });

  it("키체인 실패: 저장된 연결을 만들지 않고 세션 전용으로만 접속 (F9·P3-R3)", async () => {
    const h = submitHarness({ storeFails: true });
    await submitSshForm(
      { ...EMPTY_SSH_FORM, host: "example.com", username: "root", password: "pw" },
      h.deps,
    );
    // 평문 폴백 없음: upsert가 없어야 재접속 때 깨질 연결이 남지 않는다.
    expect(h.upserted).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
    // 그래도 이번 접속은 진행되고, 비밀은 이 호출에만 실린다.
    expect(h.connects).toHaveLength(1);
    expect(h.connects[0].connectionId).toBeNull();
    expect(h.connects[0].password).toBe("pw");
  });

  it("label 미입력이면 user@host 폴백 (저장·탭 제목 모두)", async () => {
    const h = submitHarness();
    await submitSshForm(
      { ...EMPTY_SSH_FORM, host: "example.com", username: "root", password: "pw" },
      h.deps,
    );
    expect(h.upserted[0].label).toBe("root@example.com");
    expect(h.connects[0].title).toBe("root@example.com");

    const h2 = submitHarness();
    await submitSshForm(
      { ...EMPTY_SSH_FORM, label: "  prod  ", host: "h", username: "u", password: "pw" },
      h2.deps,
    );
    expect(h2.connects[0].title).toBe("prod");
  });

  it("host/username이 비면 아무 부수효과도 없다", async () => {
    const h = submitHarness();
    await submitSshForm({ ...EMPTY_SSH_FORM, host: "  ", username: "root" }, h.deps);
    await submitSshForm({ ...EMPTY_SSH_FORM, host: "h", username: "  " }, h.deps);
    expect(h.order).toEqual([]);
  });

  it("저장 끄면 키체인·연결 저장 없이 세션 전용 접속", async () => {
    const h = submitHarness();
    await submitSshForm(
      { ...EMPTY_SSH_FORM, save: false, host: "h", username: "u", password: "pw" },
      h.deps,
    );
    expect(h.order).toEqual(["close", "connect"]);
    expect(h.connects[0].connectionId).toBeNull();
  });

  it("비밀 없는 폼은 키체인을 건드리지 않고 저장된다 (agent 인증)", async () => {
    const h = submitHarness();
    await submitSshForm({ ...EMPTY_SSH_FORM, authKind: "agent", host: "h", username: "u" }, h.deps);
    expect(h.order).toEqual(["upsert", "close", "connect"]);
    expect(h.upserted[0].has_stored_secret).toBe(false);
    expect(h.upserted[0].key_path).toBeNull();
  });

  it("publickey는 passphrase가 비밀이고 password는 넘기지 않는다", async () => {
    const h = submitHarness();
    await submitSshForm(
      {
        ...EMPTY_SSH_FORM,
        authKind: "publickey",
        host: "h",
        username: "u",
        keyPath: " ~/.ssh/id_ed25519 ",
        passphrase: "pp",
        password: "leftover-from-typing",
      },
      h.deps,
    );
    expect(h.stored).toEqual([{ id: "cid-fixed", secret: "pp" }]);
    expect(h.upserted[0].key_path).toBe("~/.ssh/id_ed25519");
    expect(h.connects[0].password).toBeNull();
    expect(h.connects[0].passphrase).toBe("pp");
    expect(h.connects[0].keyPath).toBe("~/.ssh/id_ed25519");
  });

  it("포트는 숫자만, 파싱 불가·0은 22", async () => {
    const h = submitHarness();
    await submitSshForm({ ...EMPTY_SSH_FORM, port: "2222", host: "h", username: "u" }, h.deps);
    await submitSshForm({ ...EMPTY_SSH_FORM, port: "abc", host: "h", username: "u" }, h.deps);
    await submitSshForm({ ...EMPTY_SSH_FORM, port: "", host: "h", username: "u" }, h.deps);
    expect(h.connects.map((c) => c.port)).toEqual([2222, 22, 22]);
  });

  it("EMPTY_SSH_FORM 기본값 — 비밀번호 인증·22포트·저장 on", () => {
    expect(EMPTY_SSH_FORM).toEqual({
      label: "",
      host: "",
      port: "22",
      username: "",
      authKind: "password",
      keyPath: "",
      password: "",
      passphrase: "",
      save: true,
    });
    // NOTE(리뷰 P3-8): 스프레드 불변성 단언은 JS 자체를 테스트하는 동어반복
    // 이라 제거 — 실계약(useSsh가 EMPTY_SSH_FORM을 복제해 폼을 리셋)은 렌더
    // 인프라 없이는 통과할 수 없어 기록로 남긴다.
  });
});
