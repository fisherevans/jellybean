import {
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Heart } from "@phosphor-icons/react";
import { authHeaders, withAuthRetry } from "./auth";
import HlsVideo from "./HlsVideo";
import OverrideModal from "./OverrideModal";
import PlayerTransport from "./PlayerTransport";
import { type MediaErrorKind, playSessionIdFromUrl } from "./playerHelpers";
import { type PlaybackBackend } from "./player/backend";
import {
    JellybeanStreamResolver,
    type NextUpResponse,
    type StreamResolver,
    type StreamResponse,
} from "./player/resolver";

// Play is the kid playback screen. Movies stream the requested item
// directly; series resolve next-up first and stream that episode.
// The player follows jellyfin-web's pattern: single <video> element,
// hls.js attached/reattached as src changes, error recovery handled by
// hls.js's own ladder + a "Reset Player" escape hatch when the WebView
// decoder gets genuinely poisoned (Skyworth M5 hardware case).
//
// The transport (PlayerTransport) owns all in-player input. Play.tsx:
//   - fetches the stream URL
//   - hands stream + resume offset to HlsVideo
//   - reports start / progress / stopped to Jellyfin (heartbeat queue)
//   - calls /api/kids/playback/stop-encoding before stream swaps so
//     Jellyfin doesn't accumulate stale transcode sessions
//   - surfaces a Reset Player UI when the player can't recover

const TICKS_PER_SECOND = 10_000_000;
const PROGRESS_INTERVAL_MS = 10_000;

// The stream-resolution seam (jellybean#107). Stateless, so a single
// module-level instance is fine. Swapping in a DirectJellyfinStreamResolver
// later is a one-line change here.
const resolver: StreamResolver = new JellybeanStreamResolver();

// PlayerStatus is the single source of truth for the loading / playing
// / error UI. Replaces the M-era jumble of (hasStarted, isBuffering,
// navigatingNext, fallbackNotice) with one discriminated union.
type PlayerStatus =
    | { kind: "fetching" }
    | { kind: "loading"; stream: StreamResponse }
    | { kind: "playing"; stream: StreamResponse }
    | { kind: "ended"; stream: StreamResponse }
    | { kind: "error"; message: string; offline: boolean };

type StatusAction =
    | { type: "reset" }
    | { type: "stream-fetched"; stream: StreamResponse }
    | { type: "playing-started" }
    | { type: "ended" }
    | { type: "error"; message: string; offline: boolean };

function statusReducer(state: PlayerStatus, action: StatusAction): PlayerStatus {
    switch (action.type) {
        case "reset":
            return { kind: "fetching" };
        case "stream-fetched":
            return { kind: "loading", stream: action.stream };
        case "playing-started":
            if (state.kind === "loading" || state.kind === "playing") {
                return { kind: "playing", stream: state.stream };
            }
            return state;
        case "ended":
            if (state.kind === "playing" || state.kind === "loading") {
                return { kind: "ended", stream: state.stream };
            }
            return state;
        case "error":
            return {
                kind: "error",
                message: action.message,
                offline: action.offline,
            };
    }
}

export default function Play() {
    const { itemId } = useParams();
    const nav = useNavigate();
    const location = useLocation();
    const libraryHref = `/library${location.search}`;
    // M7 #44: hardware/back button on the player should land on the
    // watch interstitial (paused) for the same content - movie -> its
    // own watch menu, series episode -> the series watch menu (so the
    // kid can pick another episode). Falls through to library when we
    // don't yet know what we're playing (e.g. fetch error).

    const [status, dispatch] = useReducer(statusReducer, { kind: "fetching" });
    const [seriesLabel, setSeriesLabel] = useState<string | null>(null);
    // Mid-playback buffering indicator. Distinct from PlayerStatus
    // because buffer underruns during normal playback aren't a state
    // change - just a temporary UI hint.
    const [isBuffering, setIsBuffering] = useState(false);

    const backendRef = useRef<PlaybackBackend | null>(null);
    const backRef = useRef<HTMLAnchorElement | null>(null);
    const favoriteRef = useRef<HTMLButtonElement | null>(null);
    const reportedStart = useRef(false);
    const [transportVisible, setTransportVisible] = useState(false);
    // Local mirror of stream.isFavorite so the heart toggle on the
    // header can flip optimistically without re-fetching the stream
    // (which would re-negotiate transcode and stutter playback).
    // Reset to the server value whenever the stream itself changes
    // (initial fetch, next-episode swap).
    const [isFavorite, setIsFavorite] = useState(false);

    // Long-press OK during playback opens the override modal (M9).
    // Mirrors the gesture surface used on Browse / Library /
    // TagDetail / Watch tiles. Held for 1000ms; PlayerTransport
    // owns the detection. We also pause the video when it opens
    // so the kid isn't hearing the show while the parent uses the
    // menu - matches the short-press reveal-pause behavior.
    const [override, setOverride] = useState<
        {
            itemId: string;
            itemName: string;
            itemType: string;
            seriesId?: string;
            seriesName?: string;
            played?: boolean;
        } | null
    >(null);

    // Up Next overlay state. When the kid is watching an episode and
    // the playhead crosses 90%, we prefetch the next episode and show
    // a 10s countdown overlay; on countdown=0 OR video.ended the kid
    // auto-advances. Cancel button stops the countdown but keeps the
    // current episode playing. Movies don't get this treatment.
    const [upNext, setUpNext] = useState<NextUpResponse | null>(null);
    const [upNextStatus, setUpNextStatus] = useState<
        "idle" | "shown" | "dismissed"
    >("idle");
    const [upNextCountdown, setUpNextCountdown] = useState(10);
    // One-shot guard so seeking back below the threshold + forward
    // again doesn't re-fire the prefetch within the same episode.
    // Reset on stream swap (see [itemId] effect below) so the next
    // episode gets its own trigger.
    const upNextTriggeredRef = useRef(false);
    // Advance idempotency guard. Both the countdown reaching 0 and
    // the video's natural `ended` event can call handleNextEpisode
    // within the same tick. Without this ref the second call posts
    // a duplicate stop-encoding for the (now-stale) play session
    // and double-fetches next-up. Reset on stream swap so the new
    // episode can advance again.
    const advancingRef = useRef(false);

    const stream = (() => {
        switch (status.kind) {
            case "loading":
            case "playing":
            case "ended":
                return status.stream;
            default:
                return null;
        }
    })();

    // Pull initial favorite state from the stream response. This fires
    // on the initial fetch + on next-episode swaps; mid-stream toggles
    // are local-only via setIsFavorite below.
    const streamFavId = stream?.favoriteItemId ?? "";
    const streamFavInitial = stream?.isFavorite ?? false;
    useEffect(() => {
        if (!streamFavId) return;
        setIsFavorite(streamFavInitial);
    }, [streamFavId, streamFavInitial]);

    const toggleFavorite = useCallback(async () => {
        if (!stream?.favoriteItemId) return;
        const next = !isFavorite;
        setIsFavorite(next);
        try {
            const res = await withAuthRetry(() =>
                fetch(
                    `/api/kids/items/${encodeURIComponent(stream.favoriteItemId!)}/favorite`,
                    {
                        method: "POST",
                        credentials: "same-origin",
                        headers: {
                            ...authHeaders(),
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ state: next ? "add" : "remove" }),
                    },
                ),
            );
            if (!res.ok) throw new Error(`${res.status}`);
        } catch {
            // Roll back on error so the heart stays truthful.
            setIsFavorite(!next);
        }
    }, [isFavorite, stream?.favoriteItemId]);

    // Open the override modal scoped to the currently-playing item.
    // For an episode the override targets the episode itself; the
    // modal does the series-scoping for tags/hide/content-time
    // internally based on itemType + seriesId. We also pause the
    // video so the show isn't running behind the modal.
    const handleLongPress = useCallback(() => {
        if (!stream) return;
        const v = backendRef.current;
        if (v && !v.paused) v.pause();
        const pct = stream.userData?.PlayedPercentage ?? 0;
        const playedFlag = stream.userData?.Played ?? false;
        setOverride({
            itemId: stream.itemId,
            itemName: stream.itemName,
            itemType: stream.itemType ?? "",
            seriesId: stream.seriesId,
            seriesName: stream.seriesName,
            played: playedFlag || pct >= 90,
        });
    }, [stream]);

    // Back target for the player. Prefer the series page when we're on
    // an episode so the kid lands on the episode picker, else the item
    // itself. Falls through to library when stream isn't loaded yet.
    const watchTarget = stream?.seriesId ?? stream?.itemId ?? itemId ?? "";
    const watchHref = watchTarget
        ? `/watch/${encodeURIComponent(watchTarget)}${location.search}`
        : libraryHref;

    // Track the PlaySessionId of the currently-playing stream so we can
    // call stop-encoding on it before swapping to a new stream. Updated
    // whenever stream changes; consumed by handleNextEpisode + cleanup.
    const playSessionRef = useRef<string>("");
    useEffect(() => {
        playSessionRef.current = playSessionIdFromUrl(stream?.streamUrl);
    }, [stream?.streamUrl]);

    // Esc -> back to the watch menu (M7 #44). Outside the transport's
    // scope. Suppressed while the override modal is open so its own
    // back handling (via useProgressiveBack) closes the modal instead
    // of navigating away from the player.
    useEffect(() => {
        if (override) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") {
                // True history-back so the /watch auto-skip marker
                // restored on the original entry suppresses the
                // bounce-back to /play. Same reasoning as the
                // visible Back link's onClick handler below.
                if (window.history.length > 1) nav(-1);
                else nav(watchHref);
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [nav, watchHref, override]);

    // Resolve the stream URL for this itemId. Movies short-circuit;
    // Series resolve through /next-up to get an actual episode.
    useEffect(() => {
        if (!itemId) return;
        let cancelled = false;
        dispatch({ type: "reset" });
        reportedStart.current = false;
        setIsBuffering(false);
        setIsFavorite(false);
        // Reset Up Next state so the new episode (we may have just
        // auto-advanced into it via handleNextEpisode -> nav with
        // replace:true, which swaps :itemId without unmounting Play)
        // gets its own overlay run. Without these resets, the
        // upNextTriggeredRef stayed `true` from the previous
        // episode and the overlay never re-fired - the auto-play
        // chain only worked once.
        upNextTriggeredRef.current = false;
        advancingRef.current = false;
        setUpNext(null);
        setUpNextStatus("idle");
        setUpNextCountdown(10);

        (async () => {
            try {
                const first = await resolver.resolveStream(itemId);
                if (cancelled) return;
                if (first.itemType !== "Series") {
                    dispatch({ type: "stream-fetched", stream: first });
                    // Movies (and Episodes the kid jumps straight to)
                    // carry their own seriesName; non-episode movies
                    // leave it blank, which clears the label.
                    setSeriesLabel(first.seriesName ?? null);
                    return;
                }
                const next = await resolver.resolveNextUp(itemId);
                if (cancelled) return;
                const episode = await resolver.resolveStream(next.episodeId);
                if (cancelled) return;
                setSeriesLabel(next.seriesName ?? first.itemName);
                if (!episode.userData && next.userData) {
                    episode.userData = next.userData;
                }
                if (!episode.seriesId && next.seriesId) {
                    episode.seriesId = next.seriesId;
                }
                dispatch({ type: "stream-fetched", stream: episode });
            } catch (err) {
                if (cancelled) return;
                if (isNetworkError(err)) {
                    dispatch({
                        type: "error",
                        message: "Can't reach the server. Reconnect and try again.",
                        offline: true,
                    });
                } else {
                    dispatch({
                        type: "error",
                        message: String((err as Error).message ?? err),
                        offline: false,
                    });
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [itemId]);

    // Playback reporting queue. Heartbeat enqueues; a separate drainer
    // fires the network calls without blocking video events.
    const queueRef = useRef<PlaybackEvent[]>([]);

    const enqueueProgressEvent = useCallback((evt: PlaybackEvent) => {
        queueRef.current.push(evt);
    }, []);

    const positionTicks = useCallback((): number => {
        const v = backendRef.current;
        if (!v) return 0;
        // Round to int: float multiplication produces FP artifacts that
        // Go's strict JSON int64 decoder rejects.
        return Math.round(v.currentTime * TICKS_PER_SECOND);
    }, []);

    const reportStart = useCallback(() => {
        if (!stream || reportedStart.current) return;
        reportedStart.current = true;
        enqueueProgressEvent({
            kind: "start",
            payload: {
                itemId: stream.itemId,
                playSessionId: playSessionRef.current,
                mediaSourceId: stream.mediaSourceId,
                positionTicks: positionTicks(),
                isPaused: false,
            },
        });
    }, [stream, enqueueProgressEvent, positionTicks]);

    const reportProgress = useCallback(
        (paused: boolean) => {
            if (!stream || !reportedStart.current) return;
            enqueueProgressEvent({
                kind: "progress",
                payload: {
                    itemId: stream.itemId,
                    playSessionId: playSessionRef.current,
                    mediaSourceId: stream.mediaSourceId,
                    positionTicks: positionTicks(),
                    isPaused: paused,
                },
            });
        },
        [stream, enqueueProgressEvent, positionTicks],
    );

    const reportStopped = useCallback(() => {
        if (!stream || !reportedStart.current) return;
        enqueueProgressEvent({
            kind: "stopped",
            payload: {
                itemId: stream.itemId,
                playSessionId: playSessionRef.current,
                mediaSourceId: stream.mediaSourceId,
                positionTicks: positionTicks(),
            },
        });
    }, [stream, enqueueProgressEvent, positionTicks]);

    // Drainer: fires every 10s (matches heartbeat cadence to keep
    // server load steady).
    useEffect(() => {
        if (!stream) return;
        const id = window.setInterval(() => {
            drainQueue(queueRef.current);
        }, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [stream]);

    // Heartbeat: enqueues a progress event every interval.
    useEffect(() => {
        if (!stream) return;
        const id = window.setInterval(() => {
            const v = backendRef.current;
            if (!v) return;
            reportProgress(v.paused);
        }, PROGRESS_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [stream, reportProgress]);

    // On unmount, send a final stopped report and flush the queue. The
    // server-side stop-encoding (called via handleNextEpisode for
    // in-app swaps) doesn't fire on unmount, so we send a session-stop
    // explicitly here as a fire-and-forget.
    useEffect(() => {
        return () => {
            reportStopped();
            drainQueue(queueRef.current);
            const sessionId = playSessionRef.current;
            if (sessionId) {
                void postStopEncoding(sessionId);
            }
        };
    }, [reportStopped]);

    const seriesIdForNextRef = useRef<string | undefined>();
    const currentEpisodeIdRef = useRef<string | undefined>();
    seriesIdForNextRef.current = stream?.seriesId;
    currentEpisodeIdRef.current = stream?.itemId;

    // Up Next prefetch trigger: fired by the video's timeupdate
    // event. We poll-rate this via the upNextTriggeredRef one-shot
    // guard, so the actual cost is a single fetchNextUp on the
    // first frame past the threshold. Movies have no seriesId; the
    // early-return drops them out.
    //
    // Threshold + countdown are both content-length-aware: short
    // shows (<= 15min, e.g. Mickey Mouse Funhouse) finish in the
    // last ~30s if we use the original 90% + 10s countdown, which
    // jumped the kid out of the show ~30 seconds before the
    // closing chord. Bumped to 95% + 5s for short content; 92% +
    // 10s for longer episodes. Until we have proper Jellyfin
    // MediaSegments credit markers (M17), this is the best we can
    // do without an SDK that knows when the show is "really" over.
    const onTimeUpdate = useCallback(() => {
        if (upNextTriggeredRef.current) return;
        const seriesId = seriesIdForNextRef.current;
        const epId = currentEpisodeIdRef.current;
        if (!seriesId || !epId) return;
        const v = backendRef.current;
        if (!v || !v.duration || !Number.isFinite(v.duration)) return;
        const pct = (v.currentTime / v.duration) * 100;
        const isShort = v.duration <= 15 * 60; // <= 15 minutes
        const threshold = isShort ? 95 : 92;
        if (pct < threshold) return;
        const countdownSeconds = isShort ? 5 : 10;
        upNextTriggeredRef.current = true;
        void (async () => {
            try {
                const next = await resolver.resolveNextUp(seriesId, epId);
                if (!next.episodeId || next.episodeId === epId) {
                    // Last episode of the series, or the server
                    // returned the same episode (already-loaded
                    // resume case). Don't show the overlay - the
                    // existing onEnded -> watchHref behavior is fine.
                    return;
                }
                setUpNext(next);
                setUpNextStatus("shown");
                setUpNextCountdown(countdownSeconds);
            } catch {
                // No-op: best-effort prefetch.
            }
        })();
    }, []);

    // Countdown timer. Two effects, deliberately split:
    //
    // (1) Tick effect: while status === "shown" AND countdown > 0,
    //     schedule a 1s timeout that decrements. Cleanup cancels
    //     the timeout. The tick callback only does setState - if
    //     the component unmounts mid-flight, React swallows the
    //     setState and we never reach the fire effect.
    //
    // (2) Fire effect: when status === "shown" AND countdown
    //     reaches 0, call handleNextEpisode. Lives in its own
    //     effect so it runs from the post-render commit phase
    //     (clean place to dispatch a navigation) rather than
    //     synchronously from inside the tick effect's body.
    //     handleNextEpisode is itself idempotent via advancingRef,
    //     so even a duplicate fire (race with onEnded) is safe.
    useEffect(() => {
        if (upNextStatus !== "shown") return;
        if (upNextCountdown <= 0) return;
        const id = window.setTimeout(() => {
            setUpNextCountdown((c) => c - 1);
        }, 1000);
        return () => window.clearTimeout(id);
    }, [upNextStatus, upNextCountdown]);
    useEffect(() => {
        if (upNextStatus !== "shown") return;
        if (upNextCountdown > 0) return;
        handleNextEpisode();
        // handleNextEpisode is intentionally not in deps - it
        // changes identity when stream swaps, but the swap also
        // resets countdown to 10, so this effect won't refire.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [upNextStatus, upNextCountdown]);

    function onEnded() {
        reportStopped();
        dispatch({ type: "ended" });
        // Auto-advance when an Up Next overlay is loaded and the
        // kid hasn't dismissed it. Otherwise fall through to the
        // existing post-end UX (back to the watch interstitial,
        // where the hero offers Watch Again / next episode picker).
        if (upNext && upNextStatus !== "dismissed") {
            handleNextEpisode();
            return;
        }
        nav(watchHref);
    }

    const handleRestart = useCallback(() => {
        const v = backendRef.current;
        if (!v) return;
        v.currentTime = 0;
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
    }, []);

    const seriesIdForNext = stream?.seriesId;
    const currentEpisodeId = stream?.itemId;
    const handleNextEpisode = useCallback(() => {
        if (!seriesIdForNext || !currentEpisodeId) return;
        // Idempotent: countdown-zero and video.ended can race
        // (within ~50ms when the kid lets the credits roll). The
        // second call would post a stale stop-encoding and double
        // fetch next-up. Flip-and-check via ref so only the first
        // caller does the work. Reset by the [itemId] effect on
        // the next mount.
        if (advancingRef.current) return;
        advancingRef.current = true;
        reportStopped();
        drainQueue(queueRef.current);
        const v = backendRef.current;
        if (v && !v.paused) {
            try {
                v.pause();
            } catch {
                /* ignore */
            }
        }
        const sessionId = playSessionRef.current;
        if (sessionId) {
            void postStopEncoding(sessionId);
        }
        (async () => {
            try {
                const next = await resolver.resolveNextUp(seriesIdForNext, currentEpisodeId);
                // replace=true so TV hardware-back walks /play/EPN ->
                // /library directly, not back through every episode.
                nav(
                    `/play/${encodeURIComponent(next.episodeId)}${location.search}`,
                    { replace: true },
                );
            } catch {
                nav(libraryHref);
            }
        })();
    }, [
        seriesIdForNext,
        currentEpisodeId,
        nav,
        libraryHref,
        location.search,
        reportStopped,
    ]);

    const handleResetPlayer = useCallback(() => {
        // The Android shell exposes JellybeanShell.recreateActivity()
        // for the genuine-WebView-decoder-poisoned case (M5 hardware
        // limit). On browsers, fall back to a hard reload which gets
        // us a fresh document + fresh hls.js.
        const bridge = (
            window as unknown as {
                JellybeanShell?: { recreateActivity?: () => void };
            }
        ).JellybeanShell;
        if (bridge?.recreateActivity) {
            bridge.recreateActivity();
            return;
        }
        window.location.reload();
    }, []);

    const handleMediaError = useCallback((kind: MediaErrorKind) => {
        const message = mediaErrorMessage(kind);
        dispatch({
            type: "error",
            message,
            offline: kind === "NETWORK_ERROR",
        });
    }, []);

    if (status.kind === "error") {
        return (
            <PlayError
                offline={status.offline}
                message={status.message}
                libraryHref={libraryHref}
                onReset={handleResetPlayer}
            />
        );
    }
    if (!stream) {
        return <div className="screen play-loading">Loading…</div>;
    }

    const isAdminPreview = new URLSearchParams(location.search).has("profileId");
    const showNextEpisode = !!stream.seriesId;
    const resumeSeconds =
        (stream.userData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND;

    // Header overlays the video like the bottom controls do. Visible
    // while the loading splash is up so the kid sees what's loading.
    const headerVisible = status.kind !== "playing" || transportVisible;
    const overlayVisible =
        status.kind === "fetching" ||
        status.kind === "loading" ||
        (status.kind === "playing" && isBuffering);

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
                ref={backendRef}
                src={stream.streamUrl}
                resumeSeconds={resumeSeconds}
                autoPlay
                controls={false}
                onPlay={() => {
                    dispatch({ type: "playing-started" });
                    setIsBuffering(false);
                    reportStart();
                }}
                onPlaying={() => {
                    dispatch({ type: "playing-started" });
                    setIsBuffering(false);
                }}
                onWaiting={() => {
                    if (status.kind === "playing") {
                        setIsBuffering(true);
                    }
                }}
                onPause={() => {
                    reportProgress(true);
                }}
                onEnded={onEnded}
                onTimeUpdate={onTimeUpdate}
                onMediaError={handleMediaError}
                style={{ width: "100%", height: "100vh" }}
            />
            <header className={`play-header ${headerVisible ? "visible" : "hidden"}`}>
                <Link
                    to={watchHref}
                    ref={backRef}
                    className="play-back"
                    aria-label="Back"
                    onClick={(e) => {
                        // Use a true history-back rather than a forward
                        // push to /watch. The /watch auto-skip is keyed
                        // by location.key, so a forward push creates a
                        // new key, the marker doesn't match, the skip
                        // re-fires, and the kid bounces right back to
                        // /play. nav(-1) restores the original /watch
                        // entry where the marker is set, so the menu
                        // renders. Falls through to the Link's default
                        // (forward push to watchHref) only when there's
                        // no history to go back to (e.g. deep link
                        // straight to /play).
                        if (window.history.length > 1) {
                            e.preventDefault();
                            nav(-1);
                        }
                    }}
                >
                    <ArrowLeft weight="fill" size={32} aria-hidden />
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
                    {(stream.productionYear || stream.runtimeTicks) && (
                        <p className="play-year">
                            {stream.productionYear ?? ""}
                            {stream.productionYear && stream.runtimeTicks
                                ? " · "
                                : ""}
                            {stream.runtimeTicks
                                ? formatRuntimeShort(stream.runtimeTicks)
                                : ""}
                        </p>
                    )}
                </div>
                {stream.favoriteItemId && (
                    <button
                        type="button"
                        ref={favoriteRef}
                        className={`play-fav ${isFavorite ? "active" : ""}`}
                        onClick={toggleFavorite}
                        aria-label={
                            isFavorite ? "Remove from favorites" : "Add to favorites"
                        }
                        aria-pressed={isFavorite}
                        title={
                            isFavorite ? "Remove from favorites" : "Add to favorites"
                        }
                    >
                        <Heart
                            weight={isFavorite ? "fill" : "regular"}
                            size={28}
                            aria-hidden
                        />
                    </button>
                )}
                {stream.playbackPath && (
                    <div className="play-quality" aria-hidden>
                        {formatPlaybackPath(stream.playbackPath)}
                    </div>
                )}
            </header>
            {overlayVisible && (
                <div className="play-loading-overlay" aria-hidden>
                    <img
                        src="/player/jellybean-kids.png"
                        alt=""
                        className="play-loading-bean"
                    />
                    <p className="play-loading-label">Loading…</p>
                </div>
            )}
            <PlayerTransport
                backendRef={backendRef}
                onRestart={handleRestart}
                onNextEpisode={showNextEpisode ? handleNextEpisode : undefined}
                onVisibleChange={setTransportVisible}
                onBack={() => {
                    // Same nav(-1) reasoning as the visible Back link
                    // onClick - keep the original /watch entry instead
                    // of pushing a fresh one.
                    if (window.history.length > 1) nav(-1);
                    else nav(watchHref);
                }}
                backRef={backRef}
                onToggleFavorite={
                    stream.favoriteItemId ? toggleFavorite : undefined
                }
                favoriteRef={favoriteRef}
                onLongPress={override === null ? handleLongPress : undefined}
            />
            {upNextStatus === "shown" && upNext && (
                <UpNextOverlay
                    next={upNext}
                    countdown={upNextCountdown}
                    onSkipNow={handleNextEpisode}
                    onDismiss={() => setUpNextStatus("dismissed")}
                />
            )}
            {override && (
                <OverrideModal
                    itemId={override.itemId}
                    itemName={override.itemName}
                    itemType={override.itemType}
                    seriesId={override.seriesId}
                    seriesName={override.seriesName}
                    played={override.played}
                    onClose={() => setOverride(null)}
                />
            )}
        </div>
    );
}

// UpNextOverlay shows over the bottom-right of the video when the
// kid is in the last 10% of an episode. The countdown ticks from 10
// to 0; on 0 the parent calls handleNextEpisode (auto-advance).
// Skip Now jumps immediately; Cancel suppresses the auto-advance
// for this episode (the kid stays on the current video; they can
// still let it end naturally - onEnded then falls through to the
// watch interstitial because upNextStatus === "dismissed").
function UpNextOverlay({
    next,
    countdown,
    onSkipNow,
    onDismiss,
}: {
    next: NextUpResponse;
    countdown: number;
    onSkipNow: () => void;
    onDismiss: () => void;
}) {
    const skipRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        skipRef.current?.focus();
    }, []);
    function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
        if (e.key === "Escape") {
            e.preventDefault();
            onDismiss();
        }
    }
    const ep =
        next.parentIndexNumber !== undefined && next.indexNumber !== undefined
            ? `S${next.parentIndexNumber}E${String(next.indexNumber).padStart(2, "0")}`
            : "";
    return (
        <div
            className="up-next-overlay"
            role="dialog"
            aria-label="Up Next"
            onKeyDown={onKey}
        >
            <div className="up-next-card">
                <div className="up-next-label">Up Next in {countdown}</div>
                {ep && <div className="up-next-badge">{ep}</div>}
                <div className="up-next-title">{next.name}</div>
                {next.seriesName && (
                    <div className="up-next-series">{next.seriesName}</div>
                )}
                <div className="up-next-actions">
                    <button
                        ref={skipRef}
                        type="button"
                        className="up-next-btn primary"
                        onClick={onSkipNow}
                    >
                        Skip Now
                    </button>
                    <button
                        type="button"
                        className="up-next-btn"
                        onClick={onDismiss}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}

// formatRuntimeShort renders Jellyfin's 100ns-tick runtime as a
// compact "1h 32m" / "47m". Used in the player header next to the
// year. Dropping the seconds keeps the header line readable at TV
// distance; the precise time-into / time-remaining counters under
// the scrubber carry the second-level resolution.
function formatRuntimeShort(ticks: number): string {
    const totalMin = Math.max(0, Math.round(ticks / 600_000_000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h <= 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function formatPlaybackPath(path: string | undefined): string {
    if (!path) return "Streaming";
    if (path === "DirectPlay" || path === "DirectStream") return "Direct";
    if (path === "Transcode") return "Transcode";
    return path;
}

function mediaErrorMessage(kind: MediaErrorKind): string {
    switch (kind) {
        case "NETWORK_ERROR":
            return "The video stream lost its connection. Try again or pick a different show.";
        case "SERVER_ERROR":
            return "Jellyfin returned an error for this video. Try a different show, or ask a grown-up.";
        case "MEDIA_DECODE_ERROR":
        case "FATAL_HLS_ERROR":
            return "The TV can't decode this video right now. Reset the player to try again.";
        case "MEDIA_NOT_SUPPORTED":
            return "This video format isn't supported on this TV.";
    }
}

// PlayError is the terminal error screen. It manages its own D-pad focus:
// the Android TV WebView has no built-in spatial navigation, so without an
// explicit focus() the remote can't reach the buttons at all (they render
// but never highlight). Autofocus the primary action on mount, and move
// focus left/right between the two actions; Enter/Space activate natively.
function PlayError({
    offline,
    message,
    libraryHref,
    onReset,
}: {
    offline: boolean;
    message: string;
    libraryHref: string;
    onReset: () => void;
}) {
    const resetRef = useRef<HTMLButtonElement>(null);
    const backRef = useRef<HTMLAnchorElement>(null);

    useEffect(() => {
        resetRef.current?.focus();
    }, []);

    function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === "ArrowRight") {
            e.preventDefault();
            backRef.current?.focus();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            resetRef.current?.focus();
        }
    }

    return (
        <div className="screen play-error" onKeyDown={onKeyDown}>
            <h1>{offline ? "Can't play offline" : "Player needs a reset"}</h1>
            <p>{message}</p>
            <div className="play-error-actions">
                <button
                    ref={resetRef}
                    type="button"
                    className="play-error-primary"
                    onClick={onReset}
                >
                    Reset Player
                </button>
                <Link ref={backRef} to={libraryHref} className="play-error-secondary">
                    Back to library
                </Link>
            </div>
        </div>
    );
}

function isNetworkError(err: unknown): boolean {
    if (err instanceof TypeError) return true;
    if (!(err instanceof Error)) return true;
    return false;
}

async function postStopEncoding(playSessionId: string): Promise<void> {
    try {
        await fetch(`/api/kids/playback/stop-encoding`, {
            method: "POST",
            credentials: "same-origin",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ playSessionId }),
        });
    } catch {
        // Best-effort. Jellyfin's session timeout cleans up eventually.
    }
}

type PlaybackEventKind = "start" | "progress" | "stopped";

type PlaybackEvent = {
    kind: PlaybackEventKind;
    payload: Record<string, unknown>;
};

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
        // Reporting hiccups never block playback. Swallow.
    }
}
