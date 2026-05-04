import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { authHeaders } from "./auth";
import HlsVideo from "./HlsVideo";
import PlayerTransport from "./PlayerTransport";

// Play is the kid playback screen. Movies stream the requested item id;
// series resolve next-up first and stream that episode. In both cases we
// seek to the resume position from Jellyfin's UserData on
// `loadedmetadata`, then report start / progress / pause / stop back to
// Jellyfin so Continue Watching stays current.
//
// The custom transport (PlayerTransport.tsx) owns all in-player input
// (D-pad, keyboard shortcuts, scrubber, button row). Play.tsx keeps:
//   - The Esc -> back-to-library handler (outside the transport's scope).
//   - Resume on loadedmetadata.
//   - Playback reporting (write-through queue).
//   - The next-episode resolver wired into PlayerTransport.

type StreamResponse = {
    streamUrl: string;
    itemId: string;
    itemName: string;
    itemType?: string;
    seriesId?: string;
    seriesName?: string;
    // Episode index inside the season + season index inside the series.
    // Both are populated only when the resolved item is an Episode.
    indexNumber?: number;
    parentIndexNumber?: number;
    userData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
    };
};

type NextUpResponse = {
    episodeId: string;
    name: string;
    seriesId?: string;
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
    // offline: distinct from `error` so we can render a friendlier "can't
    // play offline" screen instead of dumping a network error string.
    // Set when the fetch promise rejects (network unreachable); HTTP
    // failures still go through `error`.
    const [offline, setOffline] = useState(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const reportedStart = useRef(false);
    // hasStarted flips on the first 'play' event. While false the
    // initial loading overlay covers the WebView's default grey play
    // poster so the kid sees a clean brand splash instead.
    const [hasStarted, setHasStarted] = useState(false);
    // isBuffering flips true on the video's `waiting` event (stalled
    // for data) and false on `playing`. We show the loading overlay
    // any time the video can't progress, not just at first launch.
    const [isBuffering, setIsBuffering] = useState(false);
    // Mirror of PlayerTransport's internal visibility. Used to
    // overlay the title header in sync with the bottom controls.
    const [transportVisible, setTransportVisible] = useState(false);

    // Esc remains the back-out shortcut; the transport doesn't own it.
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
        setOffline(false);
        setStream(null);
        reportedStart.current = false;

        (async () => {
            try {
                const first = await fetchStream(itemId);
                if (cancelled) return;
                if (first.itemType !== "Series") {
                    setStream(first);
                    if (first.seriesName) setSeriesLabel(first.seriesName);
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
                // Make sure the episode response carries the parent series
                // id so the next-episode button can resolve "what's after
                // this one" via /next-up. fetchStream returns it from the
                // server, but if the server didn't, fall back to next-up's
                // value.
                if (!episode.seriesId && next.seriesId) {
                    episode.seriesId = next.seriesId;
                }
                setStream(episode);
            } catch (err) {
                if (cancelled) return;
                if (isNetworkError(err)) {
                    setOffline(true);
                } else {
                    setError(String((err as Error).message ?? err));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [itemId]);

    // Playback reporting is write-through: heartbeats and pause / play
    // / stop events enqueue an entry to an in-memory queue and return
    // immediately. A separate timer drains the queue to the network in
    // the background. The video event handlers never await fetch, so a
    // slow or unreachable server can never stall playback.
    //
    // Queue is in-memory only. Crashing mid-show drops queued events;
    // that's acceptable (Jellyfin's resume position will simply be
    // slightly stale). If measurement on real TVs proves we need
    // persistence, IDB-backing the queue is a separate change.
    const queueRef = useRef<PlaybackEvent[]>([]);

    const enqueueProgressEvent = useCallback((evt: PlaybackEvent) => {
        queueRef.current.push(evt);
    }, []);

    const reportStart = useCallback(() => {
        if (!stream || reportedStart.current) return;
        reportedStart.current = true;
        const v = videoRef.current;
        const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
        enqueueProgressEvent({
            kind: "start",
            payload: {
                itemId: stream.itemId,
                positionTicks: ticks,
                isPaused: false,
            },
        });
    }, [stream, enqueueProgressEvent]);

    const reportProgress = useCallback(
        (paused: boolean) => {
            if (!stream || !reportedStart.current) return;
            const v = videoRef.current;
            const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
            enqueueProgressEvent({
                kind: "progress",
                payload: {
                    itemId: stream.itemId,
                    positionTicks: ticks,
                    isPaused: paused,
                },
            });
        },
        [stream, enqueueProgressEvent],
    );

    const reportStopped = useCallback(() => {
        if (!stream || !reportedStart.current) return;
        const v = videoRef.current;
        const ticks = v ? v.currentTime * TICKS_PER_SECOND : 0;
        enqueueProgressEvent({
            kind: "stopped",
            payload: { itemId: stream.itemId, positionTicks: ticks },
        });
    }, [stream, enqueueProgressEvent]);

    // Drainer: pop everything in the queue and fire each call
    // fire-and-forget. Runs on the same cadence as the old direct
    // heartbeat (PROGRESS_INTERVAL_MS) so server load is unchanged.
    useEffect(() => {
        if (!stream) return;
        const id = window.setInterval(() => {
            drainQueue(queueRef.current);
        }, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [stream]);

    // Heartbeat: enqueue a progress event every interval while a video
    // is loaded. Separate from the drainer so the enqueue cadence is
    // always honored even if the network is slow.
    useEffect(() => {
        if (!stream) return;
        const id = window.setInterval(() => {
            const v = videoRef.current;
            if (!v) return;
            reportProgress(v.paused);
        }, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [stream, reportProgress]);

    // Stop on unmount, plus a best-effort flush of whatever's still
    // queued. The component is going away, so we can't await; fire each
    // remaining call and let the browser handle it.
    useEffect(() => {
        return () => {
            reportStopped();
            drainQueue(queueRef.current);
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

    // Transport callbacks. onRestart rewinds to 0 and resumes playback.
    // onNextEpisode is wired only when we have a parent seriesId (i.e.
    // we resolved an episode through /next-up). It fetches the *next*
    // next-up after the currently-playing episode and navigates to play it.
    const handleRestart = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = 0;
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
    }, []);

    const seriesIdForNext = stream?.seriesId;
    const currentEpisodeId = stream?.itemId;
    const handleNextEpisode = useCallback(() => {
        if (!seriesIdForNext || !currentEpisodeId) return;
        // Report a stop on the current episode so Jellyfin clears its
        // session view, then walk to the episode AFTER this one in the
        // series. Plain /next-up returns the resume-able episode,
        // which is the same episode we're watching while the kid
        // hasn't finished it - useless for advancing. ?after=<id>
        // forces the server to walk the episode list and return the
        // strictly-next one.
        reportStopped();
        drainQueue(queueRef.current);
        (async () => {
            try {
                const next = await fetchNextUp(seriesIdForNext, currentEpisodeId);
                nav(`/play/${encodeURIComponent(next.episodeId)}${location.search}`);
            } catch {
                // If the next-up call fails (no episodes left, or
                // network error), drop back to the library rather
                // than leaving the kid stuck on a broken next button.
                nav(libraryHref);
            }
        })();
    }, [seriesIdForNext, currentEpisodeId, nav, libraryHref, location.search, reportStopped]);

    if (offline) {
        return (
            <div className="screen play-error">
                <h1>Can't play offline</h1>
                <p>Reconnect to keep watching.</p>
                <Link to={libraryHref}>Back to library</Link>
            </div>
        );
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
    const showNextEpisode = !!stream.seriesId;

    // Header overlays the video like the bottom controls do. It's
    // visible while the loading splash is up (so the kid knows what's
    // loading) and follows the transport's show/hide cycle once
    // playback has begun.
    const headerVisible = !hasStarted || transportVisible;

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
            <HlsVideo
                ref={videoRef}
                key={stream.itemId}
                src={stream.streamUrl}
                autoPlay
                controls={false}
                onLoadedMetadata={onLoadedMetadata}
                onPlay={() => {
                    setHasStarted(true);
                    setIsBuffering(false);
                    reportStart();
                }}
                onPause={() => {
                    reportProgress(true);
                }}
                onWaiting={() => setIsBuffering(true)}
                onPlaying={() => setIsBuffering(false)}
                onEnded={onEnded}
                style={{ width: "100%", height: "100vh" }}
            />
            <header className={`play-header ${headerVisible ? "visible" : "hidden"}`}>
                <Link to={libraryHref} className="play-back" aria-label="Back to library">
                    <span aria-hidden>{"←"}</span>
                </Link>
                <div className="play-titles">
                    <h1>{stream.itemName}</h1>
                    {seriesLabel && (
                        <p className="play-series">
                            {seriesLabel}
                            {stream.parentIndexNumber !== undefined &&
                                stream.indexNumber !== undefined && (
                                <span className="play-episode-badge">
                                    {" · "}S{stream.parentIndexNumber}E
                                    {String(stream.indexNumber).padStart(2, "0")}
                                </span>
                            )}
                        </p>
                    )}
                </div>
            </header>
            {(!hasStarted || isBuffering) && (
                <div className="play-loading-overlay" aria-hidden>
                    <img
                        src="/kids/jellybean-kids.png"
                        alt=""
                        className="play-loading-bean"
                    />
                    <p className="play-loading-label">Loading…</p>
                </div>
            )}
            <PlayerTransport
                videoRef={videoRef}
                onRestart={handleRestart}
                onNextEpisode={showNextEpisode ? handleNextEpisode : undefined}
                onVisibleChange={setTransportVisible}
            />
        </div>
    );
}

// isNetworkError discriminates "the request never reached the server"
// from "the server replied with an HTTP error". `fetch` rejects with a
// TypeError on DNS / connection / CORS-network-layer failure; we treat
// any TypeError (and anything that isn't a real Error subclass) as
// offline. `fetchStream` and `fetchNextUp` only throw a regular `Error`
// for non-2xx responses, so server-side failures keep going through the
// HTTP error path.
function isNetworkError(err: unknown): boolean {
    if (err instanceof TypeError) return true;
    if (!(err instanceof Error)) return true;
    return false;
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

async function fetchNextUp(
    seriesId: string,
    after?: string,
): Promise<NextUpResponse> {
    const url = new URL(
        `/api/kids/items/${encodeURIComponent(seriesId)}/next-up`,
        window.location.origin,
    );
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url.toString(), {
        credentials: "same-origin",
        headers: authHeaders(),
    });
    if (!res.ok) {
        throw new Error(`next-up: ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as NextUpResponse;
}

type PlaybackEventKind = "start" | "progress" | "stopped";

type PlaybackEvent = {
    kind: PlaybackEventKind;
    payload: Record<string, unknown>;
};

// drainQueue mutates the array in place: it splices out everything
// currently queued and fires each network call without awaiting. The
// caller's reference still points at the (now-empty) array so newly
// enqueued events while these are in flight are picked up on the next
// drain. We use splice rather than reassigning the ref so the React
// component's useRef value remains stable.
function drainQueue(queue: PlaybackEvent[]): void {
    if (queue.length === 0) return;
    const events = queue.splice(0, queue.length);
    for (const evt of events) {
        void postPlayback(evt.kind, evt.payload);
    }
}

async function postPlayback(
    kind: PlaybackEventKind,
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
