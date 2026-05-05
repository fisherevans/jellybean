// Auth + device-local state for the kids client.
//
// One device = one signed-in kid. The login screen POSTs username +
// password to /api/kids/auth/login; Jellybean forwards to Jellyfin's
// AuthenticateByName, looks up which Jellybean profile that Jellyfin
// user is mapped to, and returns a session payload. We persist that
// payload in localStorage and present it as bearer auth on every
// subsequent /api/kids/* call.
//
// Storage shape:
//   jellybean.kids.token       - Jellyfin access token from /auth/login
//   jellybean.kids.userId      - Jellyfin user id (sent as header)
//   jellybean.kids.profileId   - Jellybean profile id (numeric, stringified)
//   jellybean.kids.userName    - Jellyfin user's "name" (e.g. "alice")
//   jellybean.kids.kidName     - Jellybean's display name for the kid
//   jellybean.kids.profileName - Jellybean profile name (informational)
//   jellybean.kids.kidId       - Jellybean kid row id (informational)
//   jellybean.kids.deviceId    - lazily-generated per-install UUID
//
// An admin session cookie is also accepted server-side; when present, the
// bearer token is unnecessary. We still send the deviceId header so
// Jellyfin's session view sees the right device identity even on
// admin-driven calls (e.g. preview at /kids/library?profileId=N).

import { clear as clearLibraryCache } from "./libraryCache";

const TOKEN_KEY = "jellybean.kids.token";
const USER_ID_KEY = "jellybean.kids.userId";
const PROFILE_ID_KEY = "jellybean.kids.profileId";
const USER_NAME_KEY = "jellybean.kids.userName";
const KID_NAME_KEY = "jellybean.kids.kidName";
const PROFILE_NAME_KEY = "jellybean.kids.profileName";
const KID_ID_KEY = "jellybean.kids.kidId";
const DEVICE_ID_KEY = "jellybean.kids.deviceId";

const SESSION_KEY_PREFIX = "jellybean.kids.";
const SESSION_KEY_KEEP = new Set([DEVICE_ID_KEY]);

export type Session = {
    token: string;
    userId: string;
    userName: string;
    profileId: number;
    profileName?: string;
    kidName?: string;
    kidId?: number;
};

export type AdminUser = { id: string; name: string; admin: boolean };

export function getSession(): Session | null {
    const token = localStorage.getItem(TOKEN_KEY);
    const userId = localStorage.getItem(USER_ID_KEY);
    const userName = localStorage.getItem(USER_NAME_KEY);
    const profileIdRaw = localStorage.getItem(PROFILE_ID_KEY);
    if (!token || !userId || !userName || !profileIdRaw) return null;
    const profileId = Number(profileIdRaw);
    if (!Number.isFinite(profileId)) return null;
    const session: Session = {
        token,
        userId,
        userName,
        profileId,
    };
    const profileName = localStorage.getItem(PROFILE_NAME_KEY);
    if (profileName) session.profileName = profileName;
    const kidName = localStorage.getItem(KID_NAME_KEY);
    if (kidName) session.kidName = kidName;
    const kidIdRaw = localStorage.getItem(KID_ID_KEY);
    if (kidIdRaw) {
        const kidId = Number(kidIdRaw);
        if (Number.isFinite(kidId)) session.kidId = kidId;
    }
    return session;
}

export function setSession(s: Session): void {
    localStorage.setItem(TOKEN_KEY, s.token);
    localStorage.setItem(USER_ID_KEY, s.userId);
    localStorage.setItem(USER_NAME_KEY, s.userName);
    localStorage.setItem(PROFILE_ID_KEY, String(s.profileId));
    if (s.profileName) localStorage.setItem(PROFILE_NAME_KEY, s.profileName);
    else localStorage.removeItem(PROFILE_NAME_KEY);
    if (s.kidName) localStorage.setItem(KID_NAME_KEY, s.kidName);
    else localStorage.removeItem(KID_NAME_KEY);
    if (s.kidId !== undefined) localStorage.setItem(KID_ID_KEY, String(s.kidId));
    else localStorage.removeItem(KID_ID_KEY);
}

// clearSession wipes every jellybean.kids.* entry except the deviceId,
// which is per-install and outlives sign-in/sign-out cycles.
export function clearSession(): void {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (!k.startsWith(SESSION_KEY_PREFIX)) continue;
        if (SESSION_KEY_KEEP.has(k)) continue;
        toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
    // Drop any cached library data so the next kid signing in on this
    // device can't see the previous kid's tiles. Best-effort: any IDB
    // failure is swallowed so sign-out always succeeds.
    clearLibraryCache().catch(() => {});
}

// getDeviceId returns a stable per-install UUID, generating + persisting one
// on first call. Used as Jellyfin's DeviceId so each TV is its own session.
export function getDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = generateUUIDv4();
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

// generateUUIDv4 produces an RFC 4122 v4 UUID. Prefers crypto.randomUUID()
// when available, but that API is only exposed in secure contexts (HTTPS
// or localhost). On a sideloaded TV WebView loading the dev server over
// plain HTTP from a LAN IP, randomUUID throws. crypto.getRandomValues is
// always available and gives us the same entropy.
function generateUUIDv4(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        try {
            return crypto.randomUUID();
        } catch {
            // fall through to the manual path below
        }
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Per RFC 4122 §4.4: set the version (4) and variant (10xx) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
        hex.push(bytes[i]!.toString(16).padStart(2, "0"));
    }
    return (
        hex.slice(0, 4).join("") + "-" +
        hex.slice(4, 6).join("") + "-" +
        hex.slice(6, 8).join("") + "-" +
        hex.slice(8, 10).join("") + "-" +
        hex.slice(10, 16).join("")
    );
}

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

// authHeaders returns the headers every /api/kids/* request should carry.
// DeviceId is always sent. When signed in we add Authorization (bearer
// token) plus X-Jellyfin-User-Id; otherwise we rely on the admin cookie
// (browser sends automatically) for the preview path.
export function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "X-Jellybean-DeviceId": getDeviceId(),
    };
    const session = getSession();
    if (session) {
        headers["Authorization"] = `Bearer ${session.token}`;
        headers["X-Jellyfin-User-Id"] = session.userId;
    }
    return headers;
}

// imageAuthSuffix builds the &token=...&userId=... fragment to append to
// /api/kids/items/{id}/image URLs when running as a kid. <img> elements
// can't attach Authorization headers, so the server's parseBearer also
// accepts these as query params. Admin-cookie previewing doesn't need
// it; cookies ride on <img> requests automatically.
export function imageAuthSuffix(): string {
    const s = getSession();
    if (!s) return "";
    return `&token=${encodeURIComponent(s.token)}&userId=${encodeURIComponent(s.userId)}`;
}
