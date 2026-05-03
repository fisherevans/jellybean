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
    State: ItemState; // visibility for the active profile (null = unset)
    Suggestion?: Suggestion;
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
};

export type ProfileInput = {
    name: string;
    description: string;
    defaultLanguage?: string;
};

export type Kid = {
    id: number;
    name: string;
    profileId: number;
    profileName: string;
    jellyfinUserId: string;
    hasToken: boolean;
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
    createKid: (name: string, profileId: number, jellyfinUsername: string, jellyfinPassword: string) =>
        request<{ kid: Kid; apiKey: string }>("POST", `/api/admin/kids`, {
            name, profileId, jellyfinUsername, jellyfinPassword,
        }),
    regenerateKidKey: (id: number) =>
        request<{ apiKey: string }>("POST", `/api/admin/kids/${id}/regenerate`),
    deleteKid: (id: number) => request<void>("DELETE", `/api/admin/kids/${id}`),
};

export { HttpError };
