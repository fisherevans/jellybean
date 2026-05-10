import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
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
    getSession,
    imageAuthSuffix,
    withAuthRetry,
    type Session,
} from "./auth";
import { getHomeTab } from "./kidNav";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useProgressiveBack } from "./useProgressiveBack";
import { useKidsResource } from "./useKidsResource";
import { useStackScroll } from "./useStackScroll";

// Watch menu (M7). Pre-playback interstitial that surfaces a hero
// (poster + title + Play / Resume / Restart) over the kid app's
// shared rainbow background. Series get a sticky horizontal season-
// tab strip + scrolling episode list below the hero.
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
//
// Layout note (series):
//   .watch-screen.is-series is a 3-row grid (auto / auto / 1fr). The
//   hero zone (back arrow + poster + title + actions + next-up
//   details) sits in row 1, the season-tab strip in row 2, and the
//   .kids-stack-wrapped episode list in row 3 (overflow:hidden).
//   The episode list translates inside its grid row via
//   useStackScroll's translate3d - hero + tabs stay naturally
//   pinned because they're in different grid rows. position:sticky
//   inside a translate3d parent doesn't work on the kid TV's
//   WebView, so the grid sibling layout is what keeps the tab
//   strip "sticky" without sticky semantics.

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
> & { Overview?: string };

type SeriesEpisode = {
    id: string;
    indexNumber?: number;
    name: string;
    overview?: string;
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

// Focus zones for the D-pad state machine. Maintained in component
// state so cross-zone moves (Down from hero -> episode list, Up from
// episode 0 -> active season tab) can pick the correct landing index
// without hunting the DOM. The actual element focus (`focus()`) is
// applied via refs in a useLayoutEffect.
type Focus =
    | { kind: "back" }
    | { kind: "favorite" }
    | { kind: "hero"; index: number }
    | { kind: "seasonTab"; index: number }
    | { kind: "episode"; index: number };

export default function Watch() {
    const { itemId } = useParams<{ itemId: string }>();
    const [searchParams] = useSearchParams();
    const nav = useNavigate();
    const location = useLocation();
    const [session] = useState<Session | null>(() => getSession());

    const [item, setItem] = useState<Item | null>(null);

    // Item + episodes fetch via the shared hook. Both are
    // mount-/itemId-scoped reads; auth handling, 401-bounce, and
    // cancelled-flag bookkeeping live in useKidsResource. The hook's
    // `error` is surfaced for the item path (it's the load-bearing
    // page render); the episodes-list error stays silent (the hero
    // button shows "Loading episodes…" until the response lands and
    // the kid notices nothing if it never does, since the resume
    // target is what matters).
    type ItemBody = {
        itemId: string;
        itemName: string;
        itemType?: string;
        productionYear?: number;
        runtimeTicks?: number;
        overview?: string;
        userData?: ItemUserData;
        seriesId?: string;
        isFavorite?: boolean;
    };
    const adminProfileId = searchParams.get("profileId");
    const itemURL = useMemo(() => {
        if (!itemId) return null;
        if (!session && !adminProfileId) return null;
        // /items/{id} returns metadata only (no PostPlaybackInfo, no
        // transcode session). We deliberately don't hit /stream
        // until the user actually picks Play / Resume, since opening
        // the watch menu shouldn't kick off a transcode for content
        // the kid hasn't decided to play.
        const url = new URL(
            `/api/kids/items/${encodeURIComponent(itemId)}`,
            window.location.origin,
        );
        if (adminProfileId) {
            url.searchParams.set("profileId", adminProfileId);
        }
        return url.toString();
    }, [itemId, session, adminProfileId]);
    const { data: itemBody, error } = useKidsResource<ItemBody>({
        url: itemURL,
    });
    useEffect(() => {
        if (!itemBody) return;
        setItem({
            Id: itemBody.itemId,
            Name: itemBody.itemName,
            Type: itemBody.itemType ?? "Movie",
            ProductionYear: itemBody.productionYear,
            RunTimeTicks: itemBody.runtimeTicks,
            UserData: itemBody.userData,
            ImageTags: {},
            IsFavorite: itemBody.isFavorite ?? false,
            Overview: itemBody.overview,
        });
    }, [itemBody]);

    // Episode list (series only). The hook returns null while item
    // is loading or the page is for a movie because of the URL gate
    // - both keep episodes null and the hero defaults to a loading
    // spinner button.
    const episodesURL = useMemo(() => {
        if (!item || item.Type !== "Series" || !itemId) return null;
        return `/api/kids/series/${encodeURIComponent(itemId)}/episodes`;
    }, [item, itemId]);
    const { data: episodes } = useKidsResource<EpisodesResponse>({
        url: episodesURL,
    });

    // Resume target + the season that contains it. Recomputed when
    // episodes change. The default-selected season tab tracks this.
    const resumeTarget = useMemo(() => pickResumeTarget(episodes), [episodes]);
    const resumeSeasonIdx = useMemo(() => {
        if (!episodes || !resumeTarget) return 0;
        const idx = episodes.seasons.findIndex((s) =>
            s.episodes.some((e) => e.id === resumeTarget.episode.id),
        );
        return idx >= 0 ? idx : 0;
    }, [episodes, resumeTarget]);

    // Selected-season tab. Initialized to the resume target's season
    // once episodes load; the kid can override by D-padding to a
    // different tab and pressing Enter, at which point the manual
    // pick wins until they back out and re-enter the page.
    const [selectedSeasonIdx, setSelectedSeasonIdx] = useState<number>(0);
    const seasonInitRef = useRef(false);
    useEffect(() => {
        if (!episodes || seasonInitRef.current) return;
        if (episodes.seasons.length === 0) return;
        setSelectedSeasonIdx(resumeSeasonIdx);
        seasonInitRef.current = true;
    }, [episodes, resumeSeasonIdx]);

    const selectedSeason: Season | null =
        episodes?.seasons[selectedSeasonIdx] ?? null;

    // The default landing episode within the currently-selected
    // season. If the resume target lives in this season, use its
    // index; otherwise land on episode 0. Used by the
    // hero-Down / tab-Down transitions.
    const defaultEpisodeIdx = useMemo(() => {
        if (!selectedSeason) return 0;
        if (
            resumeTarget &&
            selectedSeasonIdx === resumeSeasonIdx &&
            episodes
        ) {
            const idx = selectedSeason.episodes.findIndex(
                (e) => e.id === resumeTarget.episode.id,
            );
            if (idx >= 0) return idx;
        }
        return 0;
    }, [
        selectedSeason,
        selectedSeasonIdx,
        resumeSeasonIdx,
        resumeTarget,
        episodes,
    ]);

    const [focus, setFocus] = useState<Focus>({ kind: "hero", index: 0 });

    // Per-page random rainbow-bg offset. Matches Browse / Library /
    // TagDetail's --kids-bg-offset-y pattern so /watch sits on the
    // same shared bg layer.
    useEffect(() => {
        const offset = Math.floor(Math.random() * 2 * window.innerHeight);
        document.documentElement.style.setProperty(
            "--kids-bg-offset-y",
            `${offset}px`,
        );
        document.documentElement.dataset.kidsBgOffsetY = String(offset);
        document.documentElement.style.removeProperty("--kids-bg-pos-y");
        return () => {
            document.documentElement.style.removeProperty("--kids-bg-offset-y");
            delete document.documentElement.dataset.kidsBgOffsetY;
        };
    }, []);

    // Adult override gesture (M9): long-press Enter (D-pad center)
    // on /watch targets the watched item itself.
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

    // Where Back should land: the home tab the kid was last on
    // (browse or library), tracked in sessionStorage by kidNav.ts.
    const backHref = `/${getHomeTab()}${location.search}`;
    const browseHref = backHref;
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Refs the focus state machine drives. Series has lazily-allocated
    // arrays for each visible focusable; movies use just the back +
    // favorite + hero arrays.
    const backRef = useRef<HTMLButtonElement | null>(null);
    const favoriteRef = useRef<HTMLButtonElement | null>(null);
    const heroBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const seasonTabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const episodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const heroPrimaryRef = useRef<HTMLButtonElement | null>(null);

    // Stack scroll for the series episode list. Movies don't use it
    // (no list to scroll); we still allocate the hook so its
    // body-class effect fires consistently. The .kids-stack only
    // wraps the episode list; hero stays outside.
    const stack = useStackScroll();

    const isSeries = item?.Type === "Series";

    // Reset stack when switching seasons or items.
    useLayoutEffect(() => {
        stack.setStackY(0, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item?.Id, selectedSeasonIdx]);

    // Apply the focus state to the DOM. This is the single place
    // we call element.focus().
    useLayoutEffect(() => {
        let el: HTMLElement | null = null;
        switch (focus.kind) {
            case "back":
                el = backRef.current;
                break;
            case "favorite":
                el = favoriteRef.current;
                break;
            case "hero":
                el = heroBtnRefs.current[focus.index] ?? null;
                if (!el) el = heroPrimaryRef.current;
                break;
            case "seasonTab":
                el = seasonTabRefs.current[focus.index] ?? null;
                break;
            case "episode":
                el = episodeRefs.current[focus.index] ?? null;
                break;
        }
        if (el) el.focus({ preventScroll: true });

        // Per-focus visual scroll. Tabs / hero / back / favorite
        // pin to the top of the stack (they live outside it, so the
        // stack only matters for landing back at the top of the
        // episode list). Episode focus centers the focused row in
        // the visible episode-list viewport.
        if (focus.kind === "episode" && el) {
            stack.scrollToCenter(el);
        } else if (
            focus.kind === "back" ||
            focus.kind === "favorite" ||
            focus.kind === "hero" ||
            focus.kind === "seasonTab"
        ) {
            stack.scrollToTop(true);
        }

        // Horizontal: keep focused season tab centered in the strip.
        if (focus.kind === "seasonTab" && el) {
            try {
                el.scrollIntoView({ inline: "center", block: "nearest" });
            } catch {
                /* older WebViews */
            }
        }
    }, [focus, stack]);

    // Mount-time focus: land on the primary hero action once item
    // (and, for series, episodes) have loaded.
    const initFocusRef = useRef(false);
    useEffect(() => {
        if (!item) return;
        if (item.Type === "Series" && !episodes) return;
        if (initFocusRef.current) return;
        initFocusRef.current = true;
        setFocus({ kind: "hero", index: 0 });
    }, [item, episodes]);

    // Reset the init guard if the kid navigates to a different
    // /watch/:id without unmounting (rare, but defensive).
    useEffect(() => {
        initFocusRef.current = false;
    }, [item?.Id]);

    // D-pad state machine. Cross-zone transitions:
    //   back: Right -> favorite; Down -> hero[0]
    //   favorite: Left/Up -> back; Down -> hero[0]
    //   hero: Left/Right within bounds; Up -> favorite;
    //         Down -> episode[defaultEpisodeIdx] (skip past tabs)
    //   seasonTab: Left/Right within tabs; Up -> hero[primaryIdx];
    //              Down -> episode[defaultEpisodeIdx];
    //              Enter -> select that season (Down then auto-moves)
    //   episode: Up at idx 0 -> seasonTab[selectedSeasonIdx];
    //            Up at idx >0 -> episode[idx-1];
    //            Down -> episode[idx+1] (clamped)
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

            if (e.key === "Enter" || e.key === " ") {
                if (focus.kind === "seasonTab") {
                    setSelectedSeasonIdx(focus.index);
                    return;
                }
                const active = document.activeElement as HTMLElement | null;
                active?.click?.();
                return;
            }

            const heroCount = heroBtnRefs.current.filter(Boolean).length;
            const seasonCount = episodes?.seasons.length ?? 0;
            const epCount = selectedSeason?.episodes.length ?? 0;

            switch (focus.kind) {
                case "back": {
                    if (e.key === "ArrowRight") {
                        setFocus({ kind: "favorite" });
                    } else if (e.key === "ArrowDown") {
                        setFocus({ kind: "hero", index: 0 });
                    }
                    return;
                }
                case "favorite": {
                    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                        setFocus({ kind: "back" });
                    } else if (e.key === "ArrowDown") {
                        setFocus({ kind: "hero", index: 0 });
                    }
                    return;
                }
                case "hero": {
                    const idx = focus.index;
                    if (e.key === "ArrowLeft") {
                        setFocus({ kind: "hero", index: Math.max(0, idx - 1) });
                    } else if (e.key === "ArrowRight") {
                        setFocus({
                            kind: "hero",
                            index: Math.min(heroCount - 1, idx + 1),
                        });
                    } else if (e.key === "ArrowUp") {
                        setFocus({ kind: "favorite" });
                    } else if (e.key === "ArrowDown") {
                        if (isSeries && epCount > 0) {
                            setFocus({
                                kind: "episode",
                                index: Math.min(epCount - 1, defaultEpisodeIdx),
                            });
                        }
                    }
                    return;
                }
                case "seasonTab": {
                    const idx = focus.index;
                    if (e.key === "ArrowLeft") {
                        setFocus({
                            kind: "seasonTab",
                            index: Math.max(0, idx - 1),
                        });
                    } else if (e.key === "ArrowRight") {
                        setFocus({
                            kind: "seasonTab",
                            index: Math.min(seasonCount - 1, idx + 1),
                        });
                    } else if (e.key === "ArrowUp") {
                        setFocus({ kind: "hero", index: 0 });
                    } else if (e.key === "ArrowDown") {
                        // Treat Down as commit-then-descend: pick this
                        // season first, then drop into its episode list
                        // at the season's default index.
                        setSelectedSeasonIdx(idx);
                        // We don't know the new season's epCount until
                        // it renders; setting episode focus to 0 is
                        // safe because every season has at least one
                        // episode (otherwise it wouldn't be in the
                        // tab list).
                        setFocus({ kind: "episode", index: 0 });
                    }
                    return;
                }
                case "episode": {
                    const idx = focus.index;
                    if (e.key === "ArrowUp") {
                        if (idx <= 0) {
                            setFocus({
                                kind: "seasonTab",
                                index: selectedSeasonIdx,
                            });
                        } else {
                            setFocus({
                                kind: "episode",
                                index: idx - 1,
                            });
                        }
                    } else if (e.key === "ArrowDown") {
                        if (idx < epCount - 1) {
                            setFocus({
                                kind: "episode",
                                index: idx + 1,
                            });
                        }
                    }
                    // Left/Right within the episode list is a no-op;
                    // tabs are reached only by Up.
                    return;
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        focus,
        episodes,
        selectedSeason,
        selectedSeasonIdx,
        defaultEpisodeIdx,
        isSeries,
        override,
    ]);

    // Hardware Back ladder. Order matters:
    //   1. Override modal -> close it.
    //   2. Inside episode list / on a season tab -> climb back to
    //      the primary hero action (so Back from episodes feels like
    //      "back to the top of this page" instead of "back to the
    //      previous page").
    //   3. Otherwise -> navigate to backHref (browse/library).
    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            if (focus.kind === "episode" || focus.kind === "seasonTab") {
                setFocus({ kind: "hero", index: 0 });
                return true;
            }
            nav(backHref);
            return true;
        }, [override, focus, nav, backHref]),
    );

    if (error) {
        return (
            <div className="kids-page kids-error">
                <div className="kids-home-bg" aria-hidden />
                <p className="error">{error}</p>
                <Link to={browseHref}>Back home</Link>
            </div>
        );
    }
    if (!item) {
        return (
            <div className="kids-page kids-loading">
                <div className="kids-home-bg" aria-hidden />
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

    const pct = item.UserData?.PlayedPercentage ?? 0;
    const inProgress = pct >= 5 && pct < 90;
    const completed = pct >= 90 || (item.UserData?.Played ?? false);

    const isFavorite = item.IsFavorite ?? false;
    const toggleFavorite = async () => {
        if (!session) return;
        const next = !isFavorite;
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
        nav(backHref);
    };

    return (
        <div className={`watch-screen ${isSeries ? "is-series" : "is-movie"}`}>
            <div className="kids-home-bg" aria-hidden />
            <button
                type="button"
                ref={backRef}
                className={`watch-back-btn ${focus.kind === "back" ? "focused" : ""}`}
                onClick={handleBackClick}
                onFocus={() => setFocus({ kind: "back" })}
                aria-label="Back"
            >
                <ArrowLeft weight="fill" size={32} aria-hidden />
            </button>
            <div className={`watch-hero ${isSeries ? "is-series" : "is-movie"}`}>
                <Poster id={item.Id} isSeries={isSeries} />
                <div className="watch-hero-text">
                    <button
                        type="button"
                        ref={favoriteRef}
                        className={`watch-fav ${isFavorite ? "active" : ""} ${focus.kind === "favorite" ? "focused" : ""}`}
                        onClick={toggleFavorite}
                        onFocus={() => setFocus({ kind: "favorite" })}
                        aria-label={
                            isFavorite
                                ? "Remove from favorites"
                                : "Add to favorites"
                        }
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
                                ref={(el) => {
                                    heroBtnRefs.current[0] = el;
                                    heroPrimaryRef.current = el;
                                }}
                                type="button"
                                className={`watch-action primary ${focus.kind === "hero" && focus.index === 0 ? "focused" : ""}`}
                                onClick={() => goPlay(item.Id)}
                                onFocus={() =>
                                    setFocus({ kind: "hero", index: 0 })
                                }
                            >
                                <Play weight="fill" aria-hidden />
                                Resume
                            </button>
                        )}
                        {!isSeries && completed && (
                            <button
                                ref={(el) => {
                                    heroBtnRefs.current[0] = el;
                                    heroPrimaryRef.current = el;
                                }}
                                type="button"
                                className={`watch-action primary ${focus.kind === "hero" && focus.index === 0 ? "focused" : ""}`}
                                onClick={() => goPlay(item.Id, true)}
                                onFocus={() =>
                                    setFocus({ kind: "hero", index: 0 })
                                }
                            >
                                <ArrowCounterClockwise
                                    weight="fill"
                                    aria-hidden
                                />
                                Watch again
                            </button>
                        )}
                        {!isSeries && !inProgress && !completed && (
                            <button
                                ref={(el) => {
                                    heroBtnRefs.current[0] = el;
                                    heroPrimaryRef.current = el;
                                }}
                                type="button"
                                className={`watch-action primary ${focus.kind === "hero" && focus.index === 0 ? "focused" : ""}`}
                                onClick={() => goPlay(item.Id)}
                                onFocus={() =>
                                    setFocus({ kind: "hero", index: 0 })
                                }
                            >
                                <Play weight="fill" aria-hidden />
                                Play
                            </button>
                        )}
                        {!isSeries && (inProgress || completed) && (
                            <button
                                ref={(el) => {
                                    heroBtnRefs.current[1] = el;
                                }}
                                type="button"
                                className={`watch-action ${focus.kind === "hero" && focus.index === 1 ? "focused" : ""}`}
                                onClick={() => goPlay(item.Id, true)}
                                onFocus={() =>
                                    setFocus({ kind: "hero", index: 1 })
                                }
                            >
                                <ArrowCounterClockwise
                                    weight="fill"
                                    aria-hidden
                                />
                                Restart
                            </button>
                        )}
                        {isSeries && (
                            <SeriesHeroActions
                                episodes={episodes}
                                resumeTarget={resumeTarget}
                                heroBtnRefs={heroBtnRefs}
                                heroPrimaryRef={heroPrimaryRef}
                                focus={focus}
                                setFocus={setFocus}
                                onPlay={(epID, opts) =>
                                    goPlay(epID, opts?.restart ?? false)
                                }
                            />
                        )}
                    </div>
                    {/* Movie variant: read-only details block under the
                        actions. Mirrors the series next-up details
                        styling for visual consistency. */}
                    {!isSeries && (
                        <DetailsBlock
                            label={
                                item.RunTimeTicks
                                    ? formatRuntime(item.RunTimeTicks)
                                    : ""
                            }
                            description={item.Overview}
                        />
                    )}
                    {/* Series next-up details: episode label + runtime
                        + synopsis for the resume target. Only renders
                        when there's a target (always true once
                        episodes have loaded for any non-empty series). */}
                    {isSeries && resumeTarget && (
                        <DetailsBlock
                            label={
                                resumeTarget.episode.indexNumber !== undefined
                                    ? `Episode ${resumeTarget.episode.indexNumber}`
                                    : "Up next"
                            }
                            secondary={
                                resumeTarget.episode.runtimeTicks
                                    ? formatRuntime(
                                          resumeTarget.episode.runtimeTicks,
                                      )
                                    : ""
                            }
                            title={resumeTarget.episode.name}
                            description={resumeTarget.episode.overview}
                        />
                    )}
                </div>
            </div>
            {isSeries && episodes && episodes.seasons.length > 0 && (
                <SeasonTabStrip
                    seasons={episodes.seasons}
                    selectedIdx={selectedSeasonIdx}
                    focusedIdx={
                        focus.kind === "seasonTab" ? focus.index : null
                    }
                    onTabFocus={(idx) =>
                        setFocus({ kind: "seasonTab", index: idx })
                    }
                    onTabClick={(idx) => {
                        setSelectedSeasonIdx(idx);
                        setFocus({ kind: "seasonTab", index: idx });
                    }}
                    tabRefs={seasonTabRefs}
                />
            )}
            {isSeries && (
                <div className="watch-episode-stack">
                    <div
                        ref={stack.stackRef}
                        className="kids-stack watch-episode-stack-inner"
                    >
                        <EpisodeList
                            season={selectedSeason}
                            focus={focus}
                            setFocus={setFocus}
                            episodeRefs={episodeRefs}
                            onPlay={(epID) => goPlay(epID)}
                        />
                    </div>
                </div>
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

// Poster renders the hero image for the watch screen. Movies get the
// vertical Primary poster (Jellyfin's standard 2:3); series get the
// landscape Backdrop so the hero is shorter. On Backdrop fetch
// failure (rare - admin uploaded only Primary?), we fall back to
// Primary so the kid still sees something.
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
    episodes: EpisodesResponse | null;
    resumeTarget: { episode: SeriesEpisode; label: string } | null;
    heroBtnRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
    heroPrimaryRef: React.MutableRefObject<HTMLButtonElement | null>;
    focus: Focus;
    setFocus: (f: Focus) => void;
    onPlay: (id: string, opts?: { restart?: boolean }) => void;
};

// Series hero shows up to four buttons (in this order):
//   - Play / Resume / Watch again (primary, index 0)
//   - Restart (secondary, index 1) when there's a position to restart
//   - Next (secondary) when a strict-next episode exists
//   - Random (secondary) always
function SeriesHeroActions({
    episodes,
    resumeTarget,
    heroBtnRefs,
    heroPrimaryRef,
    focus,
    setFocus,
    onPlay,
}: SeriesHeroActionsProps) {
    const next = useMemo(
        () => pickNextEpisode(episodes, resumeTarget?.episode.id),
        [episodes, resumeTarget?.episode.id],
    );
    if (!resumeTarget) {
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
    const heroFocused = (idx: number) =>
        focus.kind === "hero" && focus.index === idx;
    let i = 0;
    const primaryIdx = i++;
    const restartIdx = i++;
    const nextIdx = next ? i++ : -1;
    const randomIdx = i++;
    return (
        <>
            <button
                ref={(el) => {
                    heroBtnRefs.current[primaryIdx] = el;
                    heroPrimaryRef.current = el;
                }}
                type="button"
                className={`watch-action primary ${heroFocused(primaryIdx) ? "focused" : ""}`}
                onClick={() => onPlay(resumeTarget.episode.id)}
                onFocus={() => setFocus({ kind: "hero", index: primaryIdx })}
            >
                <Play weight="fill" aria-hidden />
                {expandResumeLabel(resumeTarget)}
            </button>
            <button
                ref={(el) => {
                    heroBtnRefs.current[restartIdx] = el;
                }}
                type="button"
                className={`watch-action ${heroFocused(restartIdx) ? "focused" : ""}`}
                onClick={() => onPlay(resumeTarget.episode.id, { restart: true })}
                onFocus={() => setFocus({ kind: "hero", index: restartIdx })}
            >
                <ArrowCounterClockwise weight="fill" aria-hidden />
                Restart
            </button>
            {next && nextIdx >= 0 && (
                <button
                    ref={(el) => {
                        heroBtnRefs.current[nextIdx] = el;
                    }}
                    type="button"
                    className={`watch-action ${heroFocused(nextIdx) ? "focused" : ""}`}
                    onClick={() => onPlay(next.id)}
                    onFocus={() => setFocus({ kind: "hero", index: nextIdx })}
                >
                    <SkipForward weight="fill" aria-hidden />
                    Next ({epLabel(next)})
                </button>
            )}
            <button
                ref={(el) => {
                    heroBtnRefs.current[randomIdx] = el;
                }}
                type="button"
                className={`watch-action ${heroFocused(randomIdx) ? "focused" : ""}`}
                onClick={playRandom}
                onFocus={() => setFocus({ kind: "hero", index: randomIdx })}
            >
                <Shuffle weight="fill" aria-hidden />
                Random
            </button>
        </>
    );
}

// expandResumeLabel turns the resume target's terse label into the
// expanded "Play Episode 2" / "Resume Episode 2" form for the hero
// CTA. Card badges still use the abbreviated "S1E03" form via
// epLabel().
function expandResumeLabel(target: {
    episode: SeriesEpisode;
    label: string;
}): string {
    const idx = target.episode.indexNumber;
    if (target.label.startsWith("Resume")) {
        return idx !== undefined ? `Resume Episode ${idx}` : "Resume";
    }
    if (target.label.startsWith("Play")) {
        return idx !== undefined ? `Play Episode ${idx}` : "Play";
    }
    return target.label; // "Watch again"
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

// DetailsBlock renders a read-only "next up" / movie-overview block
// under the hero actions. Not focusable.
function DetailsBlock({
    label,
    secondary,
    title,
    description,
}: {
    label?: string;
    secondary?: string;
    title?: string;
    description?: string;
}) {
    if (!label && !secondary && !title && !description) return null;
    return (
        <div className="watch-hero-next" aria-hidden={false}>
            {(label || secondary) && (
                <div className="watch-hero-next-meta">
                    {label && (
                        <span className="watch-hero-next-label">{label}</span>
                    )}
                    {secondary && (
                        <span className="watch-hero-next-runtime">
                            {secondary}
                        </span>
                    )}
                </div>
            )}
            {title && <p className="watch-hero-next-title">{title}</p>}
            {description && (
                <p className="watch-hero-next-desc">{description}</p>
            )}
        </div>
    );
}

type SeasonTabStripProps = {
    seasons: Season[];
    selectedIdx: number;
    focusedIdx: number | null;
    onTabFocus: (idx: number) => void;
    onTabClick: (idx: number) => void;
    tabRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
};

function SeasonTabStrip({
    seasons,
    selectedIdx,
    focusedIdx,
    onTabFocus,
    onTabClick,
    tabRefs,
}: SeasonTabStripProps) {
    return (
        <nav
            className="watch-season-tabs"
            role="tablist"
            aria-label="Seasons"
        >
            <div className="watch-season-tabs-scroll">
                {seasons.map((s, idx) => {
                    const label = seasonLabel(s.seasonNumber);
                    const active = idx === selectedIdx;
                    const focused = idx === focusedIdx;
                    return (
                        <button
                            key={s.seasonNumber}
                            ref={(el) => {
                                tabRefs.current[idx] = el;
                            }}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            tabIndex={focused ? 0 : -1}
                            className={`filter-pill watch-season-tab-label ${active ? "active" : ""} ${focused ? "focused" : ""}`}
                            onClick={() => onTabClick(idx)}
                            onFocus={() => onTabFocus(idx)}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}

function seasonLabel(n: number): string {
    if (n === 0) return "Specials";
    if (n === -1) return "Other";
    return `Season ${n}`;
}

type EpisodeListProps = {
    season: Season | null;
    focus: Focus;
    setFocus: (f: Focus) => void;
    episodeRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
    onPlay: (id: string) => void;
};

function EpisodeList({
    season,
    focus,
    setFocus,
    episodeRefs,
    onPlay,
}: EpisodeListProps) {
    // Trim the refs array to the current season's episode count.
    // Without this, leftover slots from a longer prior season can
    // trip up focus lookups on Down arrows past the new season's
    // last episode (the focus state machine clamps to epCount, but
    // a stale slot would still satisfy episodeRefs.current[idx] !=
    // null). Run after each render via useLayoutEffect so the
    // truncation happens AFTER React's ref callbacks populated
    // the array for the new mount.
    useLayoutEffect(() => {
        if (!season) {
            episodeRefs.current = [];
            return;
        }
        episodeRefs.current.length = season.episodes.length;
    }, [season, episodeRefs]);

    if (!season) {
        return (
            <ul className="watch-episode-list">
                <li className="watch-episode-empty">Loading episodes…</li>
            </ul>
        );
    }
    if (season.episodes.length === 0) {
        return (
            <ul className="watch-episode-list">
                <li className="watch-episode-empty">
                    No episodes in this season.
                </li>
            </ul>
        );
    }
    const focusedEpIdx =
        focus.kind === "episode" ? focus.index : -1;
    return (
        <ul className="watch-episode-list">
            {season.episodes.map((e, idx) => {
                const pct = e.userData?.PlayedPercentage ?? 0;
                const watched =
                    (e.userData?.Played ?? false) || pct >= 90;
                const inProgress = pct >= 5 && pct < 90;
                const isFocused = idx === focusedEpIdx;
                // Image priority gating: render <img> only for
                // episodes within ±5 of the focused index. Others
                // render a placeholder div so the kid TV doesn't
                // decode 30+ thumbnails on a season with that
                // many episodes.
                const showImg =
                    focusedEpIdx < 0 ||
                    Math.abs(idx - focusedEpIdx) <= 5;
                return (
                    <li key={e.id}>
                        <button
                            ref={(el) => {
                                episodeRefs.current[idx] = el;
                            }}
                            type="button"
                            tabIndex={isFocused ? 0 : -1}
                            className={`watch-episode ${watched ? "watched" : ""} ${isFocused ? "focused" : ""}`}
                            onClick={() => onPlay(e.id)}
                            onFocus={() =>
                                setFocus({ kind: "episode", index: idx })
                            }
                        >
                            <div
                                className={`watch-episode-thumb-wrap${watched ? " is-watched" : ""}`}
                            >
                                <EpisodeThumb
                                    episode={e}
                                    showImg={showImg}
                                />
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
                                        <Check size={16} weight="bold" />
                                    </span>
                                )}
                            </div>
                            <div className="watch-episode-info">
                                <div className="watch-episode-title">
                                    <span className="watch-episode-badge">
                                        S{season.seasonNumber}
                                        {epLabel(e)}
                                    </span>{" "}
                                    {e.name}
                                </div>
                                {e.overview && (
                                    <div className="watch-episode-desc">
                                        {e.overview}
                                    </div>
                                )}
                            </div>
                            <div className="watch-episode-runtime">
                                {e.runtimeTicks
                                    ? formatRuntime(e.runtimeTicks)
                                    : ""}
                            </div>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

function EpisodeThumb({
    episode,
    showImg,
}: {
    episode: SeriesEpisode;
    showImg: boolean;
}) {
    if (!episode.imageTag || !showImg) {
        return (
            <div className="watch-episode-thumb placeholder" aria-hidden />
        );
    }
    return (
        <img
            className="watch-episode-thumb"
            src={`/api/kids/items/${encodeURIComponent(episode.id)}/image?type=Primary&width=320${imageAuthSuffix()}`}
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
