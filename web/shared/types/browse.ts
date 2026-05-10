// Wire shape for /api/kids/browse and the admin layout-preview endpoint.
// The kid Browse screen and the admin layout preview both render the
// same response.

import type { Item } from "./item";

/**
 * BrowseItem is the per-tile payload in a browse row. The server emits
 * a subset of Item fields - no Genres / Studios / etc. - to keep the
 * row response small for slow TVs.
 *
 * `ProductionYear` and `RunTimeTicks` are present so the M8 browse
 * hero panel can render the year + runtime line synchronously off the
 * focused tile without a follow-up `/items/:id` fetch.
 */
export type BrowseItem = Pick<
    Item,
    | "Id"
    | "Name"
    | "Type"
    | "ProductionYear"
    | "RunTimeTicks"
    | "ImageTags"
    | "UserData"
>;

/**
 * BrowseRow is one horizontally-scrolling strip on the kid Browse
 * screen. type is the layout-row type (continue_watching, favorites,
 * tag, tag_fanout, recently_added, random_unwatched, watch_again).
 */
export interface BrowseRow {
    rowId: number;
    type: string;
    title: string;
    subtitle?: string;
    /**
     * Optional Phosphor icon name set by the server. "Heart" for the
     * favorites row; the tag's own icon for tag / tag_fanout rows when
     * configured. Empty/missing = no icon.
     */
    icon?: string;
    /**
     * True when more items are available beyond what was returned.
     * Drives the terminal button: "Load more" (true) vs "Loop back to
     * start" (false). Set by random_unwatched + recently_added; every
     * other row type stays false.
     */
    hasMore?: boolean;
    items: BrowseItem[];
}

/** BrowseResponse is the body returned by /api/kids/browse. */
export interface BrowseResponse {
    layoutId: number;
    layoutName: string;
    profileId: number;
    rows: BrowseRow[];
}
