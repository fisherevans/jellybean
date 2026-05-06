import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
    ArrowCounterClockwise,
    Play,
    Shuffle,
    SkipForward,
} from "@phosphor-icons/react";
import {
    authHeaders,
    clearSession,
    getSession,
    imageAuthSuffix,
    withAuthRetry,
    type Session,
} from "./auth";
import OverrideModal, { useLongPressUp } from "./OverrideModal";
import { scrollWindowToCenter, scrollWindowToTop } from "./smoothScroll";
import { useProgressiveBack } from "./useProgressiveBack";

// Watch menu (M7). Pre-playback interstitial that surfaces a hero
// (poster + title + Play / Resume / Restart) over a blurred backdrop.
// Series additionally render an episode-accordion below the hero.
//
// Routing rule (used by Browse + Library tile clicks):
//   - Series: always /watch/:id (lets the kid pick an episode).
//   - Movie with PlayedPercentage in [5%, 90%): /watch (offers
//     Resume + Restart).
//   - Movie completed (>= 90%): /watch (offers Watch Again).
//   - Otherwise (no progress): /play directly.
//
// Back from /play always lands on /watch (hardware back + the
// player's onBack share the same handler in Play.tsx).

type ItemUserData = {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
};

type Item = {
    Id: string;
    Name: string;
    Type: string;
    ProductionYear?: number;
    RunTimeTicks?: number;
    ImageTags?: { Primary?: string; Backdrop?: string };
    UserData?: ItemUserData;
};

type SeriesEpisode = {
    id: string;
    indexNumber?: number;
    name: string;
    runtimeTicks?: number;
    imageTag?: string;
    userData?: ItemUserData;
};

type Season = { seasonNumber: number; episodes: SeriesEpisode[] };

type EpisodesResponse = {
    seriesId: string;
    seriesName: string;
    seasons: Season[];
};

const TICKS_PER_MINUTE = 60 * 10_000_000;

export default function Watch() {
    const { itemId } = useParams<{ itemId: string }>();
    const [searchParams] = useSearchParams();
    const nav = useNavigate();
    const [session] = useState<Session | null>(() => getSession());

    const [item, setItem] = useState<Item | null>(null);
    const [episodes, setEpisodes] = useState<EpisodesResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Adult override gesture (M9): long-press UP on /watch targets
    // the watched item itself - the kid is reading its details so
    // that's clearly what they'd want to edit.
    const [override, setOverride] = useState<{
        itemId: string;
        itemName: string;
    } | null>(null);
    useLongPressUp(
        () => {
            if (!item || !session) return;
            setOverride({ itemId: item.Id, itemName: item.Name });
        },
        !!item && !!session && override === null,
        600,
    );

    const adminProfileId = searchParams.get("profileId");
    const browseHref = `/browse${location.search}`;
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Zone-aware D-pad nav. Buttons opt into zones via data-zone:
    //   - "back"      : the Back link (top-left).
    //   - "hero"      : the hero action buttons (Resume / Restart /
    //                   Next / Random for shows; Play / Restart for
    //                   movies). Left/Right cycles within. Down
    //                   crosses to the first accordion item.
    //   - "accordion" : season heads + visible episode buttons. Up/Down
    //                   walks them in DOM order.
    //
    // Cross-zone transitions:
    //   back  Down            -> hero[0]
    //   hero  Up               -> back
    //   hero  Down             -> accordion[0]
    //   accordion[0] Up        -> hero[0]
    useEffect(() => {
        if (override) return;
        const handler = (e: KeyboardEvent) => {
            if (
                e.key !== "ArrowUp" &&
                e.key !== "ArrowDown" &&
                e.key !== "ArrowLeft" &&
                e.key !== "ArrowRight" &&
                e.key !== "Enter" &&
                e.key !== " "
            ) {
                return;
            }
            e.preventDefault();
            const root = document.querySelector(".watch-screen");
            if (!root) return;
            const active = document.activeElement as HTMLElement | null;
            const zone = active?.getAttribute("data-zone") ?? null;

            if (e.key === "Enter" || e.key === " ") {
                active?.click?.();
                return;
            }

            const heroBtns = Array.from(
                root.querySelectorAll<HTMLElement>('[data-zone="hero"]'),
            ).filter((el) => el.offsetParent !== null);
            const accBtns = Array.from(
                root.querySelectorAll<HTMLElement>('[data-zone="accordion"]'),
            ).filter((el) => el.offsetParent !== null);
            const backBtn = root.querySelector<HTMLElement>(
                '[data-zone="back"]',
            );

            let next: HTMLElement | null = null;

            if (zone === "back") {
                if (e.key === "ArrowDown") next = heroBtns[0] ?? null;
            } else if (zone === "hero") {
                const idx = active ? heroBtns.indexOf(active) : -1;
                if (e.key === "ArrowLeft") {
                    next = heroBtns[Math.max(0, idx - 1)] ?? null;
                } else if (e.key === "ArrowRight") {
                    next = heroBtns[Math.min(heroBtns.length - 1, idx + 1)] ?? null;
                } else if (e.key === "ArrowUp") {
                    next = backBtn ?? null;
                } else if (e.key === "ArrowDown") {
                    next = accBtns[0] ?? null;
                }
            } else if (zone === "accordion") {
                const idx = active ? accBtns.indexOf(active) : -1;
                if (e.key === "ArrowUp") {
                    if (idx <= 0) next = heroBtns[0] ?? null;
                    else next = accBtns[idx - 1] ?? null;
                } else if (e.key === "ArrowDown") {
                    if (idx >= 0 && idx < accBtns.length - 1) {
                        next = accBtns[idx + 1] ?? null;
                    }
                }
            } else {
                // No active zone yet (e.g. body-focused). Land on the
                // primary hero button.
                next = heroBtns[0] ?? null;
            }

            if (next) {
                next.focus({ preventScroll: true });
                const nextZone = next.getAttribute("data-zone");
                if (nextZone === "hero" || nextZone === "back") {
                    scrollWindowToTop();
                } else {
                    scrollWindowToCenter(next);
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [override]);

    // Progressive Back: collapse to the first hero action; from
    // there, the next back navigates explicitly to /browse rather
    // than relying on the natural popstate. Sentinel chains across
    // pages can pop unpredictably on cheap WebViews and the user
    // observed back-from-watch occasionally exiting the app instead
    // of returning to Browse - explicit nav avoids that.
    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            const root = document.querySelector(".watch-screen");
            const focusables = root
                ? Array.from(
                      root.querySelectorAll<HTMLElement>(
                          "button:not([disabled])",
                      ),
                  ).filter((el) => el.offsetParent !== null)
                : [];
            const first = focusables[0];
            const active = document.activeElement as HTMLElement | null;
            if (first && active && active !== first) {
                first.focus({ preventScroll: true });
                scrollWindowToTop();
                return true;
            }
            // Already at the first focusable (or no focusables yet) -
            // close the show menu by navigating to Browse.
            nav(browseHref);
            return true;
        }, [override, nav, browseHref]),
    );

    // On mount, defensively focus the primary hero button + scroll
    // to top. We wait for both `item` AND (for series) `episodes`
    // because the primary hero button only renders once episodes
    // have loaded for series - waiting for item alone landed focus
    // on a still-disabled "Loading episodes..." button or fell
    // through to the last accordion episode in DOM order, scrolling
    // the page to the bottom.
    useEffect(() => {
        if (!item) return;
        if (item.Type === "Series" && !episodes) return;
        const id = requestAnimationFrame(() => {
            const root = document.querySelector(".watch-screen");
            if (!root) return;
            const heroBtn = root.querySelector<HTMLElement>(
                '[data-zone="hero"]:not([disabled])',
            );
            heroBtn?.focus({ preventScroll: true });
            scrollWindowToTop();
        });
        return () => cancelAnimationFrame(id);
    }, [item?.Id, episodes]);

    const fetchItem = useCallback(async () => {
        if (!itemId) return;
        // Skip when neither auth path is present - the auth gate
        // above redirects to /login; firing the fetch anyway would
        // briefly surface a 400 from the server.
        if (!session && !adminProfileId) return;
        try {
            // /items/{id} returns metadata only (no PostPlaybackInfo,
            // no transcode session). We deliberately don't hit
            // /stream until the user actually picks Play / Resume,
            // since opening the watch menu shouldn't kick off a
            // transcode for content the kid hasn't decided to play.
            const url = new URL(
                `/api/kids/items/${encodeURIComponent(itemId)}`,
                window.location.origin,
            );
            if (!session && adminProfileId) {
                url.searchParams.set("profileId", adminProfileId);
            }
            const res = await withAuthRetry(() =>
                fetch(url.toString(), {
                    credentials: "same-origin",
                    headers: authHeaders(),
                }),
            );
            if (!res.ok) {
                if (res.status === 401) {
                    clearSession();
                    nav("/login", { replace: true });
                    return;
                }
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            const body = (await res.json()) as {
                itemId: string;
                itemName: string;
                itemType?: string;
                productionYear?: number;
                runtimeTicks?: number;
                userData?: ItemUserData;
                seriesId?: string;
            };
            setItem({
                Id: body.itemId,
                Name: body.itemName,
                Type: body.itemType ?? "Movie",
                ProductionYear: body.productionYear,
                RunTimeTicks: body.runtimeTicks,
                UserData: body.userData,
                ImageTags: {},
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [itemId, session, adminProfileId]);

    useEffect(() => {
        fetchItem();
    }, [fetchItem]);

    // For series, also pull the episode list.
    useEffect(() => {
        if (!item || item.Type !== "Series" || !itemId) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await withAuthRetry(() =>
                    fetch(
                        `/api/kids/series/${encodeURIComponent(itemId)}/episodes`,
                        {
                            credentials: "same-origin",
                            headers: authHeaders(),
                        },
                    ),
                );
                if (!res.ok) {
                    if (res.status === 401) {
                        clearSession();
                        nav("/login", { replace: true });
                        return;
                    }
                    throw new Error(`${res.status}`);
                }
                const body = (await res.json()) as EpisodesResponse;
                if (!cancelled) setEpisodes(body);
            } catch (err) {
                if (!cancelled) {
                    // eslint-disable-next-line no-console
                    console.warn("episode list fetch failed", err);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [item, itemId]);

    if (error) {
        return (
            <div className="kids-page kids-error">
                <p className="error">{error}</p>
                <Link to={browseHref}>Back home</Link>
            </div>
        );
    }
    if (!item) {
        return (
            <div className="kids-page kids-loading">
                <p>Loading…</p>
            </div>
        );
    }

    const goPlay = (id: string, restart = false) => {
        const params = new URLSearchParams(location.search);
        if (restart) params.set("restart", "1");
        const qs = params.toString();
        nav(`/play/${encodeURIComponent(id)}${qs ? "?" + qs : ""}`);
    };

    const isSeries = item.Type === "Series";
    const pct = item.UserData?.PlayedPercentage ?? 0;
    const inProgress = pct >= 5 && pct < 90;
    const completed = pct >= 90 || (item.UserData?.Played ?? false);

    return (
        <div className="watch-screen">
            <BackdropImage itemId={item.Id} />
            <header className="watch-back">
                <Link
                    to={browseHref}
                    className="watch-back-link"
                    aria-label="Back"
                    data-zone="back"
                >
                    ← Back
                </Link>
            </header>
            <div className="watch-hero">
                <Poster id={item.Id} hasPoster />
                <div className="watch-hero-text">
                    <h1>{item.Name}</h1>
                    <p className="watch-hero-meta">
                        {item.ProductionYear ? `${item.ProductionYear}` : ""}
                        {item.RunTimeTicks
                            ? `${item.ProductionYear ? " · " : ""}${formatRuntime(item.RunTimeTicks)}`
                            : ""}
                    </p>
                    <div className="watch-actions">
                        {!isSeries && inProgress && (
                            <button
                                className="watch-action primary"
                                onClick={() => goPlay(item.Id)}
                                autoFocus
                                data-zone="hero"
                            >
                                <Play weight="fill" aria-hidden />
                                Resume
                            </button>
                        )}
                        {!isSeries && completed && (
                            <button
                                className="watch-action primary"
                                onClick={() => goPlay(item.Id, true)}
                                autoFocus
                                data-zone="hero"
                            >
                                <ArrowCounterClockwise weight="bold" aria-hidden />
                                Watch again
                            </button>
                        )}
                        {!isSeries && !inProgress && !completed && (
                            <button
                                className="watch-action primary"
                                onClick={() => goPlay(item.Id)}
                                autoFocus
                                data-zone="hero"
                            >
                                <Play weight="fill" aria-hidden />
                                Play
                            </button>
                        )}
                        {!isSeries && (inProgress || completed) && (
                            <button
                                className="watch-action"
                                onClick={() => goPlay(item.Id, true)}
                                data-zone="hero"
                            >
                                <ArrowCounterClockwise weight="bold" aria-hidden />
                                Restart
                            </button>
                        )}
                        {isSeries && (
                            <SeriesHeroActions
                                series={item}
                                episodes={episodes}
                                onPlay={(epID, opts) =>
                                    goPlay(epID, opts?.restart ?? false)
                                }
                            />
                        )}
                    </div>
                </div>
            </div>
            {isSeries && (
                <EpisodeAccordion
                    response={episodes}
                    onPlay={(epID) => goPlay(epID)}
                />
            )}
            {override && (
                <OverrideModal
                    itemId={override.itemId}
                    itemName={override.itemName}
                    onClose={() => setOverride(null)}
                />
            )}
        </div>
    );
}

function BackdropImage({ itemId }: { itemId: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return <div className="watch-backdrop watch-backdrop-fallback" aria-hidden />;
    }
    return (
        <img
            className="watch-backdrop"
            src={`/api/kids/items/${encodeURIComponent(itemId)}/image?type=Backdrop&width=1920${imageAuthSuffix()}`}
            alt=""
            aria-hidden
            onError={() => setFailed(true)}
        />
    );
}

function Poster({ id }: { id: string; hasPoster: boolean }) {
    return (
        <img
            className="watch-poster"
            src={`/api/kids/items/${encodeURIComponent(id)}/image?type=Primary&width=480${imageAuthSuffix()}`}
            alt=""
            loading="eager"
        />
    );
}

type SeriesHeroActionsProps = {
    series: Item;
    episodes: EpisodesResponse | null;
    onPlay: (id: string, opts?: { restart?: boolean }) => void;
};

// Series hero shows up to three buttons:
//   - Resume / Continue / Watch again (primary)
//   - Restart (secondary, only when there's a "where the kid left off"
//     position to restart - i.e., in-progress or completed)
//   - Next (secondary, plays the episode AFTER the resume target so
//     the kid can skip past whatever's currently in-progress)
function SeriesHeroActions({ episodes, onPlay }: SeriesHeroActionsProps) {
    const target = useMemo(() => pickResumeTarget(episodes), [episodes]);
    const next = useMemo(
        () => pickNextEpisode(episodes, target?.episode.id),
        [episodes, target?.episode.id],
    );
    if (!target) {
        return (
            <button className="watch-action primary" disabled>
                Loading episodes…
            </button>
        );
    }
    const playRandom = () => {
        if (!episodes) return;
        const flat: SeriesEpisode[] = [];
        for (const s of episodes.seasons) {
            for (const e of s.episodes) flat.push(e);
        }
        if (flat.length === 0) return;
        const pick = flat[Math.floor(Math.random() * flat.length)];
        onPlay(pick.id);
    };
    return (
        <>
            <button
                className="watch-action primary"
                onClick={() => onPlay(target.episode.id)}
                autoFocus
                data-zone="hero"
            >
                <Play weight="fill" aria-hidden />
                {target.label}
            </button>
            <button
                className="watch-action"
                onClick={() => onPlay(target.episode.id, { restart: true })}
                data-zone="hero"
            >
                <ArrowCounterClockwise weight="bold" aria-hidden />
                Restart
            </button>
            {next && (
                <button
                    className="watch-action"
                    onClick={() => onPlay(next.id)}
                    data-zone="hero"
                >
                    <SkipForward weight="fill" aria-hidden />
                    Next ({epLabel(next)})
                </button>
            )}
            <button
                className="watch-action"
                onClick={playRandom}
                data-zone="hero"
            >
                <Shuffle weight="bold" aria-hidden />
                Random
            </button>
        </>
    );
}

function pickNextEpisode(
    response: EpisodesResponse | null,
    afterId: string | undefined,
): SeriesEpisode | null {
    if (!response || !afterId) return null;
    const flat: SeriesEpisode[] = [];
    for (const s of response.seasons) {
        for (const e of s.episodes) flat.push(e);
    }
    const idx = flat.findIndex((e) => e.id === afterId);
    if (idx < 0) return null;
    return flat[idx + 1] ?? null;
}

function pickResumeTarget(
    response: EpisodesResponse | null,
): { episode: SeriesEpisode; label: string } | null {
    if (!response) return null;
    // Pick the first in-progress episode (5-90% played) when there is
    // one. Else pick the first unwatched - that's a "Play" since it
    // has no progress on the target itself. Else (every episode
    // completed), default to "Watch again" on the first.
    const flat: SeriesEpisode[] = [];
    for (const s of response.seasons) {
        for (const e of s.episodes) flat.push(e);
    }
    const inProgress = flat.find((e) => {
        const p = e.userData?.PlayedPercentage ?? 0;
        return p >= 5 && p < 90;
    });
    if (inProgress) {
        return { episode: inProgress, label: `Resume ${epLabel(inProgress)}` };
    }
    const firstUnwatched = flat.find((e) => !(e.userData?.Played ?? false));
    if (firstUnwatched) {
        return {
            episode: firstUnwatched,
            label: `Play ${epLabel(firstUnwatched)}`,
        };
    }
    if (flat.length > 0) {
        return {
            episode: flat[0],
            label: `Watch again`,
        };
    }
    return null;
}

function epLabel(e: SeriesEpisode): string {
    return `E${(e.indexNumber ?? 0).toString().padStart(2, "0")}`;
}

type EpisodeAccordionProps = {
    response: EpisodesResponse | null;
    onPlay: (id: string) => void;
};

function EpisodeAccordion({ response, onPlay }: EpisodeAccordionProps) {
    const [openSeason, setOpenSeason] = useState<number | null>(null);
    // userToggled tracks whether the kid has manually clicked a season
    // head. Once they have, the auto-pick effect bails so closing a
    // season doesn't immediately spring it back open. Without this
    // gate, the auto-open effect re-fired any time openSeason became
    // null (which is exactly what closing does).
    const [userToggled, setUserToggled] = useState(false);

    // Pick the season containing the resume target as the default-
    // open one when episodes load. Only runs before the kid has
    // interacted - their manual choice wins after that.
    useEffect(() => {
        if (!response || userToggled || openSeason !== null) return;
        const target = pickResumeTarget(response);
        if (!target) {
            setOpenSeason(response.seasons[0]?.seasonNumber ?? null);
            return;
        }
        const season = response.seasons.find((s) =>
            s.episodes.some((e) => e.id === target.episode.id),
        );
        setOpenSeason(season?.seasonNumber ?? response.seasons[0]?.seasonNumber ?? null);
    }, [response, openSeason, userToggled]);

    if (!response) {
        return (
            <div className="watch-accordion">
                <p className="muted">Loading episodes…</p>
            </div>
        );
    }
    if (response.seasons.length === 0) {
        return (
            <div className="watch-accordion">
                <p className="muted">No episodes available.</p>
            </div>
        );
    }

    return (
        <section className="watch-accordion">
            {response.seasons.map((s) => {
                const isOpen = openSeason === s.seasonNumber;
                const label =
                    s.seasonNumber === 0
                        ? "Specials"
                        : s.seasonNumber === -1
                          ? "Other"
                          : `Season ${s.seasonNumber}`;
                return (
                    <div key={s.seasonNumber} className="watch-season">
                        <button
                            type="button"
                            className={`watch-season-head ${isOpen ? "open" : ""}`}
                            data-zone="accordion"
                            onClick={() => {
                                setUserToggled(true);
                                setOpenSeason(isOpen ? null : s.seasonNumber);
                            }}
                        >
                            <span>{label}</span>
                            <span className="watch-season-count">
                                {s.episodes.length} episode
                                {s.episodes.length === 1 ? "" : "s"}
                            </span>
                        </button>
                        {isOpen && (
                            <ul className="watch-episode-list">
                                {s.episodes.map((e) => {
                                    const pct = e.userData?.PlayedPercentage ?? 0;
                                    const watched =
                                        (e.userData?.Played ?? false) ||
                                        pct >= 90;
                                    const inProgress = pct >= 5 && pct < 90;
                                    // One progress bar per episode:
                                    //   in-progress -> overlay on the thumb at
                                    //                  bottom-edge with width
                                    //                  matching pct.
                                    //   watched     -> full strip below thumb,
                                    //                  visually marks "done."
                                    //   unwatched   -> no bar.
                                    return (
                                        <li key={e.id}>
                                            <button
                                                type="button"
                                                className={`watch-episode ${watched ? "watched" : ""}`}
                                                data-zone="accordion"
                                                onClick={() => onPlay(e.id)}
                                            >
                                                <div className="watch-episode-thumb-wrap">
                                                    <EpisodeThumb episode={e} />
                                                    {inProgress && (
                                                        <div
                                                            className="watch-episode-thumb-progress"
                                                            style={{ width: `${pct}%` }}
                                                            aria-hidden
                                                        />
                                                    )}
                                                    {watched && !inProgress && (
                                                        <div
                                                            className="watch-episode-thumb-bar"
                                                            aria-hidden
                                                        >
                                                            <div
                                                                className="watch-episode-thumb-bar-fill"
                                                                style={{ width: "100%" }}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="watch-episode-info">
                                                    <div className="watch-episode-title">
                                                        <span className="watch-episode-badge">
                                                            S
                                                            {s.seasonNumber}
                                                            {epLabel(e)}
                                                        </span>{" "}
                                                        {e.name}
                                                        {watched ? (
                                                            <span className="watch-episode-done">
                                                                ✓
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    <div className="watch-episode-meta">
                                                        {e.runtimeTicks
                                                            ? formatRuntime(e.runtimeTicks)
                                                            : ""}
                                                    </div>
                                                </div>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                );
            })}
        </section>
    );
}

function EpisodeThumb({ episode }: { episode: SeriesEpisode }) {
    if (!episode.imageTag) {
        return <div className="watch-episode-thumb placeholder" aria-hidden />;
    }
    return (
        <img
            className="watch-episode-thumb"
            src={`/api/kids/items/${encodeURIComponent(episode.id)}/image?type=Primary&width=240${imageAuthSuffix()}`}
            alt=""
            loading="lazy"
        />
    );
}

function formatRuntime(ticks: number): string {
    const minutes = Math.round(ticks / TICKS_PER_MINUTE);
    if (minutes >= 60) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    return `${minutes}m`;
}

// shouldShowWatchMenu is the routing helper (used by Browse +
// Library) to decide between /watch and /play. Exported so callers
// can keep the rule in one place.
export function shouldShowWatchMenu(item: {
    Type: string;
    UserData?: ItemUserData;
}): boolean {
    if (item.Type === "Series") return true;
    const pct = item.UserData?.PlayedPercentage ?? 0;
    return pct >= 5;
}
