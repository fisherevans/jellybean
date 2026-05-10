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

import type { KidLoginResponse } from "jellybean-shared";
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

// JellybeanShell.{set,get,clear}AuthBlob bridge to Android
// SharedPreferences. Keeps the kid signed in across WebView
// localStorage prunes (Android's storage-cleanup, WebView upgrades).
// Browser fallback: getAuthBridge returns undefined and every
// bridge call below short-circuits, so the app behaves identically
// to a localStorage-only world.
type AuthBridge = {
    setAuthBlob?: (json: string) => void;
    getAuthBlob?: () => string | null;
    clearAuthBlob?: () => void;
};
function getAuthBridge(): AuthBridge | undefined {
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { JellybeanShell?: AuthBridge })
        .JellybeanShell;
}

// AUTH_KEY_TO_BLOB_FIELD maps each localStorage key to the JSON
// field name in the SharedPreferences blob. Used by both the
// mirror-on-write path (setSession) and the rehydrate-on-boot path
// (hydrateAuthFromBridge).
const AUTH_KEY_TO_BLOB_FIELD: Record<string, string> = {
    [TOKEN_KEY]: "token",
    [USER_ID_KEY]: "userId",
    [USER_NAME_KEY]: "userName",
    [PROFILE_ID_KEY]: "profileId",
    [PROFILE_NAME_KEY]: "profileName",
    [KID_NAME_KEY]: "kidName",
    [KID_ID_KEY]: "kidId",
    [DEVICE_ID_KEY]: "deviceId",
};

function mirrorAuthToBridge(): void {
    const bridge = getAuthBridge();
    if (!bridge?.setAuthBlob) return;
    const blob: Record<string, string> = {};
    for (const [lsKey, blobKey] of Object.entries(AUTH_KEY_TO_BLOB_FIELD)) {
        const v = localStorage.getItem(lsKey);
        if (v !== null) blob[blobKey] = v;
    }
    try {
        bridge.setAuthBlob(JSON.stringify(blob));
    } catch {
        // JNI exceptions never break sign-in.
    }
}

function clearAuthOnBridge(): void {
    const bridge = getAuthBridge();
    if (!bridge?.clearAuthBlob) return;
    try {
        bridge.clearAuthBlob();
    } catch {
        /* ignore */
    }
}

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
    // Mirror to Android SharedPreferences via the JellybeanShell
    // bridge. Reads back from localStorage so we capture the actual
    // serialized form (number-stringified profileId, etc.) and so
    // deviceId is included via the lazy-generation path below.
    getDeviceId();
    mirrorAuthToBridge();
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
    // Mirror the clear to Android SharedPreferences so the next
    // launch doesn't rehydrate a signed-out session. No-op in browser.
    clearAuthOnBridge();
    // Drop any cached library data so the next kid signing in on this
    // device can't see the previous kid's tiles. Best-effort: any IDB
    // failure is swallowed so sign-out always succeeds.
    clearLibraryCache().catch(() => {});
}

// hydrateAuthFromBridge replays the SharedPreferences auth blob back
// into localStorage when localStorage is empty but the bridge has a
// blob (i.e. WebView storage was pruned but the APK still has the
// session). Runs once at app boot from main.tsx, before React reads
// getSession() for its first render. No-op when the bridge is absent
// (browser) or localStorage already has a token (running install
// wins over any stale bridge snapshot).
export function hydrateAuthFromBridge(): void {
    const bridge = getAuthBridge();
    if (!bridge?.getAuthBlob) return;
    if (localStorage.getItem(TOKEN_KEY)) return;
    let raw: string | null = null;
    try {
        raw = bridge.getAuthBlob() ?? null;
    } catch {
        return;
    }
    if (!raw) return;
    let blob: Record<string, unknown>;
    try {
        blob = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return;
    }
    for (const [lsKey, blobKey] of Object.entries(AUTH_KEY_TO_BLOB_FIELD)) {
        const v = blob[blobKey];
        if (v === undefined || v === null || v === "") continue;
        if (lsKey === DEVICE_ID_KEY && localStorage.getItem(DEVICE_ID_KEY)) {
            // Lazy generator may have already fired (paranoia; in
            // practice main.tsx runs hydrate before any other code).
            continue;
        }
        localStorage.setItem(lsKey, String(v));
    }
}

// getDeviceId returns a stable per-install UUID, generating + persisting one
// on first call. Used as Jellyfin's DeviceId so each TV is its own session.
// When the bridge is present, also mirror the freshly-generated id so the
// first lazy generation (after a localStorage wipe but with no bridge blob
// yet) lands on disk too.
export function getDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = generateUUIDv4();
        localStorage.setItem(DEVICE_ID_KEY, id);
        mirrorAuthToBridge();
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

// withAuthRetry runs doFetch once. On 401, waits 800ms and runs it
// again, returning that result. Anything else (2xx, 304, non-401 4xx,
// network throws) returned/thrown immediately. Real Jellyfin
// revocation stays 401 on retry and the call site handles it the
// same way as today (clearSession + nav("/login")). Transient 401s
// from Jellyfin restarting mid-request, suspend-resume clock skew,
// or a momentary auth-cache miss self-heal silently.
//
// Returns Response - never throws on 401 itself. Call sites still
// inspect res.status. The retry uses the same closure both times so
// URL + headers + auth re-evaluate naturally with whatever's in
// localStorage on retry.
export async function withAuthRetry(
    doFetch: () => Promise<Response>,
): Promise<Response> {
    const first = await doFetch();
    if (first.status !== 401) return first;
    await new Promise((r) => setTimeout(r, 800));
    return doFetch();
}

// sealSessionFromKidPayload writes a Session derived from a
// KidLoginResponse into local storage. Single source of truth shared
// by every login surface (password, Quick Connect, phone-pair); the
// Login component should call this on whatever payload its chosen
// flow produces. Keeps the field-mapping centralized so adding a new
// session field doesn't fan out to every login path.
export function sessionFromKidPayload(kid: KidLoginResponse): Session {
    return {
        token: kid.token,
        userId: kid.userId,
        userName: kid.userName,
        profileId: kid.profileId,
        profileName: kid.profileName,
        kidName: kid.kidName,
        kidId: kid.kidId,
    };
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
