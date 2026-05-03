// Thin client over Jellybean's HTTP API. The session cookie is set by the
// server; we never touch it explicitly.

export type User = {
    id: string;
    name: string;
    admin: boolean;
};

// Standard age tiers stored on items. The schema accepts other integers, so
// future granularity (e.g. 16 for older teens) is additive.
export const AGE_TIERS = [2, 5, 7, 13, 18] as const;
export type AgeTier = (typeof AGE_TIERS)[number];

export const AGE_LABELS: Record<AgeTier, string> = {
    2: "Toddler (2+)",
    5: "Preschool (5+)",
    7: "Younger kid (7+)",
    13: "Teen (13+)",
    18: "Adult (18+)",
};

// Coarse bucket derived server-side from MinAge. Used when the UI just
// needs to know "is this kid-allowed" without picking a specific tier.
export type Bucket = "kid" | "adult" | "uncategorized";

export type Suggestion = {
    bucket: "kid" | "adult" | "unsure";
    minAge: number | null;
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
    MinAge: number | null;
    Bucket: Bucket;
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
    fromMinAge: number | null;
    toMinAge: number | null;
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
    category?: Bucket;
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

// formatMinAge renders a stored min_age as a human label.
// null → "Uncategorized"; known tiers use their AGE_LABELS.
export function formatMinAge(age: number | null): string {
    if (age === null) return "Uncategorized";
    if ((AGE_TIERS as readonly number[]).includes(age)) {
        return AGE_LABELS[age as AgeTier];
    }
    return `${age}+`;
}

export const api = {
    login: (username: string, password: string) =>
        request<User>("POST", "/api/auth/login", { username, password }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<User>("GET", "/api/auth/me"),

    listItems: (q: ItemsQuery = {}) => request<ItemsResult>("GET", itemsURL(q)),

    setAge: (itemId: string, minAge: number | null) =>
        request<void>("POST", `/api/admin/items/${itemId}/age`, { minAge }),
    bulkSetAge: (itemIds: string[], minAge: number | null) =>
        request<{ updated: number }>("POST", `/api/admin/items/age/bulk`, { itemIds, minAge }),
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
