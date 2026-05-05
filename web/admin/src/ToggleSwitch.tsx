import { useId } from "react";

// iOS-style toggle. Used for Enable/Disable settings in the profile
// settings forms. Renders the label first (block-level) then the
// switch on the right so multiple toggles stack into a clean column.

type Props = {
    label: string;
    description?: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    /** State labels next to the track. Defaults to On / Off. */
    onLabel?: string;
    offLabel?: string;
};

export default function ToggleSwitch({
    label,
    description,
    checked,
    onChange,
    disabled,
    onLabel = "On",
    offLabel = "Off",
}: Props) {
    const id = useId();
    return (
        <label
            htmlFor={id}
            className={`toggle-switch ${disabled ? "disabled" : ""}`}
        >
            <div className="toggle-switch-text">
                <span className="toggle-switch-label">{label}</span>
                {description && (
                    <span className="toggle-switch-desc">{description}</span>
                )}
            </div>
            <span className="toggle-switch-control">
                <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span className="toggle-switch-track" aria-hidden>
                    <span className="toggle-switch-thumb" />
                </span>
                <span
                    className={`toggle-switch-state ${
                        checked ? "on" : "off"
                    }`}
                    aria-hidden
                >
                    {checked ? onLabel : offLabel}
                </span>
            </span>
        </label>
    );
}
