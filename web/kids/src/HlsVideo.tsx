import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
} from "react";
import Hls from "hls.js";
import {
    bindHlsErrors,
    classifyMediaError,
    type MediaErrorKind,
    playMedia,
    resetHlsRecovery,
    resetSrc,
} from "./playerHelpers";

// HlsVideo wraps a single <video> element and re-attaches hls.js when
// the `src` prop changes. The element itself never re-mounts during
// the player's lifetime - that's deliberate, mirroring jellyfin-web's
// htmlVideoPlayer plugin (`setCurrentSrc` calls `resetSrc()` then
// builds a new Hls instance, never replacing the <video> tag).
//
// Re-mounting the <video> tag does NOT reset the underlying browser
// decoder - on Android WebView a wedged decoder stays wedged across
// element re-creation. The single-element pattern keeps state simpler
// and matches what the rest of the world does.
//
// hls.js config matches jellyfin-web (plugin.js:455):
//   - startPosition: pass the resume offset in seconds so hls.js seeks
//     before fetching the first segment (no client-side .currentTime
//     hack needed)
//   - manifestLoadingTimeOut: 20s, generous enough for a heavily-busy
//     Jellyfin transcoder to produce the playlist
//   - maxBufferLength + maxMaxBufferLength: 30s (or 6s for high
//     bitrates per their HWA-encoder workaround, which we're below)

type Props = {
    src: string;
    style?: React.CSSProperties;
    autoPlay?: boolean;
    controls?: boolean;
    // resumeSeconds is the playback position to start at. hls.js will
    // seek pre-load via its startPosition config; native-HLS branches
    // set video.currentTime in the loadedmetadata handler.
    resumeSeconds?: number;
    onLoadedMetadata?: React.ReactEventHandler<HTMLVideoElement>;
    onPlay?: React.ReactEventHandler<HTMLVideoElement>;
    onPause?: React.ReactEventHandler<HTMLVideoElement>;
    onEnded?: React.ReactEventHandler<HTMLVideoElement>;
    onTimeUpdate?: React.ReactEventHandler<HTMLVideoElement>;
    onWaiting?: React.ReactEventHandler<HTMLVideoElement>;
    onPlaying?: React.ReactEventHandler<HTMLVideoElement>;
    // onMediaError fires when the player can't recover (network 4xx/5xx,
    // exhausted hls.js MEDIA_ERROR ladder, MEDIA_ERR_DECODE on a
    // non-hls path). Surface to the parent so it can switch to the
    // "Reset Player" UI.
    onMediaError?: (kind: MediaErrorKind) => void;
};

export default forwardRef<HTMLVideoElement, Props>(function HlsVideo(
    {
        src,
        style,
        autoPlay,
        controls = true,
        resumeSeconds = 0,
        onMediaError,
        ...handlers
    },
    forwardedRef,
) {
    const ref = useRef<HTMLVideoElement>(null);
    useImperativeHandle(forwardedRef, () => ref.current!, []);

    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        if (!src) {
            resetSrc(video);
            return;
        }
        const isHLS = src.includes(".m3u8");
        let hls: Hls | null = null;

        // Wipe any previous src before attaching the next one. Mirrors
        // jellyfin-web's resetSrc() call in setCurrentSrc().
        resetSrc(video);

        const tryPlay = () => {
            if (!autoPlay) return;
            void playMedia(video);
        };

        const handleNativeError = () => {
            const kind = classifyMediaError(video);
            if (kind) onMediaError?.(kind);
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
            return () => {
                video.removeEventListener("loadedmetadata", onMeta);
                video.removeEventListener("error", handleNativeError);
            };
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
            return () => {
                video.removeEventListener("loadedmetadata", onMeta);
                video.removeEventListener("error", handleNativeError);
            };
        }

        if (Hls.isSupported()) {
            resetHlsRecovery();
            hls = new Hls({
                startPosition: resumeSeconds > 0 ? resumeSeconds : -1,
                manifestLoadingTimeOut: 20_000,
                maxBufferLength: 30,
                maxMaxBufferLength: 30,
            });
            bindHlsErrors(hls, (kind) => {
                onMediaError?.(kind);
            });
            hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
            hls.loadSource(src);
            hls.attachMedia(video);
            const cleanup = () => {
                if (hls) {
                    try {
                        hls.destroy();
                    } catch {
                        /* ignore */
                    }
                    hls = null;
                }
                video.removeEventListener("error", handleNativeError);
            };
            return cleanup;
        }

        // Last-resort: assume the platform can play whatever this is.
        video.src = src;
        const onMeta = () => tryPlay();
        video.addEventListener("loadedmetadata", onMeta, { once: true });
        return () => {
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("error", handleNativeError);
        };
    }, [src, autoPlay, resumeSeconds, onMediaError]);

    return (
        <video
            ref={ref}
            controls={controls}
            // 1x1 black PNG, base64. Suppresses Android WebView's
            // default grey "play poster" + stretched play-arrow icon
            // that flashes during the buffering window. The on-screen
            // loading overlay (in Play.tsx) renders on top.
            poster="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAggA9GkAAAAASUVORK5CYII="
            style={style}
            {...handlers}
        />
    );
});
