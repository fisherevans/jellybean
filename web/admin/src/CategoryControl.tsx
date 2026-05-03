import { AGE_TIERS, AGE_LABELS, type AgeTier } from "./api";

type Props = {
    value: number | null;
    onChange: (next: number | null) => void;
    busy?: boolean;
    compact?: boolean;
};

// AgePicker is the per-item control that flips an item between age tiers
// (or back to uncategorized via "Skip"). Shared by the sweep, triage,
// search, and activity views.
export default function AgePicker({ value, onChange, busy, compact }: Props) {
    return (
        <div className={`cat-control${compact ? " compact" : ""}`}>
            {AGE_TIERS.map((age) => {
                const active = value === age;
                return (
                    <button
                        key={age}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                            if (!active) onChange(age);
                        }}
                        className={`cat-button cat-${ageBucketClass(age)}${active ? " active" : ""}`}
                        aria-pressed={active}
                        title={AGE_LABELS[age as AgeTier]}
                    >
                        {age === 18 ? "18+" : `${age}+`}
                    </button>
                );
            })}
            <button
                type="button"
                disabled={busy}
                onClick={() => {
                    if (value !== null) onChange(null);
                }}
                className={`cat-button cat-uncategorized${value === null ? " active" : ""}`}
                title="Mark uncategorized"
            >
                Skip
            </button>
        </div>
    );
}

function ageBucketClass(age: AgeTier): "kid" | "adult" {
    return age < 13 ? "kid" : "adult";
}
