import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Link,
    useLocation,
    useNavigate,
    useParams,
    useSearchParams,
} from "react-router-dom";
import {
    ArrowCounterClockwise,
    ArrowLeft,
    Check,
    Heart,
    Play,
    Shuffle,
    SkipForward,
} from "@phosphor-icons/react";
import type { Item as SharedItem, ItemUserData } from "jellybean-shared";
import {
    authHeaders,
    clearSession,
    getSession,
    imageAuthSuffix,
    withAuthRetry,
    type Session,
} from "./auth";
import { getHomeTab } from "./kidNav";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
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

type Item = Pick<
    SharedItem,
    | "Id"
    | "Name"
    | "Type"
    | "ProductionYear"
    | "RunTimeTicks"
    | "ImageTags"
    | "UserData"
    | "IsFavorite"
    | "SeriesId"
    | "SeriesName"
>;

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
    const location = useLocation();
    const [session] = useState<Session | null>(() => getSession());

    const [item, setItem] = useState<Item | null>(null);
    const [episodes, setEpisodes] = useState<EpisodesResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Adult override gesture (M9): long-press Enter (D-pad center)
    // on /watch targets the watched item itself - the kid is
    // reading its details so that's clearly what they'd want to
    // edit. Hook intercepts Enter via capture-phase listeners and
    // dispatches: short press = hand-off to the page's normal Enter
    // handling (Watch's Play button click), long press = open
    // override. We don't pass onShortPress so the hook's keyup
    // ends without firing - but that ALSO means the page's own
    // Enter wouldn't fire either while the hook is enabled. So
    // for Watch we only want the long-press behavior; short press
    // should still trigger the focused button. Re-fire that here.
    const [override, setOverride] = useState<{
        itemId: string;
        itemName: string;
        itemType: string;
        seriesId?: string;
        seriesName?: string;
        played?: boolean;
    } | null>(null);
    useLongPressEnter({
        enabled: !!item && !!session && override === null,
        onShortPress: () => {
            // Synthesize a click on whatever button currently has
            // DOM focus (the Play button, Continue, episode tile,
            // etc) since the hook's preventDefault suppressed the
            // browser's natural button-click-on-keyup.
            const el = document.activeElement;
            if (el instanceof HTMLElement) {
                el.click();
            }
        },
        onLongPress: () => {
            if (!item || !session) return;
            const pct = item.UserData?.PlayedPercentage ?? 0;
            const playedFlag = !!item.UserData?.Played;
            setOverride({
                itemId: item.Id,
                itemName: item.Name,
                itemType: item.Type ?? "",
                seriesId: item.SeriesId,
                seriesName: item.SeriesName,
                played: playedFlag || pct >= 90,
            });
        },
    });

    const adminProfileId = searchParams.get("profileId");
    // Where Back should land: the home tab the kid was last on
    // (browse or library), tracked in sessionStorage by kidNav.ts.
    // Independent of browser history so this works for refresh,
    // bookmarks, and Android WebView's flaky goBack(). location.search
    // is preserved so the admin preview tab stays scoped to the
    // same profile across the back-nav.
    const backHref = `/${getHomeTab()}${location.search}`;
    // The error-fallback Link below uses the same target.
    const browseHref = backHref;
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Zone-aware D-pad nav. Buttons opt into zones via data-zone:
    //   - "back"      : the back arrow at the top-left.
    //   - "favorite"  : the heart button above the title.
    //   - "hero"      : the hero action buttons (Resume / Restart /
    //                   Next / Random for shows; Play / Restart for
    //                   movies). Left/Right cycles within. Down
    //                   crosses to the first accordion item.
    //   - "accordion" : season heads + visible episode buttons. Up/Down
    //                   walks them in DOM order.
    //
    // Cross-zone transitions:
    //   back      Right       -> favorite
    //   back      Down        -> hero[0]
    //   favorite  Left / Up   -> back
    //   favorite  Down        -> hero[0]
    //   hero      Up          -> favorite
    //   hero      Down        -> accordion[0]
    //   accordion[0] Up       -> hero[0]
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
            const favBtn = root.querySelector<HTMLElement>(
                '[data-zone="favorite"]',
            );
            const backBtn = root.querySelector<HTMLElement>(
                '[data-zone="back"]',
            );

            let next: HTMLElement | null = null;

            if (zone === "back") {
                if (e.key === "ArrowRight") next = favBtn ?? heroBtns[0] ?? null;
                else if (e.key === "ArrowDown") next = heroBtns[0] ?? null;
            } else if (zone === "favorite") {
                if (e.key === "ArrowLeft") next = backBtn ?? null;
                else if (e.key === "ArrowUp") next = backBtn ?? null;
                else if (e.key === "ArrowDown") next = heroBtns[0] ?? null;
            } else if (zone === "hero") {
                const idx = active ? heroBtns.indexOf(active) : -1;
                if (e.key === "ArrowLeft") {
                    next = heroBtns[Math.max(0, idx - 1)] ?? null;
                } else if (e.key === "ArrowRight") {
                    next = heroBtns[Math.min(heroBtns.length - 1, idx + 1)] ?? null;
                } else if (e.key === "ArrowUp") {
                    next = favBtn ?? backBtn ?? null;
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
                if (
                    nextZone === "hero" ||
                    nextZone === "favorite" ||
                    nextZone === "back"
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

    // Hardware Back: explicit nav to wherever the kid came from
    // (?from=browse|library). Same reasoning as handleBackClick.
    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            nav(backHref);
            return true;
        }, [override, nav, backHref]),
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
            // Always send adminProfileId when present. The server
            // prefers admin cookie auth over the bearer token, so
            // a stale kid session in localStorage doesn't help the
            // admin preview path - the query param is what tells
            // the server which profile to scope to.
            if (adminProfileId) {
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
                isFavorite?: boolean;
            };
            setItem({
                Id: body.itemId,
                Name: body.itemName,
                Type: body.itemType ?? "Movie",
                ProductionYear: body.productionYear,
                RunTimeTicks: body.runtimeTicks,
                UserData: body.userData,
                ImageTags: {},
                IsFavorite: body.isFavorite ?? false,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [itemId, session, adminProfileId]);

    useEffect(() => {
        fetchItem();
    }, [fetchItem]);

    // No auto-skip: /watch always renders the menu. Earlier we tried
    // to keep the "tile click -> play immediately" UX for fresh
    // movies by auto-pushing /play, but every approach to "remember
    // we already skipped this entry on the back-visit" was unreliable
    // on Android WebView (state.skipDone was dropped on goBack(),
    // location.key wasn't always preserved either). The result was a
    // /watch -> /play loop on Back. Keeping the menu in the forward
    // path costs the kid one extra tap on fresh movies but makes
    // navigation predictable: Back always lands on /watch with the
    // menu, Back again lands on Browse.

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

    const isFavorite = item.IsFavorite ?? false;
    const toggleFavorite = async () => {
        if (!session) return; // admin preview - server returns 403 anyway
        const next = !isFavorite;
        // Optimistic update so the heart flips immediately on the cheap
        // WebView. Roll back on server error.
        setItem((prev) => (prev ? { ...prev, IsFavorite: next } : prev));
        try {
            const res = await withAuthRetry(() =>
                fetch(
                    `/api/kids/items/${encodeURIComponent(item.Id)}/favorite`,
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
            setItem((prev) =>
                prev ? { ...prev, IsFavorite: !next } : prev,
            );
        }
    };

    const handleBackClick = () => {
        // Forward-nav to wherever the kid came from (?from=browse|
        // library). nav(-1) was unreliable on Android WebView's
        // goBack() history (back from /watch sometimes no-oped,
        // sometimes landed on /play). Explicit nav is consistent;
        // the destination's sessionStorage cache restores focus +
        // scroll across the new entry.
        nav(backHref);
    };

    return (
        <div className={`watch-screen ${isSeries ? "is-series" : "is-movie"}`}>
            <BackdropImage itemId={item.Id} />
            <button
                type="button"
                className="watch-back-btn"
                onClick={handleBackClick}
                data-zone="back"
                aria-label="Back"
            >
                <ArrowLeft weight="fill" size={32} aria-hidden />
            </button>
            <div className={`watch-hero ${isSeries ? "is-series" : "is-movie"}`}>
                <Poster id={item.Id} isSeries={isSeries} />
                <div className="watch-hero-text">
                    <button
                        type="button"
                        className={`watch-fav ${isFavorite ? "active" : ""}`}
                        onClick={toggleFavorite}
                        data-zone="favorite"
                        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        aria-pressed={isFavorite}
                    >
                        <Heart
                            weight={isFavorite ? "fill" : "regular"}
                            aria-hidden
                        />
                    </button>
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
                                <ArrowCounterClockwise weight="fill" aria-hidden />
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
                                <ArrowCounterClockwise weight="fill" aria-hidden />
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

// Poster renders the hero image for the watch screen. Movies get the
// vertical Primary poster (Jellyfin's standard 2:3); series get the
// landscape Backdrop so the hero is shorter and the episode accordion
// gets more vertical real estate. Backdrop is always available for
// series in our library (BackdropImage above already relies on it).
// On Backdrop fetch failure (rare - admin uploaded only Primary?),
// we fall back to Primary so the kid still sees something.
function Poster({ id, isSeries }: { id: string; isSeries: boolean }) {
    const type = isSeries ? "Backdrop" : "Primary";
    const width = isSeries ? 720 : 480;
    return (
        <img
            className={isSeries ? "watch-thumb" : "watch-poster"}
            src={`/api/kids/items/${encodeURIComponent(id)}/image?type=${type}&width=${width}${imageAuthSuffix()}`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(e) => {
                const img = e.currentTarget;
                if (isSeries && !img.dataset.fellBack) {
                    img.dataset.fellBack = "1";
                    img.src = `/api/kids/items/${encodeURIComponent(id)}/image?type=Primary&width=480${imageAuthSuffix()}`;
                    img.className = "watch-poster";
                }
            }}
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
                <ArrowCounterClockwise weight="fill" aria-hidden />
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
                <Shuffle weight="fill" aria-hidden />
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
                                                <div
                                                    className={`watch-episode-thumb-wrap${watched ? " is-watched" : ""}`}
                                                >
                                                    <EpisodeThumb episode={e} />
                                                    {inProgress && (
                                                        <div
                                                            className="watch-episode-thumb-progress"
                                                            style={{ width: `${pct}%` }}
                                                            aria-hidden
                                                        />
                                                    )}
                                                    {watched && (
                                                        <span
                                                            className="watch-episode-thumb-watched"
                                                            aria-label="Watched"
                                                        >
                                                            <Check
                                                                size={16}
                                                                weight="bold"
                                                            />
                                                        </span>
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

