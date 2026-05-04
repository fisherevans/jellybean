import { type TypeFilter } from "./api";

type Props = {
    value: TypeFilter;
    onChange: (next: TypeFilter) => void;
    busy?: boolean;
};

const tabs: { value: TypeFilter; label: string }[] = [
    { value: "both", label: "Both" },
    { value: "movies", label: "Movies" },
    { value: "series", label: "TV Shows" },
];

// Three-way pill selector for "what kind of content am I looking at right
// now". Used in Bulk, Swipe, and Search; defaults to Both.
export default function TypeFilterPicker({ value, onChange, busy }: Props) {
    return (
        <div className="type-filter" role="tablist" aria-label="Content type">
            {tabs.map((t) => (
                <button
                    key={t.value}
                    role="tab"
                    type="button"
                    aria-selected={value === t.value}
                    disabled={busy}
                    onClick={() => {
                        if (value !== t.value) onChange(t.value);
                    }}
                    className={`type-filter-tab${value === t.value ? " active" : ""}`}
                >
                    {t.label}
                </button>
            ))}
        </div>
    );
}
