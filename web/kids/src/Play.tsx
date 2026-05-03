import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { authHeaders } from "./auth";
import HlsVideo from "./HlsVideo";

// Play is the kid playback screen. Movies stream the requested item id;
// series resolve next-up first and stream that episode. In both cases we
// seek to the resume position from Jellyfin's UserData on
// `loadedmetadata`, then report start / progress / pause / stop back to
// Jellyfin so Continue Watching stays current.

type StreamResponse = {
    streamUrl: string;
    itemId: string;
    itemName: string;
    itemType?: string;
    userData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
    };
};

type NextUpResponse = {
    episodeId: string;
    name: string;
    seriesName?: string;
    userData?: StreamResponse["userData"];
};

const TICKS_PER_SECOND = 10_000_000;
const PROGRESS_INTERVAL_MS = 10_000;

export default function Play() {
    const { itemId } = useParams();
    const nav = useNavigate();
    const location = useLocation();
    // Preserve the search params from /play (set by Library when navigating
    // here) so the back link returns to the same filtered library view.
    // Real kid users have no params; admin testing uses ?profileId=N.
    const libraryHref = `/library${location.search}`;
    const [stream, setStream] = useState<StreamResponse | null>(null);
    const [seriesLabel, setSeriesLabel] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const reportedStart = useRef(false);

    // Esc returns to the library.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") nav(libraryHref);
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [nav, libraryHref]);

    // Resolve which item to play. Movies: use the item directly. Series:
    // fetch next-up and stream the resolved episode id.
    useEffect(() => {
        if (!itemId) return;
        let cancelled = false;
        setError(null);
        setStream(null);
        reportedStart.current = false;

        (async () => {
            try {
                const first = await fetchStream(itemId);
                if (cancelled) return;
                if (first.itemType !== "Series") {
                    setStream(first);
                    return;
                }
                const next = await fetchNextUp(itemId);
                if (cancelled) return;
                const episode = await fetchStream(next.episodeId);
                if (cancelled) return;
                setSeriesLabel(next.seriesName ?? first.itemName);
                // Prefer episode userData (more granular) but fall back to
                // whatever next-up returned.
                if (!episode.userData && next.userData) {
                    episode.userData = next.userData;
                }
                setStream(episode);
            } catch (err) {
                if (!cancelled) setError(String((err as Error).message ?? err));
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [itemId]);

    // Playback reporting. Start fires once when the video first plays;
    // progress every 10s; stopped on unmount, navigation away, or the
    // ended event.
    const reportStart = useCallback(() => {
        if (!stream || reportedStart.current) return;
        reportedStart.current = true;
        const v = videoRef.current;
        const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
        void postPlayback("start", { itemId: stream.itemId, positionTicks: ticks, isPaused: false });
    }, [stream]);

    const reportProgress = useCallback(
        (paused: boolean) => {
            if (!stream || !reportedStart.current) return;
            const v = videoRef.current;
            const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
            void postPlayback("progress", {
                itemId: stream.itemId,
                positionTicks: ticks,
                isPaused: paused,
            });
        },
        [stream],
    );

    const reportStopped = useCallback(() => {
        if (!stream || !reportedStart.current) return;
        const v = videoRef.current;
        const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
        void postPlayback("stopped", { itemId: stream.itemId, positionTicks: ticks });
    }, [stream]);

    // Heartbeat while the video is loaded.
    useEffect(() => {
        if (!stream) return;
        const id = window.setInterval(() => {
            const v = videoRef.current;
            if (!v) return;
            reportProgress(v.paused);
        }, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [stream, reportProgress]);

    // Stop on unmount.
    useEffect(() => {
        return () => {
            reportStopped();
        };
    }, [reportStopped]);

    function onLoadedMetadata() {
        const v = videoRef.current;
        if (!v || !stream?.userData) return;
        const ticks = stream.userData.PlaybackPositionTicks ?? 0;
        const seconds = ticks / TICKS_PER_SECOND;
        const dur = v.duration || 0;
        // Skip the seek if we're at the very start (just-started) or near
        // the end (treat as watched, restart from 0).
        if (seconds < 5) return;
        if (dur > 0 && seconds / dur > 0.9) return;
        v.currentTime = seconds;
    }

    function onEnded() {
        reportStopped();
        nav(libraryHref);
    }

    if (error) {
        return (
            <div className="screen play-error">
                <p className="error">{error}</p>
                <Link to={libraryHref}>Back to library</Link>
            </div>
        );
    }
    if (!stream) {
        return <div className="screen play-loading">Loading...</div>;
    }

    const isAdminPreview = new URLSearchParams(location.search).has("profileId");

    return (
        <div className="play-screen">
            {isAdminPreview && (
                <div className="admin-preview-banner" role="status">
                    <span>Previewing as admin.</span>
                    <a href="/manage-kids" className="admin-preview-back">
                        Back to admin
                    </a>
                </div>
            )}
            <header className="play-header">
                <Link to={libraryHref} className="play-back" aria-label="Back to library">
                    <span aria-hidden>{"←"}</span>
                </Link>
                <div className="play-titles">
                    <h1>{stream.itemName}</h1>
                    {seriesLabel && <p className="play-series">{seriesLabel}</p>}
                </div>
            </header>
            <HlsVideo
                ref={videoRef}
                key={stream.itemId}
                src={stream.streamUrl}
                autoPlay
                onLoadedMetadata={onLoadedMetadata}
                onPlay={reportStart}
                onPause={() => reportProgress(true)}
                onEnded={onEnded}
                style={{ width: "100%", height: "calc(100vh - 80px)" }}
            />
        </div>
    );
}

async function fetchStream(itemId: string): Promise<StreamResponse> {
    const res = await fetch(
        `/api/kids/items/${encodeURIComponent(itemId)}/stream`,
        { credentials: "same-origin", headers: authHeaders() },
    );
    if (!res.ok) {
        if (res.status === 401) {
            throw new Error(
                "Not signed in. Sign in at /kids/login or sign in as admin at /.",
            );
        }
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return (await res.json()) as StreamResponse;
}

async function fetchNextUp(seriesId: string): Promise<NextUpResponse> {
    const res = await fetch(
        `/api/kids/items/${encodeURIComponent(seriesId)}/next-up`,
        { credentials: "same-origin", headers: authHeaders() },
    );
    if (!res.ok) {
        throw new Error(`next-up: ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as NextUpResponse;
}

async function postPlayback(
    kind: "start" | "progress" | "stopped",
    payload: Record<string, unknown>,
): Promise<void> {
    try {
        await fetch(`/api/kids/playback/${kind}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch {
        // Reporting hiccups never block the kid's playback. Server logs
        // failures; here we swallow.
    }
}
