import { memo } from "react";
import { Check } from "@phosphor-icons/react";
import type { Item } from "jellybean-shared";
import { imageAuthSuffix } from "./auth";
import { posterWidthForViewport } from "./perfMode";

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

export type TileItem = Pick<
    Item,
    "Id" | "Name" | "Type" | "ImageTags" | "UserData"
>;

export type TileSize = "browse" | "library" | "cw";

type Props = {
    item: TileItem;
    size: TileSize;
    focused: boolean;
    onClick: () => void;
    onFocus: () => void;
    refCallback: (el: HTMLButtonElement | null) => void;
    showProgress?: boolean;
    /* When false, render a placeholder div instead of <img>. The
       LoAF data showed cheap-WebView image decode/raster as the
       dominant cost of cross-row arrow presses (1.5-1.8s frames
       with scripts=0). Browse passes priority=false for tiles in
       rows far from the focused row so we only decode images the
       kid is actually about to look at. */
    priority?: boolean;
};

function TileImpl({
    item,
    size,
    focused,
    onClick,
    onFocus,
    refCallback,
    showProgress = false,
    priority = true,
}: Props) {
    const tag = item.ImageTags?.Primary ?? "";
    // Poster width is adaptive: slow-perf devices stay at 130 (decode
    // cost dominates per kid CLAUDE.md); fast-perf scales by viewport
    // width and DPR. Cached per session inside the helper so the URL
    // stays stable across re-renders and the browser HTTP cache holds.
    const imageWidth = posterWidthForViewport();
    // <img> can't attach Authorization headers, so the bearer-auth
    // kid path passes token + userId as query params. The server's
    // parseBearer accepts both. Admin-cookie path returns "" suffix.
    const src = `/api/kids/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=${imageWidth}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ""
    }${imageAuthSuffix()}`;
    const isSeries = item.Type === "Series";
    const progress = item.UserData?.PlayedPercentage ?? 0;
    const isPlayed = !!item.UserData?.Played || progress >= 90;
    // Show progress bar only for "actually started, not yet watched"
    // items - matches the 5% threshold the watch menu uses to decide
    // Resume vs Play, so the bar's presence == "Resume is the action."
    const showProgressBar = showProgress && !isPlayed && progress >= 5;
    return (
        <button
            ref={refCallback}
            className={`tile tile-${size} ${focused ? "focused" : ""}`}
            onClick={onClick}
            onFocus={onFocus}
            tabIndex={focused ? 0 : -1}
            type="button"
        >
            <div
                className={`tile-poster${isPlayed && priority ? " is-watched" : ""}`}
            >
                {tag && priority ? (
                    <img
                        src={src}
                        alt={item.Name}
                        // t39: was loading="lazy", which blocks fetch
                        // on any <img> whose ancestor is display:none.
                        // After t38 the hint-prev / hint-next rows'
                        // .browse-row-items is display:none in steady
                        // state, so lazy meant their posters never
                        // started fetching - the kid arrowed onto a
                        // neighboring row and watched a cold load
                        // happen instead of seeing the cached image
                        // fade in. The `priority` prop already gates
                        // <img> presence to a small warm window around
                        // the focused row (default radius 2, grows
                        // 1/1.5s), so flipping to eager just pulls
                        // those warm-window tiles into the fetch
                        // pipeline immediately. Cold rows still don't
                        // render <img> at all (placeholder div above).
                        loading="eager"
                        decoding="async"
                    />
                ) : (
                    <div className="tile-poster-placeholder">
                        {priority ? item.Name : ""}
                    </div>
                )}
                {isSeries && (
                    <img
                        src="/player/tv-show.png"
                        alt=""
                        className="tile-badge tile-badge-tv"
                        aria-label="TV show"
                    />
                )}
                {/* Watched overlay: the poster dims via .is-watched and
                   we stamp a checkmark in the corner. Series Played
                   means "every episode watched"; movie Played means
                   "credits reached." Gated on `priority` so cold rows
                   (placeholder div, no <img> to dim) don't render a
                   badge floating on a blank tile - the badge appears
                   along with the warm-up's actual poster. */}
                {isPlayed && priority && (
                    <span
                        className="tile-watched-badge"
                        aria-label={
                            isSeries ? "Every episode watched" : "Watched"
                        }
                    >
                        <Check size={14} weight="bold" />
                    </span>
                )}
                {showProgressBar && (
                    <div
                        className="tile-progress"
                        style={{ width: `${progress}%` }}
                        aria-hidden
                    />
                )}
            </div>
            <div className="tile-title">
                <span className="tile-title-text">{item.Name}</span>
            </div>
        </button>
    );
}

// Custom equality: ignore callback identity. The parent passes fresh
// onClick/onFocus/refCallback closures every render; if memo used
// default shallow-equal, EVERY tile re-renders on every focus change.
// The closures only call stable refs (useNavigate's nav, setState
// updaters, sessionStorage writes), so reusing the previous closure
// is safe semantically. The prop comparisons we DO care about:
//   - item: identity changes when the row mutates (load-more)
//   - size: never changes for a given mount
//   - focused: the only prop that toggles during D-pad travel
//   - showProgress: stable per usage site
// On a typical D-pad arrow this re-renders only 2 tiles (the one
// losing focus + the one gaining it) instead of all ~440 in the page.
export default memo(TileImpl, (prev, next) =>
    prev.item === next.item &&
    prev.size === next.size &&
    prev.focused === next.focused &&
    prev.showProgress === next.showProgress &&
    prev.priority === next.priority,
);
