import { type Item } from "./api";
import CategoryControl from "./CategoryControl";

type Props = {
    item: Item;
    selected?: boolean;
    onSelect?: (e: React.MouseEvent) => void;
    onCategoryChange?: (next: Item["Category"]) => void;
    busy?: boolean;
    showSuggestion?: boolean;
};

// ItemCard is the shared visual for a single library item across the
// curation views. The sweep view wires up onSelect for shift-click range
// selection; the search/activity views wire up onCategoryChange directly.
export default function ItemCard({
    item,
    selected,
    onSelect,
    onCategoryChange,
    busy,
    showSuggestion,
}: Props) {
    const meta: string[] = [];
    if (item.ProductionYear) meta.push(String(item.ProductionYear));
    if (item.OfficialRating) meta.push(item.OfficialRating);
    const studios = (item.Studios ?? []).map((s) => s.Name).join(", ");

    return (
        <div className={`item-card${selected ? " selected" : ""}`}>
            <button
                type="button"
                className="item-card-body"
                onClick={onSelect}
                aria-pressed={!!selected}
            >
                <div className="item-card-name">{item.Name}</div>
                {meta.length > 0 && (
                    <div className="item-card-meta">{meta.join(" · ")}</div>
                )}
                {studios && <div className="item-card-studios">{studios}</div>}
                {showSuggestion && item.Suggestion && (
                    <div className={`item-card-suggestion sugg-${item.Suggestion.category}`}>
                        guess: <strong>{item.Suggestion.category}</strong>{" "}
                        ({Math.round(item.Suggestion.confidence * 100)}%)
                        {item.Suggestion.reasoning?.length ? (
                            <span className="sugg-why">
                                {" "}
                                — {item.Suggestion.reasoning.join("; ")}
                            </span>
                        ) : null}
                    </div>
                )}
            </button>
            {onCategoryChange && (
                <CategoryControl
                    value={item.Category}
                    onChange={onCategoryChange}
                    busy={busy}
                    compact
                />
            )}
        </div>
    );
}
