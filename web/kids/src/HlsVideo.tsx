import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import Hls from "hls.js";

// HlsVideo wraps a <video> element and attaches hls.js when the source is
// an HLS manifest and the browser can't play it natively. The component
// forwards a ref to the underlying video element so callers can attach
// event listeners and read currentTime / duration.
//
// See web/admin/src/HlsVideo.tsx for the rationale; the two are deliberate
// duplicates because admin and kids are separate Vite projects.

type Props = {
    src: string;
    style?: React.CSSProperties;
    autoPlay?: boolean;
    controls?: boolean;
    onLoadedMetadata?: React.ReactEventHandler<HTMLVideoElement>;
    onPlay?: React.ReactEventHandler<HTMLVideoElement>;
    onPause?: React.ReactEventHandler<HTMLVideoElement>;
    onEnded?: React.ReactEventHandler<HTMLVideoElement>;
    onTimeUpdate?: React.ReactEventHandler<HTMLVideoElement>;
    onError?: React.ReactEventHandler<HTMLVideoElement>;
};

export default forwardRef<HTMLVideoElement, Props>(function HlsVideo(
    { src, style, autoPlay, controls = true, ...handlers },
    forwardedRef,
) {
    const ref = useRef<HTMLVideoElement>(null);
    useImperativeHandle(forwardedRef, () => ref.current!, []);

    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        const isHLS = src.includes(".m3u8");

        // Force a play() once the source is ready instead of leaning on
        // <video autoplay>. MSE / hls.js attach the source after the
        // element mounts, by which point the autoplay attribute has
        // already given up. Explicit play() after manifest-parsed
        // (or loadedmetadata for native HLS) is the reliable path.
        // We swallow the play() promise rejection because some
        // platforms (older WebViews, Safari without user-gesture)
        // reject; the user can still tap the controls.
        const tryPlay = () => {
            if (!autoPlay) return;
            const p = video.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
        };

        if (!isHLS) {
            video.src = src;
            video.addEventListener("loadedmetadata", tryPlay, { once: true });
            return () => video.removeEventListener("loadedmetadata", tryPlay);
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = src;
            video.addEventListener("loadedmetadata", tryPlay, { once: true });
            return () => video.removeEventListener("loadedmetadata", tryPlay);
        }

        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
            hls.loadSource(src);
            hls.attachMedia(video);
            return () => hls.destroy();
        }

        video.src = src;
        video.addEventListener("loadedmetadata", tryPlay, { once: true });
        return () => video.removeEventListener("loadedmetadata", tryPlay);
    }, [src, autoPlay]);

    return (
        <video
            ref={ref}
            controls={controls}
            autoPlay={autoPlay}
            style={style}
            {...handlers}
        />
    );
});
