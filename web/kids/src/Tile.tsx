import { imageAuthSuffix } from "./auth";

// Tile is the shared poster card used by both the Browse rows and the
// Library grid. Size variants:
//   - "browse" - row tiles, ~180px wide
//   - "library" - main grid tiles, ~150px wide (smaller than browse)
//   - "cw" - continue-watching strip on Library, same as browse
//
// Focus state is owned by the parent. The component sets `.focused`
// class which the CSS uses to apply the subtle zoom + glow. The parent
// is responsible for ensuring the wrapper that holds the tile has
// enough headroom (overflow: visible + padding) so the zoom doesn't
// clip - see styles.css `.tile-focus-padded` for the helper class.

export type TileItem = {
    Id: string;
    Name: string;
    Type: string;
    ImageTags?: { Primary?: string };
    UserData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
    };
};

export type TileSize = "browse" | "library" | "cw";

type Props = {
    item: TileItem;
    size: TileSize;
    focused: boolean;
    onClick: () => void;
    onFocus: () => void;
    refCallback: (el: HTMLButtonElement | null) => void;
    showProgress?: boolean;
};

const IMAGE_WIDTH: Record<TileSize, number> = {
    browse: 240,
    library: 200,
    cw: 220,
};

export default function Tile({
    item,
    size,
    focused,
    onClick,
    onFocus,
    refCallback,
    showProgress = false,
}: Props) {
    const tag = item.ImageTags?.Primary ?? "";
    // <img> can't attach Authorization headers, so the bearer-auth
    // kid path passes token + userId as query params. The server's
    // parseBearer accepts both. Admin-cookie path returns "" suffix.
    const src = `/api/kids/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=${IMAGE_WIDTH[size]}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ""
    }${imageAuthSuffix()}`;
    const isSeries = item.Type === "Series";
    const progress = item.UserData?.PlayedPercentage ?? 0;
    return (
        <button
            ref={refCallback}
            className={`tile tile-${size} ${focused ? "focused" : ""}`}
            onClick={onClick}
            onFocus={onFocus}
            tabIndex={focused ? 0 : -1}
            type="button"
        >
            <div className="tile-poster">
                {tag ? (
                    <img
                        src={src}
                        alt={item.Name}
                        loading="lazy"
                        decoding="async"
                    />
                ) : (
                    <div className="tile-poster-placeholder">{item.Name}</div>
                )}
                {isSeries && <span className="tile-badge">TV</span>}
                {showProgress && progress > 1 && progress < 99 && (
                    <div
                        className="tile-progress"
                        style={{ width: `${progress}%` }}
                        aria-hidden
                    />
                )}
            </div>
            <div className="tile-title">{item.Name}</div>
        </button>
    );
}
