// Client runtime config: fetch-once + cache for GET /api/kids/config.
//
// P1 plumbing (jellybean#107) for a future degraded/direct-Jellyfin
// playback mode. Today the server returns { jellyfinBaseUrl } which
// mirrors the origin already baked into stream URLs; nothing here is
// wired into streaming yet. We fetch it once at boot, stash it in
// localStorage, and expose a synchronous getter so later work (P2) can
// read the public Jellyfin origin without a round-trip.
//
// The endpoint sits under the kids middleware, so the fetch needs kid
// auth (bearer token + user-id header via authHeaders). It runs after
// auth is established and fails soft: a 401, a network error (offline),
// or a parse failure just leaves the last cached value (or none) in
// place. Boot never blocks on it.

import type { KidsConfig } from "jellybean-shared";
import { authHeaders, getSession } from "./auth";

const CONFIG_KEY = "jellybean.kids.config";

// getKidsConfig returns the last cached config, or null if we've never
// successfully fetched one on this device. Synchronous; reads
// localStorage. Callers that need a live value should have triggered
// refreshKidsConfig at boot.
export function getKidsConfig(): KidsConfig | null {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<KidsConfig>;
        if (typeof parsed.jellyfinBaseUrl !== "string") return null;
        return { jellyfinBaseUrl: parsed.jellyfinBaseUrl };
    } catch {
        return null;
    }
}

// refreshKidsConfig fetches /api/kids/config and caches it. Fire-and-
// forget from boot: resolves to the fresh config on success, or null on
// any failure (no session, 401, offline, non-2xx, bad body). Never
// throws, never clears the cache on failure - a transient error keeps
// the previously-cached value usable.
export async function refreshKidsConfig(): Promise<KidsConfig | null> {
    // Config lives behind kid auth. Skip entirely when signed out (the
    // admin-cookie preview path doesn't need this plumbing).
    if (!getSession()) return null;
    try {
        const res = await fetch("/api/kids/config", {
            headers: authHeaders(),
            credentials: "same-origin",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<KidsConfig>;
        if (typeof body.jellyfinBaseUrl !== "string") return null;
        const config: KidsConfig = { jellyfinBaseUrl: body.jellyfinBaseUrl };
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        return config;
    } catch {
        return null;
    }
}
