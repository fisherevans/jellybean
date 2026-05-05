import { useId, useState } from "react";

// Slider with labelled snap points + a "Custom" pill that flips the
// row into number-input mode for fine control. Use inside settings
// forms.
//
// The formatted value (e.g. "12h45m") sits to the right of the slider.
// When the user picks the Custom pill, that label flips into a number
// input + suffix label so they can type an exact value.

type Props = {
    label: string;
    value: number;
    min: number;
    /** Max for the range slider. Use customMax to allow higher
     *  values via the Custom-mode number input. */
    max: number;
    /** When set, the Custom-mode number input accepts values up to
     *  customMax (>= max). Slider stays at `max`. Useful when most
     *  users want the slider's range but a few need to dial in
     *  larger values without the slider becoming useless. */
    customMax?: number;
    step?: number;
    snaps?: Array<{ value: number; label: string }>;
    suffix?: string;
    /** Optional formatter for the displayed value. Defaults to
     *  `${value}{suffix}` and is also used as the placeholder on
     *  the Custom-mode number input. */
    format?: (value: number) => string;
    /** When true, show a "Custom" pill that toggles the inline
     *  number input. The slider still drives the value either way;
     *  this just controls whether the right-side display is
     *  read-only formatted text or an editable number input. */
    allowCustom?: boolean;
    onChange: (v: number) => void;
};

export default function SnapSlider({
    label,
    value,
    min,
    max,
    customMax,
    step = 1,
    snaps,
    suffix,
    format,
    allowCustom,
    onChange,
}: Props) {
    const id = useId();
    const effectiveCustomMax = customMax ?? max;
    const onSnap = (snaps ?? []).some((s) => s.value === value);
    // If the value is past the slider's normal max (only possible
    // with customMax > max), force Custom mode so the user actually
    // sees and can edit the value.
    const valueOverflowsSlider = value > max;
    const [customMode, setCustomMode] = useState(
        !onSnap && (!!allowCustom || valueOverflowsSlider),
    );
    const showCustom = customMode || valueOverflowsSlider;
    // The slider's max never changes; if the value is above max
    // (custom-mode-only territory), pin the visual thumb at max.
    const sliderValue = Math.min(value, max);

    const formatValue = (v: number): string => {
        if (format) return format(v);
        return suffix ? `${v} ${suffix}` : String(v);
    };

    return (
        <div className="snap-slider">
            <label htmlFor={id} className="snap-slider-label">
                <span className="snap-slider-name">{label}</span>
            </label>
            <div className="snap-slider-row">
                <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={sliderValue}
                    onChange={(e) => onChange(Number(e.target.value))}
                    className="snap-slider-range"
                />
                {showCustom ? (
                    <div className="snap-slider-custom">
                        <input
                            type="number"
                            min={min}
                            max={effectiveCustomMax}
                            step={step}
                            value={value}
                            onChange={(e) => onChange(Number(e.target.value))}
                            className="snap-slider-number"
                        />
                        {suffix && (
                            <span className="snap-slider-suffix">
                                {suffix}
                            </span>
                        )}
                    </div>
                ) : (
                    <span className="snap-slider-current">
                        {formatValue(value)}
                    </span>
                )}
            </div>
            {((snaps && snaps.length > 0) || allowCustom) && (
                <div className="snap-slider-snaps">
                    {(snaps ?? []).map((s) => (
                        <button
                            key={s.value}
                            type="button"
                            className={`snap-pill ${
                                !customMode && value === s.value ? "active" : ""
                            }`}
                            onClick={() => {
                                setCustomMode(false);
                                onChange(s.value);
                            }}
                        >
                            {s.label}
                        </button>
                    ))}
                    {allowCustom && (
                        <button
                            type="button"
                            className={`snap-pill ${customMode ? "active" : ""}`}
                            onClick={() => setCustomMode((m) => !m)}
                        >
                            Custom
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

// Format a minute count as "Xh", "XhYm", or "Ym". Snaps to whole
// minutes; the caller controls increment. Examples:
//   1440 -> "24h"
//   60   -> "1h"
//   45   -> "45m"
//   765  -> "12h45m"
export function formatMinutesAsHM(min: number): string {
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (m === 0) return `${h}h`;
    return `${h}h${m}m`;
}
