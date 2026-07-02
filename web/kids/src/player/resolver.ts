// StreamResolver is the "given an item, produce a playable stream URL +
// play-session info" seam (jellybean#107, P0). Today the only source of
// truth for playable streams is the Jellybean backend's /api/kids/...
// endpoints, wrapped by JellybeanStreamResolver below. The interface
// exists so future work can swap in a different resolution strategy
// without touching Play.tsx's orchestration.
//
// Extension point: a future DirectJellyfinStreamResolver will implement
// this same interface, talking straight to a Jellyfin server (its
// PlaybackInfo + NextUp endpoints) instead of routing through the
// Jellybean kids API. It is NOT built here - P0 is only the seam plus
// today's implementation behind it.

import { authHeaders } from "../auth";

// StreamResponse is the resolved, playable stream for a single item. It
// carries the stream URL plus the metadata Play.tsx renders and the
// play-session bookkeeping (mediaSourceId, playbackPath) reporting needs.
export type StreamResponse = {
    streamUrl: string;
    itemId: string;
    itemName: string;
    itemType?: string;
    seriesId?: string;
    seriesName?: string;
    indexNumber?: number;
    parentIndexNumber?: number;
    productionYear?: number;
    userData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
    };
    mediaSourceId?: string;
    playbackPath?: string;
    favoriteItemId?: string;
    isFavorite?: boolean;
    runtimeTicks?: number;
};

// NextUpResponse identifies the next episode to resolve for a series.
// It's an item pointer (episodeId) plus enough metadata to seed the
// resolved stream's labels/userData when the /stream call omits them.
export type NextUpResponse = {
    episodeId: string;
    name: string;
    seriesId?: string;
    seriesName?: string;
    indexNumber?: number;
    parentIndexNumber?: number;
    userData?: StreamResponse["userData"];
};

// StreamResolver produces playable streams and resolves series next-up.
// Implementations own the transport/auth details; callers (Play.tsx)
// own the orchestration (movie short-circuit, next-up prefetch, etc.).
export interface StreamResolver {
    // resolveStream returns a playable stream for the given item. For a
    // Series the caller is expected to resolve next-up first and then
    // resolve the returned episode.
    resolveStream(itemId: string): Promise<StreamResponse>;
    // resolveNextUp returns the next episode to play for a series. When
    // `after` is supplied, it's the episode to advance past.
    resolveNextUp(seriesId: string, after?: string): Promise<NextUpResponse>;
}

// JellybeanStreamResolver is the current (and only) implementation. It
// hits the Jellybean kids API, which brokers PlaybackInfo/NextUp against
// the backing Jellyfin server and applies the kids-profile rules.
export class JellybeanStreamResolver implements StreamResolver {
    async resolveStream(itemId: string): Promise<StreamResponse> {
        // Carry along any admin-preview params (?profileId=N&kidId=M)
        // from the page URL. The kids middleware requires profileId on
        // the admin path; bearer-auth kids carry it implicitly.
        const url = new URL(
            `/api/kids/items/${encodeURIComponent(itemId)}/stream`,
            window.location.origin,
        );
        const passthrough = new URLSearchParams(window.location.search);
        for (const k of ["profileId", "kidId"]) {
            const v = passthrough.get(k);
            if (v) url.searchParams.set(k, v);
        }
        const res = await fetch(url.toString(), {
            credentials: "same-origin",
            headers: authHeaders(),
        });
        if (!res.ok) {
            if (res.status === 401) {
                throw new Error(
                    "Not signed in. Sign in at /kids/login or sign in as admin at /.",
                );
            }
            throw new Error(
                `${res.status} ${res.statusText}: ${await res.text()}`,
            );
        }
        return (await res.json()) as StreamResponse;
    }

    async resolveNextUp(
        seriesId: string,
        after?: string,
    ): Promise<NextUpResponse> {
        const url = new URL(
            `/api/kids/items/${encodeURIComponent(seriesId)}/next-up`,
            window.location.origin,
        );
        if (after) url.searchParams.set("after", after);
        const res = await fetch(url.toString(), {
            credentials: "same-origin",
            headers: authHeaders(),
        });
        if (!res.ok) {
            throw new Error(`next-up: ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as NextUpResponse;
    }
}
