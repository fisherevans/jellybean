// Canonical Item shape mirroring Jellyfin's PascalCase wire format.
// The server emits this shape (or a subset of it) on every endpoint
// that returns a content item: /api/admin/items, /api/kids/library,
// /api/kids/browse, /api/kids/watch/:id, etc. App-local types should
// pick the subset they actually consume rather than redeclaring fields.
//
// Optional fields are everything Jellyfin doesn't guarantee on every
// response shape - the server passes them through when present and
// drops them when absent, so optionality here matches reality on the
// wire.

/** Per-user playback state Jellyfin attaches to an item. */
export interface ItemUserData {
    /** 0..1 fraction; sometimes 0..100 depending on endpoint. */
    PlayedPercentage?: number;
    /** Resume position in 100ns ticks. */
    PlaybackPositionTicks?: number;
    /** True once Jellyfin considers the item watched. */
    Played?: boolean;
    /** ISO 8601 timestamp of the last play event. */
    LastPlayedDate?: string;
}

/** Studio entry on item.Studios. Id is sometimes absent. */
export interface ItemStudio {
    Name: string;
    Id?: string;
}

/** Image-tag map. Primary is the poster; Backdrop the wide art. */
export interface ItemImageTags {
    Primary?: string;
    Backdrop?: string;
}

/**
 * Item is the canonical content row. Movies and Series both flow through
 * this shape; episode-level fields (SeriesId, ParentIndexNumber, etc.)
 * are present only when Type is "Episode".
 */
export interface Item {
    /** Jellyfin item id (GUID-like string). */
    Id: string;
    /** Display name. */
    Name: string;
    /** "Movie" | "Series" | "Episode" | etc. */
    Type: string;

    /** Release year. */
    ProductionYear?: number;
    /** Total runtime in 100ns ticks. */
    RunTimeTicks?: number;
    /** ISO 8601 timestamp of when Jellyfin first indexed the item. */
    DateCreated?: string;
    /** MPAA-style content rating, e.g. "TV-Y", "PG". */
    OfficialRating?: string;
    /** Free-text genre list. */
    Genres?: string[];
    /** Studio list with optional ids. */
    Studios?: ItemStudio[];

    /** Per-image-kind hash used by the image proxy. */
    ImageTags?: ItemImageTags;
    /** Per-user playback / favorite state. */
    UserData?: ItemUserData;
    /** True when Jellyfin marks the item as a Jellyfin-side favorite. */
    IsFavorite?: boolean;

    /** Episode-only: the parent series id. */
    SeriesId?: string;
    /** Episode-only: the parent series display name. */
    SeriesName?: string;
    /** Episode-only: season number. */
    ParentIndexNumber?: number;
    /** Episode-only: episode number within the season. */
    IndexNumber?: number;

    /** Primary audio track ISO 639-3, "" if unknown. */
    AudioLanguage?: string;
    /** Every distinct audio language on the item. */
    AudioLanguages?: string[];
}
