import { useEffect, useRef } from "react";
import Hls from "hls.js";

// HlsVideo renders a <video> element that knows how to play HLS manifests.
// Safari has native HLS support; everywhere else we lean on hls.js. For
// non-HLS sources (e.g. plain MP4) we just set the src attribute and let
// the browser handle it.
type Props = {
    src: string;
    style?: React.CSSProperties;
};

export default function HlsVideo({ src, style }: Props) {
    const ref = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const video = ref.current;
        if (!video) return;
        const isHLS = src.includes(".m3u8");

        if (!isHLS) {
            video.src = src;
            return;
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            // Native HLS (Safari); browser handles segmentation + duration.
            video.src = src;
            return;
        }

        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(src);
            hls.attachMedia(video);
            return () => hls.destroy();
        }

        // No HLS path available; fall back to direct src and hope.
        video.src = src;
    }, [src]);

    return <video ref={ref} controls style={style} />;
}
