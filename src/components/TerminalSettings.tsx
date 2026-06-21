import { useAppStore } from "../state/store";
import { TERM_PRESETS, TERM_EDITABLE, xtermTheme } from "./xtermTheme";

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

        <div className="ts-foot">
          <button className="git-btn" onClick={() => setTermColors(null)}>
            기본값으로 초기화
          </button>
        </div>
      </div>
    </div>
  );
}
