// Auth-related wire shapes. Both apps consume these:
//   - QuickConnectStartResponse: /api/auth/quickconnect/start +
//     /api/kids/auth/quickconnect/start (identical shape).
//   - QuickConnectPollResponse<T>: parameterized over the success
//     payload - admin gets a User, kids get a KidLoginResponse.
//   - KidLoginResponse: /api/kids/auth/login success body, also
//     embedded in the kid-side Quick Connect poll response.

/**
 * QuickConnectStartResponse is the body returned by both apps' /start
 * endpoints. The server keeps the id <-> Jellyfin secret mapping
 * server-side; the client only ever sees the id + the user-visible
 * code.
 */
export interface QuickConnectStartResponse {
    id: string;
    code: string;
    /** ISO 8601 timestamp when the pairing expires. */
    expiresAt: string;
}

/**
 * QuickConnectPollResponse<T> is the body returned by both apps' /poll
 * endpoints. T is the role-specific success payload (admin: User,
 * kids: KidLoginResponse). The server returns the same shape with the
 * payload omitted while the poll is still pending.
 *
 * The legacy admin field name is `user`; kids uses `kid`. Both are
 * optional + omitempty on the wire, so we model them with a discriminated
 * union per app at the call site.
 */
export interface QuickConnectPollResponse<T> {
    status: "pending" | "authorized" | "expired";
    /** Admin path: the authenticated User. */
    user?: T;
    /** Kid path: the authenticated KidLoginResponse. */
    kid?: T;
}

/**
 * KidLoginResponse is the success body of /api/kids/auth/login. The
 * same shape lands in QuickConnectPollResponse.kid when the kid path
 * authorizes via Quick Connect. JSON tags on the server's
 * kidAuthResponse struct (internal/server/quickconnect.go +
 * internal/server/kids.go) MUST stay byte-identical to this.
 */
export interface KidLoginResponse {
    /** Kid bearer token (Jellyfin access token). */
    token: string;
    /** Jellyfin user id this token belongs to. */
    userId: string;
    /** Jellyfin user display name. */
    userName: string;
    /** Jellybean kid record id, if mapped. */
    kidId?: number;
    /** Jellybean kid record name, if mapped. */
    kidName?: string;
    /** Jellybean profile id this kid is scoped to. */
    profileId: number;
    /** Jellybean profile display name. */
    profileName?: string;
}
