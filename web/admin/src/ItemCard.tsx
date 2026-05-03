import { type Item } from "./api";
import CategoryControl from "./CategoryControl";

type Props = {
    item: Item;
    selected?: boolean;
    onSelect?: (e: React.MouseEvent) => void;
    onCategoryChange?: (next: Item["Category"]) => void;
    busy?: boolean;
    showSuggestion?: boolean;
    posterWidth?: number;
};

const DEFAULT_POSTER_WIDTH = 80;

// posterURL: the admin image proxy returns the Jellyfin Primary image
// without exposing the API key. Width hint controls server-side resize.
function posterURL(itemId: string, width: number): string {
    return `/api/admin/items/${itemId}/image?type=Primary&width=${width}`;
}

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
    posterWidth = DEFAULT_POSTER_WIDTH,
}: Props) {
    const meta: string[] = [];
    if (item.ProductionYear) meta.push(String(item.ProductionYear));
    if (item.OfficialRating) meta.push(item.OfficialRating);
    const studios = (item.Studios ?? []).map((s) => s.Name).join(", ");
    const hasPoster = !!item.ImageTags?.Primary;

    return (
        <div className={`item-card${selected ? " selected" : ""}`}>
            <button
                type="button"
                className="item-card-body"
                onClick={onSelect}
                aria-pressed={!!selected}
            >
                {hasPoster ? (
                    <img
                        className="item-card-poster"
                        src={posterURL(item.Id, posterWidth * 2)}
                        alt=""
                        loading="lazy"
                        style={{ width: posterWidth }}
                    />
                ) : (
                    <div
                        className="item-card-poster placeholder"
                        style={{ width: posterWidth, height: posterWidth * 1.5 }}
                    >
                        ?
                    </div>
                )}
                <div className="item-card-text">
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
                </div>
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
