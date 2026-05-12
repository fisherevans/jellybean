import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Play } from "@phosphor-icons/react";
import type { BrowseItem } from "jellybean-shared";
import { authHeaders, withAuthRetry } from "./auth";

// FocusedTileMetaCard renders the metadata "wing" that sits immediately
// to the right of the focused tile inside a Browse row. Read-only:
// never takes focus, never renders an <img>, never triggers a
// transcode. The kid's existing tile-focus model is the source of
// truth; this component just listens.
//
// Layout shells:
//   - Movie:  title (DynaPuff h2), meta (year + runtime), overview
//             clamped to 3 lines.
//   - Series: title, meta (year + "Series"), series overview clamped
//             to 2 lines, then "Continue / Next up / Watch again"
//             eyebrow with S{n}E{n} + episode name.
//
// Per-focus detail fetch is debounced + AbortControlled + cached in a
// per-Browse-mount Map (the parent owns it). Held-arrow scrolling
// fires at most one network call per landed tile.

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
// optional - when missing the card renders the empty-state line.
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
// episode payload here doesn't include overview; the SxE + episode
// name is enough for the eyebrow line. /next-up returns 400 in admin
// preview mode (no kid auth) - the hook handles that path by
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

// FocusedItemDetail is the merged per-focus body the card renders
// from. Both movie and series go through the same shape; series gets
// `nextEp`.
export type FocusedItemDetail = {
    itemId: string;
    overview: string;
    nextEp?: {
        episodeId: string;
        episodeName: string;
        seasonNumber?: number;
        episodeNumber?: number;
        playedPercentage: number;
        played: boolean;
    };
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

type CacheEntry = FocusedItemDetail | null;

// useFocusedItemDetail owns the per-focus detail fetch + per-Browse-
// mount cache. Lifted to a hook so Browse can call it ONCE at the top
// level and pass the resolved detail down to whichever row currently
// has the focused tile. Mounting the fetcher inside the focused row's
// render path would lose the cache + abort controllers each time the
// kid arrowed across rows.
//
// Capacity is bounded by the visible library (~140 tiles); we don't
// bother with eviction because the kid arrows over the same focused
// tiles on every back-nav and the cache is the whole point.
export function useFocusedItemDetail(
    item: BrowseItem | undefined,
    adminPreview: boolean,
    adminProfileId: string | null,
): FocusedItemDetail | null {
    const cacheRef = useRef<Map<string, CacheEntry>>(new Map());
    const [detail, setDetail] = useState<FocusedItemDetail | null>(null);
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
        // card shows the synchronous (title + year + runtime) shell
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
                let nextEp: FocusedItemDetail["nextEp"] | undefined;
                if (
                    itemType === "Series" &&
                    !adminPreview &&
                    itemBody.itemType !== "Movie"
                ) {
                    const nextUpURL = buildNextUpURL(itemId);
                    const nextUpBody = await fetchNextUp(nextUpURL, ac.signal);
                    if (ac.signal.aborted) return;
                    if (nextUpBody?.episodeId) {
                        nextEp = {
                            episodeId: nextUpBody.episodeId,
                            episodeName: nextUpBody.name,
                            seasonNumber: nextUpBody.parentIndexNumber,
                            episodeNumber: nextUpBody.indexNumber,
                            playedPercentage:
                                nextUpBody.userData?.PlayedPercentage ?? 0,
                            played: !!nextUpBody.userData?.Played,
                        };
                    }
                }
                const merged: FocusedItemDetail = {
                    itemId,
                    overview: itemBody.overview ?? "",
                    nextEp,
                };
                cacheRef.current.set(itemId, merged);
                setDetail(merged);
            } catch (err) {
                // AbortError is the intended path on rapid focus
                // changes; anything else we swallow because the card
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

    return detail;
}

export type FocusedTileMetaCardProps = {
    item: BrowseItem;
    detail: FocusedItemDetail | null;
    /**
     * Admin-preview mode flag. When true the series shell skips the
     * next-up block (the /next-up endpoint returns 400 without kid
     * auth, and the hook above already drops the call).
     */
    adminPreview: boolean;
};

function FocusedTileMetaCardImpl({
    item,
    detail,
    adminPreview,
}: FocusedTileMetaCardProps) {
    // Pre-compute the synchronous parts so the card stays stable
    // through detail-fetch lifecycle (loading -> loaded -> next focus).
    const meta = useMemo(() => {
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

    const isSeries = item.Type === "Series";

    return (
        <div
            className="focused-meta-card"
            aria-live="polite"
            aria-atomic="true"
        >
            <div className="focused-meta-card-inner">
                <h2 className="focused-meta-card-title">
                    {/* t34: leading play-triangle. Visual affordance that
                        Enter on this tile plays right now (Browse routes
                        straight to /play). White-filled to match the
                        card's title-on-light-bg color scheme - the chip
                        sits inside a deep-purple pill that matches the
                        card title text color, giving it the same weight
                        as the title without introducing a new accent. */}
                    <span
                        className="focused-meta-card-play-chip"
                        aria-hidden
                    >
                        <Play weight="fill" />
                    </span>
                    <span className="focused-meta-card-title-text">
                        {item.Name}
                    </span>
                </h2>
                {meta && <div className="focused-meta-card-meta">{meta}</div>}
                {isSeries ? (
                    <SeriesBody
                        overview={detail?.overview}
                        nextEp={detail?.nextEp}
                        adminPreview={adminPreview}
                    />
                ) : (
                    <MovieBody overview={detail?.overview} />
                )}
            </div>
        </div>
    );
}

function MovieBody({ overview }: { overview: string | undefined }) {
    const text = (overview ?? "").trim();
    if (!text) {
        return (
            <p className="focused-meta-card-overview focused-meta-card-empty">
                (no description)
            </p>
        );
    }
    return (
        <p className="focused-meta-card-overview focused-meta-card-clamp-3">
            {text}
        </p>
    );
}

function SeriesBody({
    overview,
    nextEp,
    adminPreview,
}: {
    overview: string | undefined;
    nextEp: FocusedItemDetail["nextEp"] | undefined;
    adminPreview: boolean;
}) {
    const text = (overview ?? "").trim();
    return (
        <>
            {text ? (
                <p className="focused-meta-card-overview focused-meta-card-clamp-2">
                    {text}
                </p>
            ) : (
                <p className="focused-meta-card-overview focused-meta-card-empty">
                    (no description)
                </p>
            )}
            {!adminPreview && nextEp && <NextEpBlock nextEp={nextEp} />}
        </>
    );
}

function NextEpBlock({
    nextEp,
}: {
    nextEp: NonNullable<FocusedItemDetail["nextEp"]>;
}) {
    // Label tracks the kid's relationship to this episode:
    //   - resume in progress       -> "Continue"
    //   - never started but exists -> "Next up"
    //   - whole series finished    -> "Watch again" (resume cycled
    //                                  back to S1E1; relies on
    //                                  GetNextUp's behavior).
    const label = (() => {
        if (nextEp.played) return "Watch again";
        if (nextEp.playedPercentage > 0) return "Continue";
        return "Next up";
    })();
    const sxe = formatSxE(nextEp.seasonNumber, nextEp.episodeNumber);
    const headline = sxe
        ? `${sxe} · ${nextEp.episodeName}`
        : nextEp.episodeName;
    return (
        <div className="focused-meta-card-next-ep">
            <div className="focused-meta-card-next-ep-label">{label}</div>
            <div className="focused-meta-card-next-ep-headline">{headline}</div>
        </div>
    );
}

function formatSxE(
    season: number | undefined,
    episode: number | undefined,
): string {
    if (season == null && episode == null) return "";
    const s = season != null ? `S${season}` : "";
    const e = episode != null ? `E${episode}` : "";
    return `${s}${e}`;
}

// Memoized so the Browse parent's per-row re-renders (focus.col flips
// inside the focused row, image-priority radius bumps, etc.) don't
// cascade into the card. The card only re-renders when the focused
// item id changes or the detail payload arrives.
const FocusedTileMetaCard = memo(
    FocusedTileMetaCardImpl,
    (prev, next) =>
        prev.item.Id === next.item.Id &&
        prev.item.Type === next.item.Type &&
        prev.detail === next.detail &&
        prev.adminPreview === next.adminPreview,
);

export default FocusedTileMetaCard;
