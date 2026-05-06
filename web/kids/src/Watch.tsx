import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
    ArrowCounterClockwise,
    Play,
    SkipForward,
} from "@phosphor-icons/react";
import { authHeaders, getSession, imageAuthSuffix, type Session } from "./auth";
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

    // Window-level D-pad nav. Watch has a small set of focusable
    // buttons (Back, hero actions, season heads, episodes when a
    // season is open). Rather than build a 2D focus model, we walk
    // every visible button under .watch-screen in DOM order on
    // ArrowUp/ArrowDown/ArrowLeft/ArrowRight, scrolling the focused
    // one to vertical-center. Enter/Space clicks. Accordion expansion
    // changes the button list but the next press recomputes it.
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
            const focusables = Array.from(
                root.querySelectorAll<HTMLElement>(
                    "a, button:not([disabled])",
                ),
            ).filter((el) => el.offsetParent !== null);
            if (focusables.length === 0) return;
            const active = document.activeElement as HTMLElement | null;
            let idx = active ? focusables.indexOf(active) : -1;
            if (e.key === "Enter" || e.key === " ") {
                (active as HTMLElement | null)?.click?.();
                return;
            }
            const forward =
                e.key === "ArrowDown" || e.key === "ArrowRight";
            if (idx < 0) {
                idx = forward ? 0 : focusables.length - 1;
            } else {
                idx = forward
                    ? Math.min(focusables.length - 1, idx + 1)
                    : Math.max(0, idx - 1);
            }
            const next = focusables[idx];
            if (next) {
                next.focus({ preventScroll: true });
                // Hero actions live at the top of the page; centering
                // them would push the header off-screen. Scroll to top
                // for anything inside .watch-hero or the back link;
                // center for accordion buttons.
                if (
                    next.closest(".watch-hero") ||
                    next.closest(".watch-back")
                ) {
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

    // On mount, defensively focus the first hero button + scroll to
    // top. autoFocus on the primary hero button SHOULD handle this
    // but on cheap WebView builds (Skyworth) the autoFocus race with
    // mount + episode-fetch occasionally landed focus on the last
    // episode button (the one rendered last in the open accordion
    // season), scrolling the page to the bottom. Re-focusing
    // explicitly when the item resolves nails the right initial state.
    useEffect(() => {
        if (!item) return;
        // Defer one frame so the hero buttons have rendered.
        const id = requestAnimationFrame(() => {
            const root = document.querySelector(".watch-screen");
            if (!root) return;
            const heroBtn = root.querySelector<HTMLElement>(
                ".watch-hero .watch-action.primary",
            );
            heroBtn?.focus({ preventScroll: true });
            scrollWindowToTop();
        });
        return () => cancelAnimationFrame(id);
    }, [item?.Id]);

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
            const res = await fetch(url.toString(), {
                credentials: "same-origin",
                headers: authHeaders(),
            });
            if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
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
                const res = await fetch(
                    `/api/kids/series/${encodeURIComponent(itemId)}/episodes`,
                    {
                        credentials: "same-origin",
                        headers: authHeaders(),
                    },
                );
                if (!res.ok) throw new Error(`${res.status}`);
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
                <Link to={browseHref} className="watch-back-link" aria-label="Back">
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
                            >
                                <Play weight="fill" aria-hidden />
                                Play
                            </button>
                        )}
                        {!isSeries && (inProgress || completed) && (
                            <button
                                className="watch-action"
                                onClick={() => goPlay(item.Id, true)}
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
    return (
        <>
            <button
                className="watch-action primary"
                onClick={() => onPlay(target.episode.id)}
                autoFocus
            >
                <Play weight="fill" aria-hidden />
                {target.label}
            </button>
            <button
                className="watch-action"
                onClick={() => onPlay(target.episode.id, { restart: true })}
            >
                <ArrowCounterClockwise weight="bold" aria-hidden />
                Restart
            </button>
            {next && (
                <button
                    className="watch-action"
                    onClick={() => onPlay(next.id)}
                >
                    <SkipForward weight="fill" aria-hidden />
                    Next ({epLabel(next)})
                </button>
            )}
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
    // one. Else pick the first unwatched after a completed run. Else
    // first episode of season 1 (or 0 if specials are first).
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
            label: `Continue with ${epLabel(firstUnwatched)}`,
        };
    }
    if (flat.length > 0) {
        return { episode: flat[0], label: "Watch again" };
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

    // Pick the season containing the resume target as the default-
    // open one when episodes load.
    useEffect(() => {
        if (!response || openSeason !== null) return;
        const target = pickResumeTarget(response);
        if (!target) {
            setOpenSeason(response.seasons[0]?.seasonNumber ?? null);
            return;
        }
        const season = response.seasons.find((s) =>
            s.episodes.some((e) => e.id === target.episode.id),
        );
        setOpenSeason(season?.seasonNumber ?? response.seasons[0]?.seasonNumber ?? null);
    }, [response, openSeason]);

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
                            onClick={() =>
                                setOpenSeason(isOpen ? null : s.seasonNumber)
                            }
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
                                    const watched = e.userData?.Played ?? false;
                                    const inProgress = pct >= 5 && pct < 90;
                                    return (
                                        <li key={e.id}>
                                            <button
                                                type="button"
                                                className="watch-episode"
                                                onClick={() => onPlay(e.id)}
                                            >
                                                <EpisodeThumb episode={e} />
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
                                                    {inProgress && (
                                                        <div
                                                            className="watch-episode-progress"
                                                            style={{
                                                                width: `${pct}%`,
                                                            }}
                                                            aria-hidden
                                                        />
                                                    )}
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
