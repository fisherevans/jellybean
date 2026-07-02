// Client-facing runtime config. Served by GET /api/kids/config (see
// internal/server/kids.go handleKidsConfig) and consumed by the kids app.
//
// Today it only carries the Jellyfin base URL the client would use for
// direct playback. It's shaped as an object rather than a bare string so
// capability flags (e.g. a future degraded/direct-Jellyfin mode toggle)
// can be added without breaking the client contract. The server's
// kidsConfigResponse struct JSON tags MUST stay byte-identical to this.

/**
 * KidsConfig is the body returned by GET /api/kids/config.
 */
export interface KidsConfig {
    /**
     * Public/client-facing Jellyfin base URL. Defaults to the server's
     * internal JellyfinURL when JELLYFIN_PUBLIC_URL is unset, so today it
     * matches the origin already embedded in stream URLs. Plumbing for a
     * future direct-Jellyfin playback mode; not yet wired into streaming.
     */
    jellyfinBaseUrl: string;
}
