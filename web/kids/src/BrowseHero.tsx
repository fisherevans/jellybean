import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BrowseItem } from "jellybean-shared";
import { authHeaders, withAuthRetry } from "./auth";

// BrowseHero renders a Netflix-style "hero detail" panel above the
// browse rows that surfaces context for the currently-focused tile.
// Read-only: it never takes focus, never renders an <img>, and never
// triggers a transcode. The kid's existing tile-focus model is the
// source of truth; this component just listens.
//
// Layout shells:
//   - Movie:  title, meta (year · runtime), overview paragraph
//             clamped to ~3-4 lines.
//   - Series: title, meta (year · "Series"), series overview clamped
//             to ~2 lines, then a "Continue / Start / Watch again with"
//             block with S{n}E{n} · {episodeName} and the episode
//             overview clamped to ~3 lines.
//
// Both shells share a fixed min-height so vertical layout (and the
// animated stack-translate that drives scroll) doesn't reflow when
// the kid arrows from a movie to a series.
//
// Per-focus detail fetch is debounced + AbortControlled + cached in a
// per-mount Map. Held-arrow scrolling fires at most one network call
// per landed tile.

const TICKS_PER_MINUTE = 60 * 10_000_000;

function formatRuntime(ticks: number | undefined): string {
    if (!ticks) return "";
    const minutes = Math.round(ticks / TICKS_PER_MINUTE);
    if (minutes <= 0) return "";
    if (minutes >= 60) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    return `${minutes}m`;
}

// kidsItem mirrors the server's kidsItemResponse shape. Overview is
// optional - it lands once t1 ships server-side; until then we get
// undefined and render the empty-state line.
type KidsItemBody = {
    itemId: string;
    itemName: string;
    itemType?: string;
    productionYear?: number;
    runtimeTicks?: number;
    overview?: string;
    seriesId?: string;
    seriesName?: string;
};

// kidsNextUp mirrors the server's kidsNextUpResponse shape. The
// episode payload here doesn't include overview; we follow up with a
// /items/:nextEpisodeId fetch to get it. /next-up returns 400 in
// admin preview mode (no kid auth) - the hero handles that path by
// rendering the series shell without a next-ep block.
type KidsNextUpBody = {
    episodeId: string;
    name: string;
    indexNumber?: number;
    parentIndexNumber?: number;
    userData?: {
        PlayedPercentage?: number;
        Played?: boolean;
    };
};

// HeroDetail is the merged per-focus body the hero renders from. Both
// movie and series go through the same shape; series gets `nextEp`.
export type HeroDetail = {
    itemId: string;
    overview: string;
    nextEp?: {
        episodeId: string;
        episodeName: string;
        seasonNumber?: number;
        episodeNumber?: number;
        overview: string;
        playedPercentage: number;
        played: boolean;
    };
};

export type BrowseHeroProps = {
    item: BrowseItem | undefined;
    /**
     * Admin-preview mode flag. Required because /api/kids/items/:id/next-up
     * returns 400 without kid auth - the hero must skip that fetch and
     * render the series shell without a next-ep block.
     */
    adminPreview: boolean;
    /**
     * Optional admin-preview profile id for the URL query param. The
     * hero passes it through on every fetch so admin previewing as a
     * specific profile stays scoped.
     */
    adminProfileId: string | null;
};

function buildItemURL(itemId: string, adminProfileId: string | null): string {
    const url = new URL(
        `/api/kids/items/${encodeURIComponent(itemId)}`,
        window.location.origin,
    );
    if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
    return url.toString();
}

function buildNextUpURL(seriesId: string): string {
    const url = new URL(
        `/api/kids/items/${encodeURIComponent(seriesId)}/next-up`,
        window.location.origin,
    );
    return url.toString();
}

async function fetchItemBody(
    url: string,
    signal: AbortSignal,
): Promise<KidsItemBody | null> {
    const res = await withAuthRetry(() =>
        fetch(url, {
            credentials: "same-origin",
            headers: authHeaders(),
            signal,
        }),
    );
    if (!res.ok) return null;
    return (await res.json()) as KidsItemBody;
}

async function fetchNextUp(
    url: string,
    signal: AbortSignal,
): Promise<KidsNextUpBody | null> {
    const res = await withAuthRetry(() =>
        fetch(url, {
            credentials: "same-origin",
            headers: authHeaders(),
            signal,
        }),
    );
    if (!res.ok) return null;
    return (await res.json()) as KidsNextUpBody;
}

// Cache entries are stable for the lifetime of the Browse mount.
// Capacity is bounded by the visible library (~140 tiles); we don't
// bother with eviction because the kid arrows over the same focused
// tiles on every back-nav and the cache is the whole point.
type CacheEntry = HeroDetail | null;

function BrowseHeroImpl({ item, adminPreview, adminProfileId }: BrowseHeroProps) {
    const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
    const [detail, setDetail] = useState<HeroDetail | null>(null);
    const itemId = item?.Id ?? null;
    const itemType = item?.Type ?? null;

    useEffect(() => {
        if (!itemId) {
            setDetail(null);
            return;
        }
        const cached = cacheRef.current.get(itemId);
        if (cached !== undefined) {
            setDetail(cached);
            return;
        }
        // Fresh focus - clear the previous render's detail so the
        // hero shows the synchronous (title + year + runtime) shell
        // while the network call is in flight, instead of stale
        // overview text from the previous tile.
        setDetail(null);
        const ac = new AbortController();
        const slow = document.body?.dataset.perf === "slow";
        const debounceMs = slow ? 350 : 200;
        const timer = window.setTimeout(async () => {
            try {
                const itemURL = buildItemURL(itemId, adminProfileId);
                const itemBody = await fetchItemBody(itemURL, ac.signal);
                if (ac.signal.aborted || !itemBody) return;
                let nextEp: HeroDetail["nextEp"] | undefined;
                if (
                    itemType === "Series" &&
                    !adminPreview &&
                    itemBody.itemType !== "Movie"
                ) {
                    const nextUpURL = buildNextUpURL(itemId);
                    const nextUpBody = await fetchNextUp(nextUpURL, ac.signal);
                    if (ac.signal.aborted) return;
                    if (nextUpBody?.episodeId) {
                        // Follow-up fetch for the episode's own
                        // overview. Same /items/:id endpoint - returns
                        // empty overview until t1 lands; we degrade
                        // gracefully.
                        const epURL = buildItemURL(
                            nextUpBody.episodeId,
                            adminProfileId,
                        );
                        const epBody = await fetchItemBody(epURL, ac.signal);
                        if (ac.signal.aborted) return;
                        nextEp = {
                            episodeId: nextUpBody.episodeId,
                            episodeName: nextUpBody.name,
                            seasonNumber: nextUpBody.parentIndexNumber,
                            episodeNumber: nextUpBody.indexNumber,
                            overview: epBody?.overview ?? "",
                            playedPercentage:
                                nextUpBody.userData?.PlayedPercentage ?? 0,
                            played: !!nextUpBody.userData?.Played,
                        };
                    }
                }
                const merged: HeroDetail = {
                    itemId,
                    overview: itemBody.overview ?? "",
                    nextEp,
                };
                cacheRef.current.set(itemId, merged);
                setDetail(merged);
            } catch (err) {
                // AbortError is the intended path on rapid focus
                // changes; anything else we swallow because the hero
                // is informational. The synchronous shell still
                // renders title + meta from the BrowseItem.
                if ((err as { name?: string })?.name === "AbortError") return;
                cacheRef.current.set(itemId, null);
            }
        }, debounceMs);
        return () => {
            window.clearTimeout(timer);
            ac.abort();
        };
    }, [itemId, itemType, adminPreview, adminProfileId]);

    // Pre-compute the synchronous parts so the hero stays stable
    // through detail-fetch lifecycle (loading -> loaded -> next focus).
    const meta = useMemo(() => {
        if (!item) return "";
        const parts: string[] = [];
        if (item.ProductionYear) parts.push(String(item.ProductionYear));
        if (item.Type === "Series") {
            parts.push("Series");
        } else {
            const runtime = formatRuntime(item.RunTimeTicks);
            if (runtime) parts.push(runtime);
        }
        return parts.join(" · ");
    }, [item]);

    if (!item) {
        // Reserve the panel's space when there's no focused tile yet
        // (initial mount, post-tab-up). Empty content keeps the row
        // layout below it from jumping when focus lands.
        return <section className="browse-hero browse-hero-empty" aria-hidden />;
    }

    const isSeries = item.Type === "Series";

    return (
        <section className="browse-hero" aria-live="polite" aria-atomic="true">
            <h1 className="browse-hero-title">{item.Name}</h1>
            {meta && <div className="browse-hero-meta">{meta}</div>}
            {isSeries ? (
                <SeriesHeroBody
                    overview={detail?.overview}
                    nextEp={detail?.nextEp}
                    adminPreview={adminPreview}
                />
            ) : (
                <MovieHeroBody overview={detail?.overview} />
            )}
        </section>
    );
}

function MovieHeroBody({ overview }: { overview: string | undefined }) {
    const text = (overview ?? "").trim();
    if (!text) {
        return <p className="browse-hero-overview browse-hero-empty-line">(no description)</p>;
    }
    return <p className="browse-hero-overview browse-hero-clamp-4">{text}</p>;
}

function SeriesHeroBody({
    overview,
    nextEp,
    adminPreview,
}: {
    overview: string | undefined;
    nextEp: HeroDetail["nextEp"] | undefined;
    adminPreview: boolean;
}) {
    const text = (overview ?? "").trim();
    return (
        <>
            {text ? (
                <p className="browse-hero-overview browse-hero-clamp-2">{text}</p>
            ) : (
                <p className="browse-hero-overview browse-hero-empty-line">(no description)</p>
            )}
            {!adminPreview && nextEp && <NextEpBlock nextEp={nextEp} />}
        </>
    );
}

function NextEpBlock({ nextEp }: { nextEp: NonNullable<HeroDetail["nextEp"]> }) {
    // Label tracks the kid's relationship to this episode:
    //   - resume in progress       -> "Continue with..."
    //   - never started but exists -> "Start with..."
    //   - whole series finished    -> "Watch again..." (resume cycled
    //                                  back to S1E1; relies on
    //                                  GetNextUp's behavior).
    const label = (() => {
        if (nextEp.played) return "Watch again...";
        if (nextEp.playedPercentage > 0) return "Continue with...";
        return "Start with...";
    })();
    const sxe = formatSxE(nextEp.seasonNumber, nextEp.episodeNumber);
    const headline = sxe ? `${sxe} · ${nextEp.episodeName}` : nextEp.episodeName;
    const epOverview = nextEp.overview.trim();
    return (
        <div className="browse-hero-next-ep">
            <div className="browse-hero-next-ep-label">{label}</div>
            <div className="browse-hero-next-ep-headline">{headline}</div>
            {epOverview ? (
                <p className="browse-hero-next-ep-overview browse-hero-clamp-3">
                    {epOverview}
                </p>
            ) : (
                <p className="browse-hero-next-ep-overview browse-hero-empty-line">
                    (no description)
                </p>
            )}
        </div>
    );
}

function formatSxE(season: number | undefined, episode: number | undefined): string {
    if (season == null && episode == null) return "";
    const s = season != null ? `S${season}` : "";
    const e = episode != null ? `E${episode}` : "";
    return `${s}${e}`;
}

// Memoized so the Browse parent's per-row re-renders (focus.col
// flips, image-priority radius bumps, etc.) don't cascade into the
// hero. The hero only re-renders when the focused item id changes.
export default memo(
    BrowseHeroImpl,
    (prev, next) =>
        prev.item?.Id === next.item?.Id &&
        prev.item?.Type === next.item?.Type &&
        prev.adminPreview === next.adminPreview &&
        prev.adminProfileId === next.adminProfileId,
);
