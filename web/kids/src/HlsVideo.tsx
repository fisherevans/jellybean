import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { type MediaErrorKind } from "./playerHelpers";
import {
    BrowserPlaybackBackend,
    type PlaybackBackend,
} from "./player/backend";

// HlsVideo renders the single <video> element and exposes it to the
// parent as a PlaybackBackend (jellybean#107, P0). The <video>+hls.js
// engine logic now lives in BrowserPlaybackBackend; this component only
// owns the React rendering + wiring the backend's lifecycle to the `src`
// prop. The <video> element never re-mounts during the player's lifetime
// (deliberate - a wedged Android WebView decoder stays wedged across
// element re-creation, so re-mounting buys nothing). Native media events
// still surface as React props on the element for Play.tsx's handlers.
//
// The forwarded ref is the PlaybackBackend (not the raw element): both
// Play.tsx and PlayerTransport.tsx drive playback through that seam.

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

export default forwardRef<PlaybackBackend, Props>(function HlsVideo(
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
    const videoElRef = useRef<HTMLVideoElement | null>(null);
    const backendRef = useRef<BrowserPlaybackBackend | null>(null);

    // Create the backend as soon as the <video> element exists. The ref
    // callback runs during commit, before layout effects (including the
    // useImperativeHandle below and PlayerTransport's subscribe effect),
    // so the backend is available by the time anyone reads the ref.
    const setVideoEl = (el: HTMLVideoElement | null) => {
        videoElRef.current = el;
        if (el && !backendRef.current) {
            backendRef.current = new BrowserPlaybackBackend(el);
        }
    };

    useImperativeHandle(forwardedRef, () => backendRef.current!, []);

    // (Re)attach the stream whenever the source (or attach-time options)
    // change. loadStream tears down the previously-loaded stream first,
    // matching HlsVideo's old effect-cleanup-then-resetSrc sequence.
    useEffect(() => {
        const backend = backendRef.current;
        if (!backend) return;
        backend.loadStream(src, { resumeSeconds, autoPlay, onError: onMediaError });
    }, [src, autoPlay, resumeSeconds, onMediaError]);

    // Final teardown on unmount (destroys the hls.js instance + removes
    // the per-load listeners).
    useEffect(() => {
        return () => {
            backendRef.current?.destroy();
        };
    }, []);

    return (
        <video
            ref={setVideoEl}
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
