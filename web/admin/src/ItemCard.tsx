import { type Item, type ItemState, formatState } from "./api";
import StateControl from "./CategoryControl";

type Props = {
    item: Item;
    selected?: boolean;
    onSelect?: (e: React.MouseEvent) => void;
    onStateChange?: (next: ItemState) => void;
    busy?: boolean;
    showSuggestion?: boolean;
    posterWidth?: number;
    leaving?: boolean;
    fixedHeight?: boolean;
};

const DEFAULT_POSTER_WIDTH = 80;

function posterURL(itemId: string, width: number): string {
    return `/api/admin/items/${itemId}/image?type=Primary&width=${width}`;
}

export default function ItemCard({
    item,
    selected,
    onSelect,
    onStateChange,
    busy,
    showSuggestion,
    posterWidth = DEFAULT_POSTER_WIDTH,
    leaving,
    fixedHeight,
}: Props) {
    const meta: string[] = [];
    if (item.ProductionYear) meta.push(String(item.ProductionYear));
    if (item.OfficialRating) meta.push(item.OfficialRating);
    const studios = (item.Studios ?? []).map((s) => s.Name).join(", ");
    const hasPoster = !!item.ImageTags?.Primary;

    const classes = [
        "item-card",
        selected ? "selected" : "",
        leaving ? "leaving" : "",
        fixedHeight ? "fixed-height" : "",
    ].filter(Boolean).join(" ");

    return (
        <div className={classes}>
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
                    <div className="item-card-meta">
                        Current: {formatState(item.State)}
                    </div>
                    {showSuggestion && item.Suggestion && (
                        <div className={`item-card-suggestion sugg-${item.Suggestion.bucket}`}>
                            guess: <strong>{item.Suggestion.bucket}</strong>{" "}
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
            {onStateChange && (
                <StateControl
                    value={item.State}
                    onChange={onStateChange}
                    busy={busy}
                    compact
                />
            )}
        </div>
    );
}
