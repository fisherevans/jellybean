import { useId } from "react";

// Slider with labelled snap points + a number-input next to it for
// custom values. The slider lets the admin pick a common value
// quickly; the number input keeps full precision available.

type Props = {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    snaps?: Array<{ value: number; label: string }>;
    suffix?: string;
    onChange: (v: number) => void;
};

export default function SnapSlider({
    label,
    value,
    min,
    max,
    step = 1,
    snaps,
    suffix,
    onChange,
}: Props) {
    const id = useId();
    return (
        <div className="snap-slider">
            <label htmlFor={id} className="snap-slider-label">
                <span className="snap-slider-name">{label}</span>
                <span className="snap-slider-current">
                    {value}
                    {suffix ? ` ${suffix}` : ""}
                </span>
            </label>
            <div className="snap-slider-row">
                <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                    className="snap-slider-range"
                />
                <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                    className="snap-slider-number"
                />
            </div>
            {snaps && snaps.length > 0 && (
                <div className="snap-slider-snaps">
                    {snaps.map((s) => (
                        <button
                            key={s.value}
                            type="button"
                            className={`snap-pill ${
                                value === s.value ? "active" : ""
                            }`}
                            onClick={() => onChange(s.value)}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
