import { type Item, type ItemState, type Tag, formatState } from "./api";
import StateControl from "./CategoryControl";
import { isUnknownLang, langName } from "./lang";
import TagKebab from "./TagKebab";

type Props = {
    item: Item;
    selected?: boolean;
    onSelect?: (e: React.MouseEvent) => void;
    onStateChange?: (next: ItemState) => void;
    onPreview?: (item: Item) => void;
    busy?: boolean;
    showSuggestion?: boolean;
    posterWidth?: number;
    leaving?: boolean;
    fixedHeight?: boolean;
    /** Active profile's default audio language; when set, items whose
     *  AudioLanguage differs are flagged. */
    expectedLanguage?: string;
    /** Fires after the tag kebab persists a change. Pages that hold
     *  an items array can patch the matching row's Tags field in
     *  place rather than refetching the whole list. */
    onTagsChanged?: (item: Item, newTags: Tag[]) => void;
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
    onPreview,
    busy,
    showSuggestion,
    posterWidth = DEFAULT_POSTER_WIDTH,
    leaving,
    fixedHeight,
    expectedLanguage,
    onTagsChanged,
}: Props) {
    const meta: string[] = [];
    if (item.ProductionYear) meta.push(String(item.ProductionYear));
    if (item.OfficialRating) meta.push(item.OfficialRating);
    const studios = (item.Studios ?? []).map((s) => s.Name).join(", ");
    const hasPoster = !!item.ImageTags?.Primary;
    const expected = (expectedLanguage ?? "").toLowerCase();
    const available = (item.AudioLanguages ?? [])
        .map((l) => l.toLowerCase())
        .filter(Boolean);
    const primary = (item.AudioLanguage ?? "").toLowerCase();
    // Mismatch only when the profile expects a language and the item has
    // *no* track in it. Multi-track items with the preferred language
    // available are not a mismatch even if it isn't the primary track,
    // since playback will switch to the matching audio.
    const langMismatch =
        !!expected && available.length > 0 && !available.includes(expected);
    // Badge shows what will actually play for this profile: the expected
    // language if available, otherwise the file's primary track.
    const lang =
        expected && available.includes(expected) ? expected : primary;

    const classes = [
        "item-card",
        selected ? "selected" : "",
        leaving ? "leaving" : "",
        fixedHeight ? "fixed-height" : "",
        langMismatch ? "lang-mismatch" : "",
    ].filter(Boolean).join(" ");

    return (
        <div className={classes}>
            <button
                type="button"
                className="item-card-body"
                onClick={onSelect}
                aria-pressed={!!selected}
            >
                <div className="item-card-poster-wrap" style={{ width: posterWidth }}>
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
                    {onPreview && (
                        <span
                            role="button"
                            tabIndex={0}
                            className="item-card-preview"
                            aria-label={`Preview ${item.Name}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onPreview(item);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onPreview(item);
                                }
                            }}
                        >
                            ▶
                        </span>
                    )}
                </div>
                <div className="item-card-text">
                    <div className="item-card-name">{item.Name}</div>
                    {meta.length > 0 && (
                        <div className="item-card-meta">
                            {meta.join(" · ")}
                            {lang && (
                                <span
                                    className={`lang-badge ${
                                        langMismatch
                                            ? "lang-badge-mismatch"
                                            : isUnknownLang(lang)
                                            ? "lang-badge-unknown"
                                            : ""
                                    }`}
                                    title={
                                        langMismatch
                                            ? `Audio: ${langName(lang)}; profile default is ${langName(expected)}`
                                            : `Audio: ${langName(lang)}`
                                    }
                                >
                                    {langName(lang)}
                                </span>
                            )}
                        </div>
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
            <TagKebab
                item={item}
                onChanged={(tags) => onTagsChanged?.(item, tags)}
            />
        </div>
    );
}
