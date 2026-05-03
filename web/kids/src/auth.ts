// Auth + device-local state for the kids client.
//
// A device (TV) can host multiple kid profiles. Each profile binds a kid
// display name to an API key minted by the parent web app. The active
// profile drives every /api/kids/* call on this device.
//
// Storage shape:
//   jellybean.kids.profiles  - JSON array of {name, apiKey}
//   jellybean.kids.activeKey - the apiKey of the picked profile
//   jellybean.kids.deviceId  - lazily-generated per-install UUID
//
// The legacy single-key model (jellybean.kids.key from M1) is migrated
// transparently on first read so existing TVs don't need re-onboarding.
//
// An admin session cookie is also accepted server-side; when present, the
// kid key is unnecessary. We still send the deviceId header so Jellyfin's
// session view sees the right device identity even on admin-driven calls.

const PROFILES_KEY = "jellybean.kids.profiles";
const ACTIVE_KEY = "jellybean.kids.activeKey";
const DEVICE_ID_KEY = "jellybean.kids.deviceId";
const LEGACY_KEY = "jellybean.kids.key";

export type KidProfile = { name: string; apiKey: string };
export type AdminUser = { id: string; name: string; admin: boolean };

export function listProfiles(): KidProfile[] {
    migrateLegacy();
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isProfile) : [];
    } catch {
        return [];
    }
}

function isProfile(v: unknown): v is KidProfile {
    return (
        typeof v === "object" &&
        v !== null &&
        typeof (v as KidProfile).name === "string" &&
        typeof (v as KidProfile).apiKey === "string"
    );
}

// addProfile appends or updates a profile, deduped by apiKey. Returns the
// full updated list so callers can re-render without re-reading storage.
export function addProfile(p: KidProfile): KidProfile[] {
    const trimmed: KidProfile = { name: p.name.trim(), apiKey: p.apiKey.trim() };
    const existing = listProfiles();
    const idx = existing.findIndex((x) => x.apiKey === trimmed.apiKey);
    let next: KidProfile[];
    if (idx >= 0) {
        next = [...existing];
        next[idx] = trimmed;
    } else {
        next = [...existing, trimmed];
    }
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    return next;
}

export function removeProfile(apiKey: string): KidProfile[] {
    const next = listProfiles().filter((p) => p.apiKey !== apiKey);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    if (getActiveKey() === apiKey) clearActiveKey();
    return next;
}

export function getActiveKey(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveKey(apiKey: string): void {
    localStorage.setItem(ACTIVE_KEY, apiKey);
}

export function clearActiveKey(): void {
    localStorage.removeItem(ACTIVE_KEY);
}

export function getActiveProfile(): KidProfile | null {
    const k = getActiveKey();
    if (!k) return null;
    return listProfiles().find((p) => p.apiKey === k) ?? null;
}

// getDeviceId returns a stable per-install UUID, generating + persisting one
// on first call. Used as Jellyfin's DeviceId so each TV is its own session.
export function getDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
}

function migrateLegacy(): void {
    const old = localStorage.getItem(LEGACY_KEY);
    if (!old) return;
    if (!localStorage.getItem(PROFILES_KEY)) {
        const profile: KidProfile = { name: "Kid", apiKey: old };
        localStorage.setItem(PROFILES_KEY, JSON.stringify([profile]));
        localStorage.setItem(ACTIVE_KEY, old);
    }
    localStorage.removeItem(LEGACY_KEY);
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
// DeviceId is always sent. The kid key is sent when present; admin sessions
// rely on the cookie (browser sends automatically) instead.
export function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "X-Jellybean-DeviceId": getDeviceId(),
    };
    const k = getActiveKey();
    if (k) headers["X-Jellybean-Key"] = k;
    return headers;
}
