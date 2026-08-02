/**
 * 새 SSH 연결 다이얼로그 (MainArea에서 순수 이동, P5 F-c).
 * 비밀 입력은 폼 state에만 머문다 — 저장·전달 규칙은 `sshConnect`가 갖는다.
 */
import type { SshForm } from "./sshConnect";

export function SshDialog({
  form,
  setForm,
  onSubmit,
}: {
  form: SshForm;
  setForm: (f: SshForm | null) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="claude-modal-backdrop" onClick={() => setForm(null)}>
      <div className="claude-modal ssh-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="claude-modal-title">새 SSH 연결</div>
        <label className="ssh-field">
          <span>라벨 (탭 이름)</span>
          <input
            value={form.label}
            placeholder={`${form.username || "user"}@${form.host || "host"}`}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </label>
        <div className="ssh-row">
          <label className="ssh-field ssh-grow">
            <span>호스트</span>
            <input
              value={form.host}
              autoFocus
              placeholder="example.com"
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>
          <label className="ssh-field ssh-port">
            <span>포트</span>
            <input
              value={form.port}
              inputMode="numeric"
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </label>
        </div>
        <label className="ssh-field">
          <span>사용자명</span>
          <input
            value={form.username}
            placeholder="root"
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>
        <label className="ssh-field">
          <span>인증 방식</span>
          <select
            value={form.authKind}
            onChange={(e) =>
              setForm({
                ...form,
                authKind: e.target.value as SshForm["authKind"],
              })
            }
          >
            <option value="password">비밀번호</option>
            <option value="publickey">PEM 키</option>
            <option value="agent">ssh-agent</option>
          </select>
        </label>
        {form.authKind === "password" && (
          <label className="ssh-field">
            <span>비밀번호</span>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
        )}
        {form.authKind === "publickey" && (
          <>
            <label className="ssh-field">
              <span>키 파일 경로</span>
              <input
                value={form.keyPath}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
              />
            </label>
            <label className="ssh-field">
              <span>passphrase (암호화된 키만)</span>
              <input
                type="password"
                value={form.passphrase}
                onChange={(e) => setForm({ ...form, passphrase: e.target.value })}
              />
            </label>
          </>
        )}
        <label className="ssh-save-row">
          <input
            type="checkbox"
            checked={form.save}
            onChange={(e) => setForm({ ...form, save: e.target.checked })}
          />
          <span>이 연결 저장 (비밀번호/passphrase는 OS 키체인에)</span>
        </label>
        <div className="ssh-dialog-actions">
          <button className="claude-modal-opt" onClick={onSubmit}>
            접속
          </button>
          <button
            className="claude-modal-opt claude-modal-cancel"
            onClick={() => setForm(null)}
          >
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
