import { EFFORT_CHOICES, MODEL_CHOICES } from "../state/agentOptions";

/**
 * 모델/강도 선택 `<select>` 두 개 — 아카이브 설정과 새 세션 옵션 팝오버가
 * 공유한다(원래 ArchivePanel 안에만 있던 것을 승격).
 *
 * 스타일을 들고 있지 않은 것이 의도다: 호출자마다 행 레이아웃(`.archive-
 * settings-row` vs `.agent-opt-row`)이 다르고, 공유해야 하는 건 **어휘와
 * 옵션 구성**이지 배치가 아니다. 그래서 이 컴포넌트는 `<select>` 하나만 그리고
 * 라벨·행 래퍼는 호출자가 소유한다.
 */

/** `""` = 기본(미지정), `"custom"` = 직접 입력(호출자가 처리). */
export function ModelSelect({
  value,
  defaultLabel,
  allowCustom = false,
  onChange,
  title,
  ariaLabel,
}: {
  value: string;
  defaultLabel: string;
  allowCustom?: boolean;
  onChange: (v: string) => void;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      value={value}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{defaultLabel}</option>
      {MODEL_CHOICES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      {allowCustom && <option value="custom">직접 입력…</option>}
    </select>
  );
}

/** `""` = 기본(미지정 — 플래그 미부착). */
export function EffortSelect({
  value,
  defaultLabel,
  onChange,
  title,
  ariaLabel,
}: {
  value: string;
  defaultLabel: string;
  onChange: (v: string) => void;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      value={value}
      title={title}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{defaultLabel}</option>
      {EFFORT_CHOICES.map((ef) => (
        <option key={ef} value={ef}>
          {ef}
        </option>
      ))}
    </select>
  );
}
