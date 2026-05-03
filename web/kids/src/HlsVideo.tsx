import { useEffect, useRef } from "react";
import Hls from "hls.js";

// See web/admin/src/HlsVideo.tsx for the rationale; the two are deliberate
// duplicates because admin and kids are separate Vite projects.
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
            video.src = src;
            return;
        }

        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(src);
            hls.attachMedia(video);
            return () => hls.destroy();
        }

        video.src = src;
    }, [src]);

    return <video ref={ref} controls style={style} />;
}
