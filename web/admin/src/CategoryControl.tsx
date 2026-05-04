import type { ItemState } from "./api";

type Props = {
    value: ItemState;
    onChange: (next: ItemState) => void;
    busy?: boolean;
    compact?: boolean;
};

// StateControl is the per-item control that flips an item between visible
// and hidden for the active profile (or back to unset). Three buttons:
// Visible / Hidden / Unset. Used by bulk, search, activity, and swipe.
export default function StateControl({ value, onChange, busy, compact }: Props) {
    return (
        <div className={`cat-control${compact ? " compact" : ""}`}>
            <button
                type="button"
                disabled={busy}
                onClick={() => {
                    if (value !== "visible") onChange("visible");
                }}
                className={`cat-button cat-visible${value === "visible" ? " active" : ""}`}
                aria-pressed={value === "visible"}
            >
                Visible
            </button>
            <button
                type="button"
                disabled={busy}
                onClick={() => {
                    if (value !== "hidden") onChange("hidden");
                }}
                className={`cat-button cat-hidden${value === "hidden" ? " active" : ""}`}
                aria-pressed={value === "hidden"}
            >
                Hidden
            </button>
            <button
                type="button"
                disabled={busy}
                onClick={() => {
                    if (value !== null) onChange(null);
                }}
                className={`cat-button cat-unset${value === null ? " active" : ""}`}
                aria-pressed={value === null}
            >
                Unset
            </button>
        </div>
    );
}
