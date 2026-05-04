// Thin client over Jellybean's HTTP API. The session cookie is set by the
// server; we never touch it explicitly.

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
    Genres?: string[];
    Studios?: { Name: string; Id?: string }[];
    ImageTags?: { Primary?: string };
    AudioLanguage?: string; // ISO 639-3 of primary audio track ("" if unknown)
    AudioLanguages?: string[]; // every distinct audio language on the item; primary is always present when AudioLanguage is set

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

export const api = {
    login: (username: string, password: string) =>
        request<User>("POST", "/api/auth/login", { username, password }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<User>("GET", "/api/auth/me"),

    listItems: (q: ItemsQuery) => request<ItemsResult>("GET", itemsURL(q)),

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
    }) => request<Tag>("POST", `/api/admin/tags`, input),
    updateTag: (id: number, input: {
        name?: string;
        description?: string;
        sortOrder?: number;
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
};

export { HttpError };
