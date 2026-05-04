// Player helpers ported from jellyfin-web's htmlMediaHelper.js (MIT
// licensed, github.com/jellyfin/jellyfin-web). The patterns there are
// proven on every Jellyfin web client deployment; reusing them keeps
// our kids player aligned with what works in the wild.

import Hls from "hls.js";

// MediaErrorKind classifies the surface-able error states the player
// can land in. Matches jellyfin-web's MediaError enum (subset).
export type MediaErrorKind =
    | "NETWORK_ERROR"
    | "SERVER_ERROR"
    | "FATAL_HLS_ERROR"
    | "MEDIA_DECODE_ERROR"
    | "MEDIA_NOT_SUPPORTED";

// playSessionIdFromUrl extracts Jellyfin's PlaySessionId from a stream
// URL. Jellyfin embeds it as a query parameter on the master.m3u8 URL
// returned by PlaybackInfo, and downstream playback reports must
// reference it (see jellyfin-web playbackmanager.js getParam pattern).
//
// Casing varies: the Jellyfin server emits "PlaySessionId" (upper-camel),
// but some endpoints accept the lowerCamel variant. Try both before
// giving up.
export function playSessionIdFromUrl(streamUrl: string | undefined): string {
    if (!streamUrl) return "";
    try {
        const params = new URL(streamUrl, window.location.origin).searchParams;
        return (
            params.get("PlaySessionId") ??
            params.get("playSessionId") ??
            ""
        );
    } catch {
        return "";
    }
}

// resetSrc clears a video element's source so the next attach starts
// from a clean slate. Direct port of jellyfin-web htmlMediaHelper.js
// resetSrc() - same three lines. Use BEFORE setting a new src to avoid
// playing a frame of the old source while the new one loads.
export function resetSrc(elem: HTMLVideoElement): void {
    elem.src = "";
    elem.innerHTML = "";
    elem.removeAttribute("src");
}

// playMedia wraps elem.play() and swallows the recoverable errors
// (NotAllowedError + AbortError). Direct port of jellyfin-web's
// playWithPromise (htmlMediaHelper.js:198).
//
// NotAllowedError fires when the browser's autoplay policy refuses an
// auto-initiated play() call - normal on Android WebView after a
// non-gesture transition. The user can press the play button to
// recover; surfacing this as an "error" is misleading.
//
// AbortError fires when a play() promise is interrupted by a pause()
// (or another play() that overrides it). Common in our M-AT debugging
// session whenever a fallback fired during in-flight playback.
export function playMedia(elem: HTMLVideoElement): Promise<void> {
    try {
        const promise = elem.play();
        if (!promise || typeof promise.then !== "function") {
            return Promise.resolve();
        }
        return promise.then(
            () => undefined,
            (err: unknown) => {
                const name = ((err as Error)?.name ?? "").toLowerCase();
                if (name === "notallowederror" || name === "aborterror") {
                    // Recoverable. The user can still tap play.
                    return undefined;
                }
                throw err;
            },
        );
    } catch (err) {
        return Promise.reject(err);
    }
}

// HLS.js media-error recovery state. Module-scoped so a tight loop of
// errors can't keep recovering on the same 3-second window. Mirrors
// jellyfin-web's two `Date` module variables.
let recoverDecodingErrorAt = 0;
let recoverSwapAudioCodecAt = 0;
const RECOVERY_GATE_MS = 3000;

// resetHlsRecovery clears the recovery gates. Call when starting a
// fresh stream; otherwise an old recovery attempt's timestamp would
// short-circuit fresh content's first error.
export function resetHlsRecovery(): void {
    recoverDecodingErrorAt = 0;
    recoverSwapAudioCodecAt = 0;
}

// handleHlsMediaError walks jellyfin-web's recovery ladder for a fatal
// HLS MEDIA_ERROR (htmlMediaHelper.js:79):
//
//   1. First fatal in the last 3s window: hls.recoverMediaError()
//   2. Second fatal within 3s of the first: swapAudioCodec() + recover
//   3. Third fatal within 3s: give up; caller surfaces FATAL_HLS_ERROR
//
// Returns true when a recovery was kicked, false when we've exhausted
// the ladder and the caller should surface the error to the user.
export function handleHlsMediaError(hls: Hls | null | undefined): boolean {
    if (!hls) return false;
    const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
    if (now - recoverDecodingErrorAt > RECOVERY_GATE_MS) {
        recoverDecodingErrorAt = now;
        try {
            hls.recoverMediaError();
        } catch {
            return false;
        }
        return true;
    }
    if (now - recoverSwapAudioCodecAt > RECOVERY_GATE_MS) {
        recoverSwapAudioCodecAt = now;
        try {
            hls.swapAudioCodec();
            hls.recoverMediaError();
        } catch {
            return false;
        }
        return true;
    }
    return false;
}

// bindHlsErrors wires up jellyfin-web's HLS error routing. The two
// callbacks split fatal HLS errors into "this is recoverable, we
// already kicked recovery" (no-op) and "we couldn't recover, surface
// to the user" (kind set, hls destroyed).
//
// network errors that aren't 4xx/5xx get hls.startLoad() (let hls.js
// handle its own retry / backoff). 4xx/5xx and CORS (response.code 0)
// are surfaced as SERVER_ERROR / NETWORK_ERROR immediately - no point
// retrying a 401 or a CORS-rejected fetch.
export function bindHlsErrors(
    hls: Hls,
    onFatal: (kind: MediaErrorKind) => void,
): void {
    hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (
            data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            data.response &&
            typeof data.response.code === "number" &&
            data.response.code >= 400
        ) {
            try {
                hls.destroy();
            } catch {
                /* ignore */
            }
            onFatal("SERVER_ERROR");
            return;
        }
        if (!data.fatal) return;
        switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
                if (data.response && data.response.code === 0) {
                    try {
                        hls.destroy();
                    } catch {
                        /* ignore */
                    }
                    onFatal("NETWORK_ERROR");
                    return;
                }
                try {
                    hls.startLoad();
                } catch {
                    onFatal("NETWORK_ERROR");
                }
                return;
            case Hls.ErrorTypes.MEDIA_ERROR:
                if (!handleHlsMediaError(hls)) {
                    onFatal("FATAL_HLS_ERROR");
                }
                return;
            default:
                try {
                    hls.destroy();
                } catch {
                    /* ignore */
                }
                onFatal("FATAL_HLS_ERROR");
                return;
        }
    });
}

// classifyMediaError translates a native HTMLMediaElement.error code
// into our MediaErrorKind. Mirrors jellyfin-web's onError handler in
// plugin.js (the table at the top of the function).
export function classifyMediaError(
    elem: HTMLVideoElement,
): MediaErrorKind | undefined {
    const err = elem.error;
    if (!err) return undefined;
    switch (err.code) {
        case 1: // MEDIA_ERR_ABORTED
            return undefined; // expected when changing src; not user-visible
        case 2: // MEDIA_ERR_NETWORK
            return "NETWORK_ERROR";
        case 3: // MEDIA_ERR_DECODE
            return "MEDIA_DECODE_ERROR";
        case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
            return "MEDIA_NOT_SUPPORTED";
        default:
            return undefined;
    }
}
