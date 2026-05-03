// Thin client over Jellybean's HTTP API. The session cookie is set by the
// server; we never touch it explicitly.

export type User = {
    id: string;
    name: string;
    admin: boolean;
};

export type Item = {
    Id: string;
    Name: string;
    Type: string;
    OfficialRating?: string;
    ProductionYear?: number;
    Genres?: string[];
    ImageTags?: { Primary?: string };
};

export type ItemsResult = {
    Items: Item[];
    TotalRecordCount: number;
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
    return res.json() as Promise<T>;
}

export const api = {
    login: (username: string, password: string) =>
        request<User>("POST", "/api/auth/login", { username, password }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<User>("GET", "/api/auth/me"),
    listItems: (type = "Movie", limit = 20) =>
        request<ItemsResult>("GET", `/api/admin/items?type=${type}&limit=${limit}`),
    streamURL: (itemId: string) => `/api/admin/items/${itemId}/stream`,
};

export { HttpError };
