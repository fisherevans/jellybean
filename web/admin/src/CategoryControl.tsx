import { type Item } from "./api";

type Props = {
    value: Item["Category"];
    onChange: (next: Item["Category"]) => void;
    busy?: boolean;
    compact?: boolean;
};

const labels: Record<Item["Category"], string> = {
    kid: "Kid",
    adult: "Adult",
    uncategorized: "Skip",
};

const order: Item["Category"][] = ["kid", "adult", "uncategorized"];

// CategoryControl is a three-button row that flips an item between kid /
// adult / uncategorized. Used by the sweep, triage, and search views.
export default function CategoryControl({ value, onChange, busy, compact }: Props) {
    return (
        <div className={`cat-control${compact ? " compact" : ""}`}>
            {order.map((c) => (
                <button
                    key={c}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                        if (c !== value) onChange(c);
                    }}
                    className={`cat-button cat-${c}${value === c ? " active" : ""}`}
                    aria-pressed={value === c}
                >
                    {labels[c]}
                </button>
            ))}
        </div>
    );
}
