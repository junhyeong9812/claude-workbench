import { useEffect, useState } from "react";
import { useAppStore } from "../state/store";
import { TERM_PRESETS, TERM_EDITABLE, xtermTheme } from "./xtermTheme";
import {
  readNotifPrefs,
  setNotifEnabled,
  setSoundEnabled,
  ensureNotifyPermission,
  refreshNotifyPermission,
  notifyPermissionState,
  type NotifyPermission,
  primeAudio,
} from "../state/notify";

/**
 * Terminal color customization dialog: pick a named preset, or set individual
 * colors via a swatch picker or a hex code field. Changes apply live to every
 * terminal (stored as overrides merged over the app theme base).
 */
export function TerminalSettings({ onClose }: { onClose: () => void }) {
  const theme = useAppStore((s) => s.theme);
  const termColors = useAppStore((s) => s.termColors);
  const setTermColors = useAppStore((s) => s.setTermColors);
  const effective = xtermTheme(theme, termColors); // currently shown palette

  const setKey = (key: string, value: string) =>
    setTermColors({ ...(termColors ?? {}), [key]: value });

  // Attention alert/sound toggles (P4). Persisted to localStorage (same pattern
  // as the rest of the app); the notifier reads them at fire time. Both default
  // on. Local state so the checkboxes reflect toggles immediately.
  const [notif, setNotif] = useState(() => readNotifPrefs());
  const toggleNotif = (on: boolean) => {
    setNotifEnabled(on);
    setNotif((p) => ({ ...p, notifEnabled: on }));
  };
  const toggleSound = (on: boolean) => {
    setSoundEnabled(on);
    setNotif((p) => ({ ...p, soundEnabled: on }));
  };

  // OS-notification permission status (S13). The fire path never re-prompts once
  // denied, so surface the state here and offer an explicit request — a user
  // gesture, the reliable moment to both request permission and resume the
  // AudioContext (autoplay policy) so later tones aren't blocked.
  const [perm, setPerm] = useState<NotifyPermission>(notifyPermissionState());
  useEffect(() => {
    void refreshNotifyPermission().then(setPerm);
  }, []);
  const requestPerm = () => {
    primeAudio(); // user gesture — unblock tones
    // Interactive: retries even after a cached denial/API failure; re-read the
    // cache afterwards so "failed" (API threw) shows as such, not as 거부됨.
    void ensureNotifyPermission(true).then(() => setPerm(notifyPermissionState()));
  };
  const permLabel =
    perm === "granted"
      ? "허용됨"
      : perm === "denied"
        ? "거부됨 (OS 설정에서 변경)"
        : perm === "failed"
          ? "요청 실패 — 다시 시도 가능"
          : "미확인";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal term-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>터미널 색상</span>
          <button className="git-mini" title="닫기" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="ts-section">
          <div className="ts-label">프리셋</div>
          <div className="ts-presets">
            {Object.entries(TERM_PRESETS).map(([name, palette]) => (
              <button key={name} className="git-btn" onClick={() => setTermColors({ ...palette })}>
                {name}
              </button>
            ))}
            <button
              className="git-btn"
              title="앱 테마(라이트/다크)를 따라감"
              onClick={() => setTermColors(null)}
            >
              테마 따라가기
            </button>
          </div>
        </div>

        <div className="ts-section">
          <div className="ts-label">색 직접 지정 — 스와치 클릭 또는 #코드 입력</div>
          {TERM_EDITABLE.map(({ key, label }) => {
            const val = (effective[key] as string | undefined) ?? "#000000";
            return (
              <div key={key} className="ts-row">
                <span className="ts-key">{label}</span>
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(val) ? val : "#000000"}
                  onChange={(e) => setKey(key, e.target.value)}
                />
                <input
                  type="text"
                  className="ts-hex"
                  value={val}
                  spellCheck={false}
                  onChange={(e) => setKey(key, e.target.value)}
                />
              </div>
            );
          })}
        </div>

        <div className="ts-section">
          <div className="ts-label">세션 알림</div>
          <label className="ts-toggle">
            <input
              type="checkbox"
              checked={notif.notifEnabled}
              onChange={(e) => toggleNotif(e.target.checked)}
            />
            <span>OS 알림 — 세션이 입력 대기·작업 완료 시</span>
          </label>
          <label className="ts-toggle">
            <input
              type="checkbox"
              checked={notif.soundEnabled}
              onChange={(e) => toggleSound(e.target.checked)}
            />
            <span>소리 — 알림 톤 재생</span>
          </label>
          <div className="ts-row ts-perm-row">
            <span className="ts-key">OS 알림 권한: {permLabel}</span>
            <button
              className="git-btn"
              disabled={perm === "granted"}
              title="OS 알림 권한을 요청하고 알림 소리를 활성화합니다"
              onClick={requestPerm}
            >
              권한 요청
            </button>
          </div>
        </div>

        <div className="ts-foot">
          <button className="git-btn" onClick={() => setTermColors(null)}>
            기본값으로 초기화
          </button>
        </div>
      </div>
    </div>
  );
}
