// Thin client over Jellybean's HTTP API. The session cookie is set by the
// server; we never touch it explicitly.

export type User = {
    id: string;
    name: string;
    admin: boolean;
};

export type Suggestion = {
    category: "kid" | "adult" | "unsure";
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
    Category: "kid" | "adult" | "uncategorized";
    Suggestion?: Suggestion;
};

export type ItemsResult = {
    Items: Item[];
    TotalRecordCount: number;
    ReturnedCount: number;
    StartIndex: number;
    NextStartIndex: number;
    HasMore: boolean;
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
    createdAt: number;
    kidCount: number;
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
    fromCategory?: string;
    toCategory: string;
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

type ItemsQuery = {
    type?: string;
    limit?: number;
    startIndex?: number;
    category?: "kid" | "adult" | "uncategorized";
    search?: string;
    suggest?: boolean;
};

function itemsURL(q: ItemsQuery): string {
    const u = new URLSearchParams();
    if (q.type) u.set("type", q.type);
    if (q.limit) u.set("limit", String(q.limit));
    if (q.startIndex) u.set("startIndex", String(q.startIndex));
    if (q.category) u.set("category", q.category);
    if (q.search) u.set("search", q.search);
    if (q.suggest) u.set("suggest", "true");
    const qs = u.toString();
    return `/api/admin/items${qs ? "?" + qs : ""}`;
}

export const api = {
    login: (username: string, password: string) =>
        request<User>("POST", "/api/auth/login", { username, password }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<User>("GET", "/api/auth/me"),

    listItems: (q: ItemsQuery = {}) => request<ItemsResult>("GET", itemsURL(q)),

    setCategory: (itemId: string, category: Item["Category"]) =>
        request<void>("POST", `/api/admin/items/${itemId}/category`, { category }),
    bulkSetCategory: (itemIds: string[], category: Item["Category"]) =>
        request<{ updated: number }>("POST", `/api/admin/items/category/bulk`, { itemIds, category }),
    recentActivity: (limit = 50) =>
        request<{ entries: ActivityEntry[] }>("GET", `/api/admin/categorizations/recent?limit=${limit}`),

    getStream: (itemId: string) =>
        request<StreamInfo>("GET", `/api/admin/items/${itemId}/stream`),

    listProfiles: () => request<{ profiles: Profile[] }>("GET", `/api/admin/profiles`),
    createProfile: (name: string, description: string) =>
        request<Profile>("POST", `/api/admin/profiles`, { name, description }),
    updateProfile: (id: number, name: string, description: string) =>
        request<Profile>("PATCH", `/api/admin/profiles/${id}`, { name, description }),
    deleteProfile: (id: number) =>
        request<void>("DELETE", `/api/admin/profiles/${id}`),

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
