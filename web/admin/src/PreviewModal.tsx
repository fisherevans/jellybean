import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

// PreviewModal is a throwaway viewer used from the sweep / triage cards.
// Not meant to be a real player - it just streams the item, seeks to ~1/3
// of the runtime so the parent can confirm "yes, this is the show I think
// it is" without having to scrub through opening credits.
//
// Closes on Escape, click outside the player, or the close button.

type StreamResponse = {
    streamUrl: string;
    itemId: string;
    itemName: string;
};

type Props = {
    itemId: string;
    itemName: string;
    onClose: () => void;
};

export default function PreviewModal({ itemId, itemName, onClose }: Props) {
    const [stream, setStream] = useState<StreamResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/admin/items/${encodeURIComponent(itemId)}/stream`, {
            credentials: "same-origin",
        })
            .then(async (res) => {
                if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
                return (await res.json()) as StreamResponse;
            })
            .then((data) => {
                if (!cancelled) setStream(data);
            })
            .catch((err) => {
                if (!cancelled) setError(String(err.message ?? err));
            });
        return () => {
            cancelled = true;
        };
    }, [itemId]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Wire HLS once the stream URL is ready. hls.js / native HLS branching
    // mirrors the existing HlsVideo component, but we need direct access to
    // the video element's events here so it lives inline.
    useEffect(() => {
        if (!stream) return;
        const video = videoRef.current;
        if (!video) return;
        const src = stream.streamUrl;
        const isHLS = src.includes(".m3u8");

        let hls: Hls | null = null;
        if (!isHLS) {
            video.src = src;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = src;
        } else if (Hls.isSupported()) {
            hls = new Hls();
            hls.loadSource(src);
            hls.attachMedia(video);
        } else {
            video.src = src;
        }
        return () => {
            hls?.destroy();
        };
    }, [stream]);

    function onLoadedMetadata() {
        const v = videoRef.current;
        if (!v || !v.duration || !isFinite(v.duration)) return;
        // Seek to 1/3 of runtime so the parent skips intro / studio logos
        // and lands somewhere recognizable.
        v.currentTime = v.duration / 3;
    }

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                className="modal preview-modal"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="preview-header">
                    <h2>{itemName}</h2>
                    <button onClick={onClose} aria-label="Close preview">
                        ✕
                    </button>
                </div>
                {error && <p className="error">{error}</p>}
                {!stream && !error && <p className="muted">Loading preview...</p>}
                {stream && (
                    <video
                        ref={videoRef}
                        controls
                        autoPlay
                        muted
                        onLoadedMetadata={onLoadedMetadata}
                        className="preview-video"
                    />
                )}
                <p className="muted preview-note">
                    Preview only. Seeks to ~1/3 of the runtime to skip intros.
                </p>
            </div>
        </div>
    );
}
