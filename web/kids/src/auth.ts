// Auth helpers for the kids client. The kids UI accepts two forms of auth:
//
//   1. An admin session cookie (no key required). This is the path used when
//      a logged-in parent is testing the kids UI from the same browser.
//   2. A kid API key in localStorage, sent as X-Jellybean-Key. This is the
//      path used by the actual TV install.
//
// When both are available, the cookie wins (server-side: OptionalMiddleware
// resolves the session before checking the header).

const KEY_STORAGE = "jellybean.kids.key";

export type AdminUser = { id: string; name: string; admin: boolean };

export async function probeAdmin(): Promise<AdminUser | null> {
    try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        if (!res.ok) return null;
        const u = (await res.json()) as AdminUser;
        return u.admin ? u : null;
    } catch {
        return null;
    }
}

export function getKidKey(): string | null {
    return localStorage.getItem(KEY_STORAGE);
}

export function setKidKey(key: string): void {
    localStorage.setItem(KEY_STORAGE, key);
}

export function clearKidKey(): void {
    localStorage.removeItem(KEY_STORAGE);
}

// authHeaders returns the headers for /api/kids/* calls. The session cookie
// is sent automatically by the browser; the kid key (if present) is sent as
// a fallback header. Server prefers the cookie when both are valid.
export function authHeaders(): Record<string, string> {
    const k = getKidKey();
    return k ? { "X-Jellybean-Key": k } : {};
}
