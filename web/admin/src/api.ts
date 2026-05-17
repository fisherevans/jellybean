// Thin client over Jellybean's HTTP API. The session cookie is set by the
// server; we never touch it explicitly.

import type {
    BrowseResponse as SharedBrowseResponse,
    BrowseRow as SharedBrowseRow,
    QuickConnectPollResponse as SharedQCPollResponse,
    QuickConnectStartResponse as SharedQCStartResponse,
} from "jellybean-shared";

export type User = {
    id: string;
    name: string;
    admin: boolean;
};

// Per-profile visibility state for an item. null = unset (user hasn't
// decided yet for this profile).
export type ItemState = "visible" | "hidden" | null;

export type Suggestion = {
    bucket: "visible" | "hidden" | "unsure";
    confidence: number;
    reasoning: string[];
};

export type Item = {
    Id: string;
    Name: string;
    Type: string;
    OfficialRating?: string;
    ProductionYear?: number;
    /** ISO 8601 timestamp of when Jellyfin first indexed the item.
     *  Used for sort=added in Browse. */
    DateCreated?: string;
    /** Present only on the single-item detail endpoint. The list
     *  endpoint serves the slim DTO from itemcache, which doesn't
     *  carry Genres / Studios - those round-trip through Jellyfin's
     *  IncludeHeavyFields=true and aren't worth shipping on every
     *  list row (they dominated the pre-cache 14s payload). */
    Genres?: string[];
    Studios?: { Name: string; Id?: string }[];
    ImageTags?: { Primary?: string };
    AudioLanguage?: string; // ISO 639-3 of primary audio track ("" if unknown)
    AudioLanguages?: string[]; // every distinct audio language on the item; primary is always present when AudioLanguage is set
    /** Server-computed flag: true when the file has audio streams but
     *  no default track carries a non-empty language. Mirrors the
     *  badge logic used to live in ItemCard. The slim list DTO ships
     *  this so the UI doesn't need MediaStreams on the wire. */
    HasNonDefaultAudioLanguage?: boolean;

    State: ItemState; // visibility for the active profile (null = unset)
    Suggestion?: Suggestion;
    // Tags (M6) currently applied to this item. Always present in the
    // server response - empty array when the item has no tags. The
    // kebab menu uses this to seed its checkbox state.
    Tags?: { id: number; name: string }[];
};

export type ItemsResult = {
    Items: Item[];
    TotalRecordCount: number;
    ReturnedCount: number;
    StartIndex: number;
    NextStartIndex: number;
    HasMore: boolean;
    ProfileId: number;
};

export type StreamInfo = {
    streamUrl: string;
    itemId: string;
    itemName: string;
};

export type Profile = {
    id: number;
    name: string;
    description?: string;
    defaultLanguage: string; // ISO 639-3, e.g. "eng"
    createdAt: number;
    kidCount: number;
    visibleCount: number; // categorizations.state='visible' for this profile (orphans excluded)
    hiddenCount: number;
    layoutId?: number; // M8: profile's browse layout (null = use default)
};

export type ProfileInput = {
    name: string;
    description: string;
    defaultLanguage?: string;
    baseProfileId?: number; // create-only: copy categorizations from this profile
};

export type Kid = {
    id: number;
    name: string;
    profileId: number;
    profileName: string;
    jellyfinUserId: string;
    createdAt: number;
};

export type JellyfinUser = {
    id: string;
    name: string;
    isAdmin: boolean;
    isDisabled: boolean;
    assignedTo?: string; // existing kid name when this Jellyfin user is already mapped
};

// Tag is one row of the global tag namespace (M6). itemCount is
// included on list responses but missing on bare CRUD responses; the
// list view is the only place that surfaces it today.
export type Tag = {
    id: number;
    name: string;
    description?: string;
    sortOrder: number;
    // Optional Phosphor icon name from the curated allow-list (see
    // jellybean-shared/tagIcons.ts). Empty string = no icon.
    icon?: string;
    itemCount?: number;
    createdAt?: number;
    updatedAt?: number;
};

export type TagSort = "name" | "count" | "recent" | "manual";

// ProfileTagFilter is one row of profile_tag_filters (M6).
// always_visible / always_hidden override the per-profile
// categorization for any item carrying the tag.
export type ProfileFilterMode = "always_visible" | "always_hidden";
export type ProfileTagFilter = {
    tagId: number;
    tagName: string;
    mode: ProfileFilterMode;
    setAt: number;
};

// KidFavorite is one row of kid_favorites decorated with item
// metadata + a Visible flag run through EffectiveItemVisibility.
export type KidFavorite = {
    itemId: string;
    name?: string;
    type?: string;
    productionYear?: number;
    imageTags?: { Primary?: string };
    visible: boolean;
    missing?: boolean; // Jellyfin doesn't recognize this id any more
    createdAt: number;
};

// Layout (M8) is a named ordered set of rows that drives the kid
// Browse screen. Each row has a typed config blob.
export type RowType =
    | "continue_watching"
    | "favorites"
    | "tag"
    | "tag_fanout"
    | "recently_added"
    | "random_unwatched"
    | "watch_again";

export const ALL_ROW_TYPES: RowType[] = [
    "continue_watching",
    "favorites",
    "tag",
    "tag_fanout",
    "recently_added",
    "random_unwatched",
    "watch_again",
];

export const ROW_TYPE_LABELS: Record<RowType, string> = {
    continue_watching: "Continue Watching",
    favorites: "Favorites",
    tag: "Tag (single)",
    tag_fanout: "Tag fanout (one row per tag)",
    recently_added: "Recently Added",
    random_unwatched: "Random Unwatched",
    watch_again: "Watch Again",
};

// LayoutRowConfig is loosely-typed - the server validates the per-type
// shape. Admin UIs render type-specific forms and submit `config` as
// the JSON object Jellybean stores in layout_rows.config_json.
export type LayoutRowConfig = Record<string, unknown>;

export type LayoutRow = {
    id: number;
    position: number;
    type: RowType;
    title?: string;
    config: LayoutRowConfig;
    createdAt: number;
    updatedAt: number;
};

export type Layout = {
    id: number;
    name: string;
    description?: string;
    isDefault: boolean;
    profileCount: number;
    rows: LayoutRow[];
    createdAt: number;
    updatedAt: number;
};

// API key (M14). Bearer-token auth equivalent to admin cookie.
export type ProfileTimeLimits = {
    profileId: number;
    enabled: boolean;
    dailyCapMinutes: number;
    refillIntervalHours: number;
    dayStartHour: number;
    defaultShowCapMinutes?: number | null;
    defaultMovieStarts?: number | null;
    updatedAt?: string;
};

export type ContentTimeOverride = {
    profileId: number;
    jellyfinItemId: string;
    overrideCapMinutes?: number | null;
    overrideStarts?: number | null;
    updatedAt?: string;
};

export type BucketStatus = {
    availableMinutes: number;
    capMinutes: number;
    nextRefillAt: string;
    nextResetAt: string;
    locked: boolean;
    reason?: string;
};

export type MovieBucketStatus = {
    startsToday: number;
    startsAllowed: number;
    nextResetAt: string;
    locked: boolean;
    reason?: string;
};

export type TimeStatus = {
    enabled: boolean;
    global: BucketStatus;
    perShow: Record<string, BucketStatus>;
    perMovie: Record<string, MovieBucketStatus>;
};

export type ProfileBodyBreaks = {
    profileId: number;
    enabled: boolean;
    playMinutes: number;
    breakMinutes: number;
    voiceMessageTemplate: string;
    reasons: string[];
    updatedAt?: string;
};

export type ProfileViewingControls = {
    profileId: number;
    autoOffClockTime?: string;
    updatedAt?: string;
};

export type Mode = {
    id: number;
    profileId: number;
    name: string;
    scheduleDays: number;
    scheduleStartTime: string;
    scheduleEndTime: string;
    tagFiltersJson?: string;
    requiredTagIds: number[];
    timeLimitsJson?: string;
    /** Viewing-effect baselines applied while this mode is active.
     *  0 means "no effect." Replaces the previous viewingControlsJson
     *  blob - dim + warm tint live as real columns now. */
    dimPercent: number;
    warmTintPercent: number;
    layoutId?: number | null;
    themeKey: string;
    enterVoiceMessage?: string;
    exitVoiceMessage?: string;
    createdAt?: string;
    updatedAt?: string;
};

export type Channel = {
    id: number;
    profileId: number;
    name: string;
    description?: string;
    badgeText?: string;
    badgeColor?: string;
    sortOrder:
        | "random"
        | "distributed_random"
        | "round_robin_tags"
        | "in_order";
    tagIds: number[];
    itemIds: string[];
    createdAt?: string;
    updatedAt?: string;
};

export type APIKey = {
    id: number;
    name: string;
    createdAt: number;
    lastUsedAt?: number;
    revokedAt?: number;
};

export type APIAccessLogEntry = {
    id: number;
    keyId?: number;
    method: string;
    path: string;
    status: number;
    occurredAt: number;
};

// BrowseRow / BrowseResponse is what the admin preview / kid browse
// endpoint returns. The shared shape uses BrowseItem (a Pick of Item
// without the admin-only Suggestion / Tags fields); admin overlays the
// admin-flavored Item back on top via type intersection so the preview
// modal can still surface State / Suggestion when present.
export type BrowseRow = Omit<SharedBrowseRow, "type" | "items"> & {
    type: RowType;
    items: Item[];
};

export type BrowseResponse = Omit<SharedBrowseResponse, "rows"> & {
    rows: BrowseRow[];
};

export type ActivityEntry = {
    id: number;
    itemId: string;
    itemName: string;
    profileId: number;
    fromState: ItemState;
    toState: ItemState;
    changedBy?: string;
    changedAt: number;
};

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
    });
    if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text || res.statusText);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined as T;
    return res.json() as Promise<T>;
}

// TypeFilter is the parent's type-of-content filter on the curation views.
// "both" sends nothing (server defaults to Movie+Series), the singular
// values pin the listing to one kind.
export type TypeFilter = "both" | "movies" | "series";

export function typeFilterParam(t: TypeFilter): string | undefined {
    switch (t) {
        case "movies": return "Movie";
        case "series": return "Series";
        case "both":   return undefined;
    }
}

type ItemsQuery = {
    profileId: number;
    type?: string;
    limit?: number;
    startIndex?: number;
    state?: "visible" | "hidden" | "unset";
    search?: string;
    suggest?: boolean;
    // tagId filters the listing to items carrying this tag (M6).
    // Returns items even if their per-profile categorization is now
    // hidden, so admins can find tagged-but-hidden content.
    tagId?: number;
};

function itemsURL(q: ItemsQuery): string {
    const u = new URLSearchParams();
    u.set("profileId", String(q.profileId));
    if (q.type) u.set("type", q.type);
    if (q.limit) u.set("limit", String(q.limit));
    if (q.startIndex) u.set("startIndex", String(q.startIndex));
    if (q.state) u.set("state", q.state);
    if (q.search) u.set("search", q.search);
    if (q.suggest) u.set("suggest", "true");
    if (q.tagId) u.set("tagId", String(q.tagId));
    return `/api/admin/items?${u.toString()}`;
}

export function formatState(state: ItemState): string {
    if (state === null) return "Unset";
    if (state === "visible") return "Visible";
    return "Hidden";
}

export type QuickConnectStartResponse = SharedQCStartResponse;
export type QuickConnectPollResponse = SharedQCPollResponse<User>;

export const api = {
    login: (username: string, password: string) =>
        request<User>("POST", "/api/auth/login", { username, password }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<User>("GET", "/api/auth/me"),

    quickConnectEnabled: () =>
        request<{ enabled: boolean }>(
            "GET",
            "/api/auth/quickconnect/enabled",
        ),
    quickConnectStart: () =>
        request<QuickConnectStartResponse>(
            "POST",
            "/api/auth/quickconnect/start",
        ),
    quickConnectPoll: (id: string) =>
        request<QuickConnectPollResponse>(
            "GET",
            `/api/auth/quickconnect/poll?id=${encodeURIComponent(id)}`,
        ),

    listItems: (q: ItemsQuery) => request<ItemsResult>("GET", itemsURL(q)),
    getAdminItem: (itemId: string, profileId: number) =>
        request<Item>(
            "GET",
            `/api/admin/items/${encodeURIComponent(itemId)}?profileId=${profileId}`,
        ),

    setState: (itemId: string, profileId: number, state: ItemState) =>
        request<void>("POST", `/api/admin/items/${itemId}/state`, { profileId, state }),
    bulkSetState: (itemIds: string[], profileId: number, state: ItemState) =>
        request<{ updated: number }>("POST", `/api/admin/items/state/bulk`, {
            profileId, itemIds, state,
        }),
    recentActivity: (limit = 50, profileId?: number) => {
        const u = new URLSearchParams();
        u.set("limit", String(limit));
        if (profileId) u.set("profileId", String(profileId));
        return request<{ entries: ActivityEntry[] }>("GET", `/api/admin/categorizations/recent?${u.toString()}`);
    },

    getStream: (itemId: string) =>
        request<StreamInfo>("GET", `/api/admin/items/${itemId}/stream`),

    listProfiles: () => request<{ profiles: Profile[] }>("GET", `/api/admin/profiles`),
    createProfile: (input: ProfileInput) =>
        request<Profile>("POST", `/api/admin/profiles`, input),
    updateProfile: (id: number, input: ProfileInput) =>
        request<Profile>("PATCH", `/api/admin/profiles/${id}`, input),
    deleteProfile: (id: number) => request<void>("DELETE", `/api/admin/profiles/${id}`),

    listKids: () => request<{ kids: Kid[] }>("GET", `/api/admin/kids`),
    createKid: (name: string, profileId: number, jellyfinUserId: string) =>
        request<{ kid: Kid }>("POST", `/api/admin/kids`, {
            name, profileId, jellyfinUserId,
        }),
    updateKidProfile: (id: number, profileId: number) =>
        request<void>("PATCH", `/api/admin/kids/${id}`, { profileId }),
    updateKid: (id: number, body: { name?: string; profileId?: number }) =>
        request<void>("PATCH", `/api/admin/kids/${id}`, body),
    deleteKid: (id: number) => request<void>("DELETE", `/api/admin/kids/${id}`),

    listJellyfinUsers: () =>
        request<{ users: JellyfinUser[] }>("GET", `/api/admin/jellyfin/users`),

    // --- M6: tags + item-tag mapping --------------------------------
    listTags: (opts?: { sort?: TagSort; search?: string }) => {
        const u = new URLSearchParams();
        if (opts?.sort) u.set("sort", opts.sort);
        if (opts?.search) u.set("search", opts.search);
        const qs = u.toString();
        return request<{ tags: Tag[] }>(
            "GET",
            `/api/admin/tags${qs ? "?" + qs : ""}`,
        );
    },
    createTag: (input: {
        name: string;
        description?: string;
        sortOrder?: number;
        icon?: string;
    }) => request<Tag>("POST", `/api/admin/tags`, input),
    updateTag: (id: number, input: {
        name?: string;
        description?: string;
        sortOrder?: number;
        icon?: string;
    }) => request<Tag>("PATCH", `/api/admin/tags/${id}`, input),
    deleteTag: (id: number) => request<void>("DELETE", `/api/admin/tags/${id}`),

    getItemTags: (itemId: string) =>
        request<{ tags: Tag[] }>(
            "GET",
            `/api/admin/items/${encodeURIComponent(itemId)}/tags`,
        ),
    setItemTags: (itemId: string, tagIds: number[], opts?: { force?: boolean }) => {
        const u = new URLSearchParams();
        if (opts?.force) u.set("force", "true");
        const qs = u.toString();
        return request<{ tags: Tag[] }>(
            "PUT",
            `/api/admin/items/${encodeURIComponent(itemId)}/tags${qs ? "?" + qs : ""}`,
            { tagIds },
        );
    },

    // --- M6: per-kid favorites --------------------------------------
    listKidFavorites: (kidId: number) =>
        request<{ kidId: number; profileId: number; favorites: KidFavorite[] }>(
            "GET",
            `/api/admin/kids/${kidId}/favorites`,
        ),
    addKidFavorite: (kidId: number, itemId: string) =>
        request<void>(
            "PUT",
            `/api/admin/kids/${kidId}/favorites/${encodeURIComponent(itemId)}`,
        ),
    removeKidFavorite: (kidId: number, itemId: string) =>
        request<void>(
            "DELETE",
            `/api/admin/kids/${kidId}/favorites/${encodeURIComponent(itemId)}`,
        ),

    // --- M6: per-profile tag filters --------------------------------
    listProfileTagFilters: (profileId: number) =>
        request<{ profileId: number; filters: ProfileTagFilter[] }>(
            "GET",
            `/api/admin/profiles/${profileId}/tag-filters`,
        ),
    setProfileTagFilters: (
        profileId: number,
        filters: { tagId: number; mode: ProfileFilterMode }[],
    ) =>
        request<{ profileId: number; filters: ProfileTagFilter[] }>(
            "PUT",
            `/api/admin/profiles/${profileId}/tag-filters`,
            filters,
        ),
    clearProfileTagFilter: (profileId: number, tagId: number) =>
        request<void>(
            "DELETE",
            `/api/admin/profiles/${profileId}/tag-filters/${tagId}`,
        ),

    // --- M8: layouts -----------------------------------------------
    listLayouts: () =>
        request<{ layouts: Layout[] }>("GET", `/api/admin/layouts`),
    getLayout: (id: number) =>
        request<Layout>("GET", `/api/admin/layouts/${id}`),
    createLayout: (input: { name: string; description?: string }) =>
        request<Layout>("POST", `/api/admin/layouts`, input),
    updateLayout: (
        id: number,
        input: { name?: string; description?: string },
    ) => request<Layout>("PATCH", `/api/admin/layouts/${id}`, input),
    deleteLayout: (id: number) =>
        request<void>("DELETE", `/api/admin/layouts/${id}`),
    cloneLayout: (id: number, name?: string) =>
        request<Layout>("POST", `/api/admin/layouts/${id}/clone`, name ? { name } : {}),
    setDefaultLayout: (id: number) =>
        request<void>("POST", `/api/admin/layouts/${id}/default`),
    setProfileLayout: (profileId: number, layoutId: number) =>
        request<void>("PUT", `/api/admin/profiles/${profileId}/layout`, {
            layoutId,
        }),

    appendLayoutRow: (
        layoutId: number,
        row: { type: RowType; title?: string; config: LayoutRowConfig },
    ) =>
        request<LayoutRow>(
            "POST",
            `/api/admin/layouts/${layoutId}/rows`,
            row,
        ),
    updateLayoutRow: (
        layoutId: number,
        rowId: number,
        row: { type?: RowType; title?: string; config?: LayoutRowConfig },
    ) =>
        request<LayoutRow>(
            "PATCH",
            `/api/admin/layouts/${layoutId}/rows/${rowId}`,
            row,
        ),
    deleteLayoutRow: (layoutId: number, rowId: number) =>
        request<void>(
            "DELETE",
            `/api/admin/layouts/${layoutId}/rows/${rowId}`,
        ),
    reorderLayoutRows: (layoutId: number, rowIds: number[]) =>
        request<void>(
            "PUT",
            `/api/admin/layouts/${layoutId}/rows/order`,
            { rowIds },
        ),

    previewLayout: (layoutId: number, profileId: number) =>
        request<BrowseResponse>(
            "GET",
            `/api/admin/layouts/${layoutId}/preview?profileId=${profileId}`,
        ),
    refreshLayoutCache: (profileId: number) =>
        request<void>(
            "POST",
            `/api/admin/dev/refresh-layout-cache?profileId=${profileId}`,
        ),

    // --- M8: kid-side browse (admin can hit it via cookie auth) ----
    browse: (profileId: number) =>
        request<BrowseResponse>(
            "GET",
            `/api/kids/browse?profileId=${profileId}`,
        ),

    // --- M14: API keys ---------------------------------------------
    listAPIKeys: () =>
        request<{ keys: APIKey[] }>("GET", `/api/admin/api-keys`),
    createAPIKey: (name: string) =>
        request<{ token: string; key: APIKey }>(
            "POST",
            `/api/admin/api-keys`,
            { name },
        ),
    revokeAPIKey: (id: number) =>
        request<void>("POST", `/api/admin/api-keys/${id}/revoke`),
    deleteAPIKey: (id: number) =>
        request<void>("DELETE", `/api/admin/api-keys/${id}`),
    listAPIKeyAccessLog: (id: number, limit = 100) =>
        request<{ entries: APIAccessLogEntry[] }>(
            "GET",
            `/api/admin/api-keys/${id}/log?limit=${limit}`,
        ),
    listAPIAccessLog: (limit = 200) =>
        request<{ entries: APIAccessLogEntry[] }>(
            "GET",
            `/api/admin/api-access-log?limit=${limit}`,
        ),

    // --- M9: override + app settings -------------------------------
    getOverrideStatus: () =>
        request<{
            pinSet: boolean;
            failedAttempts: number;
            lockedForSeconds: number;
            updatedAt: number;
        }>("GET", `/api/admin/override`),
    setOverridePIN: (pin: string) =>
        request<void>("POST", `/api/admin/override/pin`, { pin }),
    clearOverrideLockout: () =>
        request<void>("POST", `/api/admin/override/clear-lockout`),
    listSettings: () =>
        request<{ settings: Record<string, string> }>(
            "GET",
            `/api/admin/settings`,
        ),
    setSetting: (key: string, value: string) =>
        request<void>("PUT", `/api/admin/settings`, { key, value }),

    // --- M10: time limits ------------------------------------------
    getProfileTimeLimits: (profileId: number) =>
        request<ProfileTimeLimits>(
            "GET",
            `/api/admin/profiles/${profileId}/time-limits`,
        ),
    setProfileTimeLimits: (profileId: number, body: ProfileTimeLimits) =>
        request<void>(
            "PUT",
            `/api/admin/profiles/${profileId}/time-limits`,
            body,
        ),
    listContentOverrides: (profileId: number) =>
        request<{ overrides: ContentTimeOverride[] }>(
            "GET",
            `/api/admin/profiles/${profileId}/content-overrides`,
        ),
    upsertContentOverride: (
        profileId: number,
        itemId: string,
        body: { overrideCapMinutes?: number | null; overrideStarts?: number | null },
    ) =>
        request<void>(
            "PUT",
            `/api/admin/profiles/${profileId}/content-overrides/${encodeURIComponent(itemId)}`,
            body,
        ),
    getKidTimeStatus: (kidId: number) =>
        request<TimeStatus>("GET", `/api/admin/kids/${kidId}/time-status`),

    // --- M11: body breaks ------------------------------------------
    getProfileBodyBreaks: (profileId: number) =>
        request<ProfileBodyBreaks>(
            "GET",
            `/api/admin/profiles/${profileId}/body-breaks`,
        ),
    setProfileBodyBreaks: (profileId: number, body: ProfileBodyBreaks) =>
        request<void>(
            "PUT",
            `/api/admin/profiles/${profileId}/body-breaks`,
            body,
        ),
    resetProfileBodyBreaks: (profileId: number) =>
        request<ProfileBodyBreaks>(
            "POST",
            `/api/admin/profiles/${profileId}/body-breaks/reset`,
        ),

    // --- M12: viewing controls ------------------------------------
    getProfileViewingControls: (profileId: number) =>
        request<ProfileViewingControls>(
            "GET",
            `/api/admin/profiles/${profileId}/viewing-controls`,
        ),
    setProfileViewingControls: (
        profileId: number,
        body: ProfileViewingControls,
    ) =>
        request<void>(
            "PUT",
            `/api/admin/profiles/${profileId}/viewing-controls`,
            body,
        ),

    // --- M13: time-based modes ------------------------------------
    listProfileModes: (profileId: number) =>
        request<{ modes: Mode[] }>(
            "GET",
            `/api/admin/profiles/${profileId}/modes`,
        ),
    createMode: (profileId: number, body: Mode) =>
        request<Mode>("POST", `/api/admin/profiles/${profileId}/modes`, body),
    updateMode: (id: number, body: Mode) =>
        request<Mode>("PATCH", `/api/admin/modes/${id}`, body),
    deleteMode: (id: number) =>
        request<void>("DELETE", `/api/admin/modes/${id}`),

    // --- M15: cable TV channels -----------------------------------
    listProfileChannels: (profileId: number) =>
        request<{ channels: Channel[] }>(
            "GET",
            `/api/admin/profiles/${profileId}/channels`,
        ),
    createChannel: (profileId: number, body: Channel) =>
        request<Channel>(
            "POST",
            `/api/admin/profiles/${profileId}/channels`,
            body,
        ),
    updateChannel: (id: number, body: Channel) =>
        request<Channel>("PATCH", `/api/admin/channels/${id}`, body),
    deleteChannel: (id: number) =>
        request<void>("DELETE", `/api/admin/channels/${id}`),
};

export { HttpError };
