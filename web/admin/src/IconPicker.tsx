import { useState } from "react";
import { TAG_ICONS, TAG_ICON_ORDER, isTagIconName, type TagIconName } from "./tagIcons";

// IconPicker is the curated-Phosphor-icon grid used by the tag editor
// (and reusable elsewhere). Renders a search box + scrollable grid so
// the modal / panel doesn't grow to fit ~90 cells. Click a cell to
// select; click again to clear, or click the explicit "no icon" cell.
//
// Search filters by Phosphor name (case-insensitive substring) so an
// admin who knows the name (or part of it) can jump straight there.

type Props = {
    value: string;
    onChange: (next: string) => void;
    disabled?: boolean;
    label?: string;
    description?: string;
};

export default function IconPicker({
    value,
    onChange,
    disabled,
    label = "Icon",
    description = "Shown next to the row title in the kid app",
}: Props) {
    const [search, setSearch] = useState("");
    const q = search.trim().toLowerCase();
    const filtered: TagIconName[] = q
        ? TAG_ICON_ORDER.filter((n) => n.toLowerCase().includes(q))
        : TAG_ICON_ORDER;
    const currentValid = isTagIconName(value);
    return (
        <div className="tag-icon-picker">
            <div className="tag-icon-picker-label">
                {label}{" "}
                {description ? (
                    <span className="muted">{description}</span>
                ) : null}
            </div>
            <input
                type="search"
                className="tag-icon-search"
                placeholder="Filter icons (e.g. star, music)…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={disabled}
            />
            <div className="tag-icon-grid" role="radiogroup">
                <button
                    type="button"
                    className={`tag-icon-cell ${value === "" ? "selected" : ""}`}
                    onClick={() => onChange("")}
                    disabled={disabled}
                    role="radio"
                    aria-checked={value === ""}
                    aria-label="No icon"
                    title="No icon"
                >
                    <span className="tag-icon-cell-none">—</span>
                </button>
                {filtered.map((name) => {
                    const Icon = TAG_ICONS[name];
                    const selected = value === name;
                    return (
                        <button
                            key={name}
                            type="button"
                            className={`tag-icon-cell ${selected ? "selected" : ""}`}
                            onClick={() => onChange(name)}
                            disabled={disabled}
                            role="radio"
                            aria-checked={selected}
                            aria-label={name}
                            title={name}
                        >
                            <Icon weight="fill" aria-hidden />
                        </button>
                    );
                })}
                {filtered.length === 0 && (
                    <div className="muted tag-icon-empty">
                        No icons match “{search}”.
                    </div>
                )}
            </div>
            {currentValid && (
                <div className="tag-icon-picker-current muted">
                    Selected: <strong>{value}</strong>
                </div>
            )}
        </div>
    );
}
