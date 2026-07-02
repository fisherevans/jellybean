// PlaybackBackend is the "given a stream URL, play/pause/seek/report/
// emit events" seam (jellybean#107, P0). It abstracts the concrete media
// engine so Play.tsx and PlayerTransport.tsx drive playback through one
// surface instead of a raw <video> element.
//
// The interface is deliberately shaped as the subset of HTMLMediaElement
// that Play/PlayerTransport already use (currentTime, duration, paused,
// play/pause, readyState/networkState, addEventListener/removeEventListener
// for the media lifecycle events), plus the explicit lifecycle operations
// HlsVideo performs internally today: loadStream (attach a source + wire
// hls.js), reset, destroy, and getError. Keeping the property/method
// names identical to HTMLMediaElement means PlayerTransport's ~15 call
// sites stay byte-for-byte the same; only the ref's type changes.
//
// Extension point: a future AvplayPlaybackBackend (Samsung Tizen, which
// has no <video>/hls.js but a native `webapis.avplay` engine) will
// implement this same interface - translating currentTime/play/pause/
// events onto avplay and loadStream onto avplay.open/prepare. It is NOT
// built here - P0 is only the seam plus today's browser implementation.

import Hls from "hls.js";
import {
    bindHlsErrors,
    classifyMediaError,
    type MediaErrorKind,
    playMedia,
    resetHlsRecovery,
    resetSrc,
} from "../playerHelpers";

// Media lifecycle events a PlaybackBackend emits. Matches the native
// HTMLMediaElement event names PlayerTransport/HlsVideo subscribe to, so
// existing addEventListener call sites need no string changes.
export type PlaybackEventType =
    | "play"
    | "pause"
    | "ended"
    | "timeupdate"
    | "waiting"
    | "playing"
    | "durationchange"
    | "loadedmetadata"
    | "seeked"
    | "error";

// LoadStreamOptions mirrors the props HlsVideo used to key its attach
// effect on. onError is the "unrecoverable playback error" notification
// (fired only after the hls.js recovery ladder is exhausted, or on a
// non-recoverable native error) - it replaces HlsVideo's onMediaError.
export type LoadStreamOptions = {
    resumeSeconds?: number;
    autoPlay?: boolean;
    onError?: (kind: MediaErrorKind) => void;
};

export interface PlaybackBackend {
    // --- HTMLMediaElement subset used by Play/PlayerTransport ---
    currentTime: number; // read (position reporting, scrubber) + write (seek/restart)
    readonly duration: number;
    readonly paused: boolean;
    readonly readyState: number;
    readonly networkState: number;
    play(): Promise<void>;
    pause(): void;
    addEventListener(type: PlaybackEventType, listener: () => void): void;
    removeEventListener(type: PlaybackEventType, listener: () => void): void;

    // --- lifecycle operations HlsVideo performs internally today ---
    // loadStream attaches a source and (for HLS) wires the hls.js engine
    // + recovery ladder, seeking to resumeSeconds and auto-playing per
    // opts. Tears down any previously-loaded stream first.
    loadStream(src: string, opts: LoadStreamOptions): void;
    // reset clears the current source (stop + blank), keeping the backend
    // reusable for a subsequent loadStream.
    reset(): void;
    // destroy tears down the current stream/engine for good (unmount).
    destroy(): void;
    // getError returns the last unrecoverable error kind, if any.
    getError(): MediaErrorKind | undefined;
}

// BrowserPlaybackBackend wraps a single <video> element and hls.js. It
// re-attaches hls.js when loadStream is called with a new source; the
// element itself never re-mounts (mirrors jellyfin-web's htmlVideoPlayer
// plugin - resetSrc() then a fresh Hls instance, never a new <video>).
//
// hls.js config matches jellyfin-web (plugin.js:455):
//   - startPosition: pass the resume offset in seconds so hls.js seeks
//     before fetching the first segment (no client-side .currentTime
//     hack needed)
//   - manifestLoadingTimeOut: 20s, generous enough for a heavily-busy
//     Jellyfin transcoder to produce the playlist
//   - maxBufferLength + maxMaxBufferLength: 30s
export class BrowserPlaybackBackend implements PlaybackBackend {
    private readonly video: HTMLVideoElement;
    private hls: Hls | null = null;
    private lastError: MediaErrorKind | undefined;
    private onError?: (kind: MediaErrorKind) => void;
    // Per-load teardown: removes the listeners/engine attached by the
    // current loadStream. Null when no stream is loaded.
    private currentTeardown: (() => void) | null = null;

    constructor(video: HTMLVideoElement) {
        this.video = video;
    }

    // --- HTMLMediaElement subset ---
    get currentTime(): number {
        return this.video.currentTime;
    }
    set currentTime(t: number) {
        this.video.currentTime = t;
    }
    get duration(): number {
        return this.video.duration;
    }
    get paused(): boolean {
        return this.video.paused;
    }
    get readyState(): number {
        return this.video.readyState;
    }
    get networkState(): number {
        return this.video.networkState;
    }
    play(): Promise<void> {
        // Raw element play() so callers keep their exact promise handling
        // (autoplay-policy inspection in attemptPlay, .catch() elsewhere).
        // Autoplay-on-load uses playMedia() instead (see loadStream).
        return this.video.play();
    }
    pause(): void {
        this.video.pause();
    }
    addEventListener(type: PlaybackEventType, listener: () => void): void {
        this.video.addEventListener(type, listener);
    }
    removeEventListener(type: PlaybackEventType, listener: () => void): void {
        this.video.removeEventListener(type, listener);
    }

    // --- lifecycle ---
    loadStream(src: string, opts: LoadStreamOptions): void {
        this.teardownLoad();
        this.onError = opts.onError;
        const resumeSeconds = opts.resumeSeconds ?? 0;
        const autoPlay = opts.autoPlay ?? false;
        const video = this.video;

        if (!src) {
            resetSrc(video);
            return;
        }
        const isHLS = src.includes(".m3u8");

        // Wipe any previous src before attaching the next one. Mirrors
        // jellyfin-web's resetSrc() call in setCurrentSrc().
        resetSrc(video);

        const tryPlay = () => {
            if (!autoPlay) return;
            void playMedia(video);
        };

        const handleNativeError = () => {
            const kind = classifyMediaError(video);
            if (kind) this.raiseError(kind);
        };
        video.addEventListener("error", handleNativeError);

        if (!isHLS) {
            video.src = src;
            const onMeta = () => {
                if (resumeSeconds > 0 && video.duration > resumeSeconds) {
                    try {
                        video.currentTime = resumeSeconds;
                    } catch {
                        /* ignore - some browsers throw seeking pre-buffer */
                    }
                }
                tryPlay();
            };
            video.addEventListener("loadedmetadata", onMeta, { once: true });
            this.currentTeardown = () => {
                video.removeEventListener("loadedmetadata", onMeta);
                video.removeEventListener("error", handleNativeError);
            };
            return;
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            // Native HLS path (Safari, iOS WebView). hls.js has a
            // smaller native HLS use case; defer to the platform.
            video.src = src;
            const onMeta = () => {
                if (resumeSeconds > 0 && video.duration > resumeSeconds) {
                    try {
                        video.currentTime = resumeSeconds;
                    } catch {
                        /* ignore */
                    }
                }
                tryPlay();
            };
            video.addEventListener("loadedmetadata", onMeta, { once: true });
            this.currentTeardown = () => {
                video.removeEventListener("loadedmetadata", onMeta);
                video.removeEventListener("error", handleNativeError);
            };
            return;
        }

        if (Hls.isSupported()) {
            resetHlsRecovery();
            const hls = new Hls({
                startPosition: resumeSeconds > 0 ? resumeSeconds : -1,
                manifestLoadingTimeOut: 20_000,
                maxBufferLength: 30,
                maxMaxBufferLength: 30,
            });
            this.hls = hls;
            bindHlsErrors(hls, (kind) => {
                this.raiseError(kind);
            });
            hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
            hls.loadSource(src);
            hls.attachMedia(video);
            this.currentTeardown = () => {
                if (this.hls) {
                    try {
                        this.hls.destroy();
                    } catch {
                        /* ignore */
                    }
                    this.hls = null;
                }
                video.removeEventListener("error", handleNativeError);
            };
            return;
        }

        // Last-resort: assume the platform can play whatever this is.
        video.src = src;
        const onMeta = () => tryPlay();
        video.addEventListener("loadedmetadata", onMeta, { once: true });
        this.currentTeardown = () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", handleNativeError);
        };
    }

    reset(): void {
        this.teardownLoad();
        resetSrc(this.video);
    }

    destroy(): void {
        this.teardownLoad();
    }

    getError(): MediaErrorKind | undefined {
        return this.lastError;
    }

    private teardownLoad(): void {
        if (this.currentTeardown) {
            this.currentTeardown();
            this.currentTeardown = null;
        }
    }

    private raiseError(kind: MediaErrorKind): void {
        this.lastError = kind;
        this.onError?.(kind);
    }
}
