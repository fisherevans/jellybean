import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowBendRightDown } from "@phosphor-icons/react";
import { getSession, type Session } from "./auth";
import { useKidsResource } from "./useKidsResource";
import { sessionCache } from "./kidsCache";
import Tile, { type TileItem } from "./Tile";
import AlphaPickerModal from "./AlphaPickerModal";
import OptionPickerModal from "./OptionPickerModal";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useItemHiddenEvent } from "./itemHidden";
import { useStackScroll } from "./useStackScroll";
import { useProgressiveBack } from "./useProgressiveBack";
import {
    TAG_ICONS,
    isTagIconName,
    bucketByAdded,
    bucketByWatched,
    ADDED_ORDER,
    WATCHED_ORDER,
    type AddedBucket,
    type WatchedBucket,
} from "jellybean-shared";

// TagDetail renders all visible items inside a single tag, in the
// kid's chosen filter + sort order. Reached from the Tags list page
// via Enter on a tag card. Lives OUTSIDE KidsHome - this is a
// dive-into view, no tab nav. The kid backs out via the explicit Back
// button or repeated Back gestures; reaching /tags re-engages the
// tab nav at that level. The rainbow bg layer is rendered locally so
// the page still matches the rest of the kid app visually.
//
// Filter (all / movies / shows) and Sort (a-z / recently watched /
// recently added) live in the same OptionPickerModal-driven dropdown
// pattern as Library, so the two pages feel consistent.

// TODO(types): TagDetail still uses lowercase keys; normalize
// server-side to the canonical Item PascalCase shape (see
// jellybean-shared `Item`) and switch this to a Pick<Item, ...> like
// the other kid pages.
type TagItem = {
    id: string;
    name: string;
    type: string;
    dateCreated?: string;
    imageTags?: { Primary?: string };
    userData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
        LastPlayedDate?: string;
    };
};

type TagDetailResponse = {
    id: number;
    name: string;
    description: string;
    icon?: string;
    sort: string;
    itemCount: number;
    movieCount: number;
    seriesCount: number;
    items: TagItem[];
};

type SortId = "name" | "recently_added" | "recently_watched";
type FilterId = "all" | "movies" | "shows";

const SORT_OPTIONS: { id: SortId; label: string }[] = [
    { id: "name", label: "A - Z" },
    { id: "recently_added", label: "Recently added" },
    { id: "recently_watched", label: "Recently watched" },
];
const FILTER_OPTIONS: { id: FilterId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "movies", label: "Movies" },
    { id: "shows", label: "Shows" },
];

const SORT_STORAGE = "jellybean.kids.tagDetail.sort";
const FILTER_STORAGE = "jellybean.kids.tagDetail.filter";

function readSort(): SortId {
    try {
        const v = localStorage.getItem(SORT_STORAGE);
        if (v === "name" || v === "recently_added" || v === "recently_watched")
            return v;
    } catch {
        /* ignore */
    }
    return "name";
}
function readFilter(): FilterId {
    try {
        const v = localStorage.getItem(FILTER_STORAGE);
        if (v === "all" || v === "movies" || v === "shows") return v;
    } catch {
        /* ignore */
    }
    return "all";
}
function labelFor<T extends { id: string; label: string }>(
    list: T[],
    id: string,
): string {
    return list.find((o) => o.id === id)?.label ?? "";
}

type Section = {
    id: string;
    title?: string;
    items: TagItem[];
};

const ADDED_TITLES: Record<AddedBucket, string> = {
    today: "Added today",
    week: "Added this week",
    month: "Added this month",
    quarter: "Added in the past 3 months",
    year: "Added in the past year",
    earlier: "Added earlier",
};
const WATCHED_TITLES: Record<WatchedBucket, string> = {
    today: "Watched today",
    week: "Watched this week",
    month: "Watched this month",
    quarter: "Watched in the past 3 months",
    year: "Watched in the past year",
    earlier: "Watched earlier",
    never: "Never watched",
};

function buildSections(items: TagItem[], sort: SortId): Section[] {
    if (items.length === 0) return [];
    if (sort === "name") {
        return [{ id: "all", items }];
    }
    if (sort === "recently_added") {
        const adapted = items.map((it) => ({ it, dateCreated: it.dateCreated }));
        const buckets = bucketByAdded(adapted);
        return ADDED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
            id: `added:${b}`,
            title: ADDED_TITLES[b],
            items: buckets[b].map((x) => x.it),
        }));
    }
    // recently_watched
    const adapted = items.map((it) => ({
        it,
        name: it.name,
        userData: { lastPlayedDate: it.userData?.LastPlayedDate },
    }));
    const buckets = bucketByWatched(adapted);
    return WATCHED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
        id: `watched:${b}`,
        title: WATCHED_TITLES[b],
        items: buckets[b].map((x) => x.it),
    }));
}

// computeLettersByName mirrors server's logic in
// internal/server/kids.go: case-insensitive first char, leading
// "the/a/an" articles stripped, items whose first char isn't A-Z
// bucketed into "#". Used by TagDetail's A-Z jump modal because
// the tag-detail endpoint returns items in one shot (no
// pagination), so the index map can be computed client-side.
function computeLettersByName(items: TagItem[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < items.length; i++) {
        let raw = items[i].name.trim();
        const lower = raw.toLowerCase();
        if (lower.startsWith("the ")) raw = raw.slice(4);
        else if (lower.startsWith("an ")) raw = raw.slice(3);
        else if (lower.startsWith("a ")) raw = raw.slice(2);
        if (!raw) continue;
        const ch = raw[0].toUpperCase();
        const key = ch >= "A" && ch <= "Z" ? ch : "#";
        if (out[key] === undefined) out[key] = i;
    }
    return out;
}

type Focus =
    | { kind: "back" }
    | { kind: "filter" }
    | { kind: "sort" }
    | { kind: "jump" }
    | { kind: "emptyAction" }
    | { kind: "tile"; section: number; item: number };

function adaptItem(it: TagItem): TileItem {
    return {
        Id: it.id,
        Name: it.name,
        Type: it.type,
        ImageTags: it.imageTags?.Primary
            ? { Primary: it.imageTags.Primary }
            : undefined,
        UserData: it.userData,
    };
}

export default function TagDetail() {
    const nav = useNavigate();
    const { tagId } = useParams<{ tagId: string }>();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const adminProfileId = searchParams.get("profileId");
    const playSuffix = searchParams.toString()
        ? `?${searchParams.toString()}`
        : "";
    const [sort, setSort] = useState<SortId>(() => readSort());
    const [filter, setFilter] = useState<FilterId>(() => readFilter());
    const detailURL = useMemo(() => {
        if (!tagId) return null;
        if (!session && !adminProfileId) return null;
        const url = new URL(
            `/api/kids/tags/${encodeURIComponent(tagId)}`,
            window.location.origin,
        );
        url.searchParams.set("sort", sort);
        url.searchParams.set("filter", filter);
        if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
        return url.toString();
    }, [tagId, sort, filter, adminProfileId, session]);
    const cache = useMemo(() => sessionCache<TagDetailResponse>(), []);
    const detailCacheKey = `jellybean.kids.tagDetail.cache.${tagId ?? "x"}.${adminProfileId ?? "kid"}.${filter}.${sort}`;
    const { data: fetchedData, error } = useKidsResource<TagDetailResponse>({
        url: detailURL,
        cache,
        cacheKey: detailCacheKey,
    });
    const [data, setData] = useState<TagDetailResponse | null>(fetchedData);
    useEffect(() => {
        if (fetchedData) setData(fetchedData);
    }, [fetchedData]);
    const [filterOpen, setFilterOpen] = useState(false);
    const [sortOpen, setSortOpen] = useState(false);
    const [jumpOpen, setJumpOpen] = useState(false);
    const [focus, setFocus] = useState<Focus>({
        kind: "tile",
        section: 0,
        item: 0,
    });
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

    // Parent hid an item: drop it from the in-memory tag list. No
    // local cache to clean here - TagDetail always refetches on
    // mount, so a fresh visit will reflect the same prune naturally.
    useItemHiddenEvent((hiddenId) => {
        setData((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                items: prev.items.filter((it) => it.id !== hiddenId),
                itemCount: Math.max(0, prev.itemCount - 1),
            };
        });
    });

    const backRef = useRef<HTMLButtonElement | null>(null);
    const filterBtnRef = useRef<HTMLButtonElement | null>(null);
    const sortBtnRef = useRef<HTMLButtonElement | null>(null);
    const jumpBtnRef = useRef<HTMLButtonElement | null>(null);
    const emptyActionRef = useRef<HTMLButtonElement | null>(null);
    const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const sectionGridRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Transform-based vertical scroll - same rationale as Library
    // and Tags. window.scrollTo on this WebView retriggers a
    // multi-second repaint; transform on a wrapper div stays
    // GPU-only.
    const stack = useStackScroll();

    useLayoutEffect(() => {
        stack.setStackY(0, true);
        // stack methods are stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const offset = Math.floor(Math.random() * 2 * window.innerHeight);
        document.documentElement.style.setProperty(
            "--kids-bg-offset-y",
            `${offset}px`,
        );
        document.documentElement.style.removeProperty("--kids-bg-pos-y");
        return () => {
            document.documentElement.style.removeProperty(
                "--kids-bg-offset-y",
            );
        };
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(SORT_STORAGE, sort);
        } catch {
            /* ignore */
        }
    }, [sort]);
    useEffect(() => {
        try {
            localStorage.setItem(FILTER_STORAGE, filter);
        } catch {
            /* ignore */
        }
    }, [filter]);

    useEffect(() => {
        if (data) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [data]);

    const sections = useMemo(
        () => buildSections(data?.items ?? [], sort),
        [data, sort],
    );

    // Empty-state recovery: when the kid (or last kid) left the
    // filter on movies-only or shows-only, and the current tag has
    // none of that type, we render an "Unfilter N <type>" button
    // so the kid can recover with one click instead of being stuck
    // on what looks like an empty tag. Only show when there ARE
    // items of the OPPOSITE type to unfilter into; if both are 0
    // the tag is genuinely empty.
    const hiddenLabel = filter === "movies" ? "shows" : "movies";
    const hiddenCount =
        filter === "shows"
            ? (data?.movieCount ?? 0)
            : filter === "movies"
              ? (data?.seriesCount ?? 0)
              : 0;
    const showEmptyAction =
        !!data &&
        filter !== "all" &&
        sections.length === 0 &&
        hiddenCount > 0;

    // After a sort/filter change reshuffles sections, clamp tile
    // focus so it doesn't point into a now-missing section. Empty
    // result set drops to the recovery button when shown, otherwise
    // the back button.
    //
    // Gated on `data` being loaded: while the fetch is in flight,
    // sections is [] (buildSections([]) === []) which would
    // misfire the empty-clamp and pin focus to the back button
    // before the kid ever sees a tile.
    useEffect(() => {
        if (!data) return;
        if (focus.kind === "emptyAction" && !showEmptyAction) {
            setFocus({ kind: "back" });
            return;
        }
        if (focus.kind !== "tile") return;
        if (sections.length === 0) {
            setFocus(
                showEmptyAction
                    ? { kind: "emptyAction" }
                    : { kind: "back" },
            );
            return;
        }
        const sec = sections[focus.section];
        if (sec && focus.item < sec.items.length) return;
        setFocus({ kind: "tile", section: 0, item: 0 });
    }, [data, sections, focus, showEmptyAction]);

    const columns = useGridColumns(sectionGridRefs, sections);

    useEffect(() => {
        if (focus.kind === "back") {
            backRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
        } else if (focus.kind === "filter") {
            filterBtnRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
        } else if (focus.kind === "sort") {
            sortBtnRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
        } else if (focus.kind === "jump") {
            jumpBtnRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
        } else if (focus.kind === "emptyAction") {
            emptyActionRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
        } else if (focus.kind === "tile") {
            const key = `tile:${focus.section}:${focus.item}`;
            const el = tileRefs.current[key];
            if (el) {
                el.focus({ preventScroll: true });
                const onFirstRow =
                    focus.section === 0 && focus.item < Math.max(1, columns);
                if (onFirstRow) {
                    stack.scrollToTop();
                } else {
                    stack.scrollToCenter(el);
                }
            }
        }
    }, [focus, data, columns, stack]);

    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            if (filterOpen) {
                setFilterOpen(false);
                return true;
            }
            if (sortOpen) {
                setSortOpen(false);
                return true;
            }
            if (jumpOpen) {
                setJumpOpen(false);
                return true;
            }
            nav(`/tags${playSuffix}`);
            return true;
        }, [override, filterOpen, sortOpen, jumpOpen, nav, playSuffix]),
    );

    const focusedItem =
        focus.kind === "tile"
            ? sections[focus.section]?.items[focus.item]
            : undefined;
    const handleShortPress = useCallback(() => {
        if (!focusedItem) return;
        nav(`/watch/${encodeURIComponent(focusedItem.id)}${playSuffix}`);
    }, [focusedItem, nav, playSuffix]);
    const handleLongPress = useCallback(() => {
        if (!focusedItem) return;
        const pct = focusedItem.userData?.PlayedPercentage ?? 0;
        const playedFlag = !!focusedItem.userData?.Played;
        setOverride({
            itemId: focusedItem.id,
            itemName: focusedItem.name,
            itemType: focusedItem.type,
            played: playedFlag || pct >= 90,
        });
    }, [focusedItem]);
    useLongPressEnter({
        enabled:
            !!focusedItem &&
            !!session &&
            override === null &&
            !filterOpen &&
            !sortOpen &&
            !jumpOpen,
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

    useEffect(() => {
        if (override) return;
        if (filterOpen || sortOpen || jumpOpen) return;
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            if (
                k !== "ArrowLeft" &&
                k !== "ArrowRight" &&
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter" &&
                k !== " "
            ) {
                return;
            }
            e.preventDefault();
            const totalSections = sections.length;
            // When the kid is on a chrome control (back / filter /
            // sort / jump) and there's no content, ArrowDown lands
            // on the empty-state recovery button if it's shown,
            // else stays on the chrome row.
            const downToContent = (): Focus | null => {
                if (totalSections > 0) {
                    return { kind: "tile", section: 0, item: 0 };
                }
                if (showEmptyAction) {
                    return { kind: "emptyAction" };
                }
                return null;
            };
            if (focus.kind === "back") {
                if (k === "ArrowDown") {
                    const dest = downToContent();
                    setFocus(dest ?? { kind: "filter" });
                } else if (k === "ArrowRight") {
                    setFocus({ kind: "filter" });
                } else if (k === "Enter" || k === " ") {
                    nav(`/tags${playSuffix}`);
                }
                return;
            }
            if (focus.kind === "filter") {
                if (k === "ArrowLeft") {
                    setFocus({ kind: "back" });
                } else if (k === "ArrowRight") {
                    setFocus({ kind: "sort" });
                } else if (k === "ArrowDown") {
                    const dest = downToContent();
                    if (dest) setFocus(dest);
                } else if (k === "ArrowUp") {
                    setFocus({ kind: "back" });
                } else if (k === "Enter" || k === " ") {
                    setFilterOpen(true);
                }
                return;
            }
            if (focus.kind === "sort") {
                if (k === "ArrowLeft") {
                    setFocus({ kind: "filter" });
                } else if (k === "ArrowRight") {
                    setFocus({ kind: "jump" });
                } else if (k === "ArrowDown") {
                    const dest = downToContent();
                    if (dest) setFocus(dest);
                } else if (k === "ArrowUp") {
                    setFocus({ kind: "back" });
                } else if (k === "Enter" || k === " ") {
                    setSortOpen(true);
                }
                return;
            }
            if (focus.kind === "jump") {
                if (k === "ArrowLeft") {
                    setFocus({ kind: "sort" });
                } else if (k === "ArrowDown") {
                    const dest = downToContent();
                    if (dest) setFocus(dest);
                } else if (k === "ArrowUp") {
                    setFocus({ kind: "back" });
                } else if (k === "Enter" || k === " ") {
                    setJumpOpen(true);
                }
                return;
            }
            if (focus.kind === "emptyAction") {
                // Single button: ArrowUp / ArrowLeft go back to the
                // chrome row, ArrowRight cycles through chrome,
                // Enter clears the filter.
                if (k === "ArrowUp") {
                    setFocus({ kind: "filter" });
                } else if (k === "ArrowLeft" || k === "ArrowRight") {
                    // No-op for now; the chrome buttons handle their
                    // own horizontal nav. Pressing left/right while
                    // here is a hint the kid wants to change the
                    // filter from the dropdown.
                } else if (k === "Enter" || k === " ") {
                    setFilter("all");
                    setFocus({ kind: "tile", section: 0, item: 0 });
                }
                return;
            }
            if (focus.kind === "tile") {
                setFocus((f) =>
                    f.kind === "tile"
                        ? moveTile(f, k, sections, columns)
                        : f,
                );
                return;
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [focus, sections, columns, nav, playSuffix, override, filterOpen, sortOpen, jumpOpen, showEmptyAction]);

    const goBack = () => nav(`/tags${playSuffix}`);

    if (error) {
        return (
            <div className="kids-page kids-tag-detail">
                <div className="kids-home-bg" aria-hidden />
                <header className="kids-tag-detail-header">
                    <button
                        type="button"
                        ref={backRef}
                        className="kids-tag-detail-back focused"
                        onClick={goBack}
                        aria-label="Back to tags"
                    >
                        <ArrowLeft weight="fill" aria-hidden />
                    </button>
                </header>
                <p className="kids-tag-detail-state">
                    Couldn't load this tag ({error}).
                </p>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="kids-page kids-tag-detail">
                <div className="kids-home-bg" aria-hidden />
                <header className="kids-tag-detail-header">
                    <button
                        type="button"
                        ref={backRef}
                        className={`kids-tag-detail-back ${focus.kind === "back" ? "focused" : ""}`}
                        onClick={goBack}
                        aria-label="Back to tags"
                    >
                        <ArrowLeft weight="fill" aria-hidden />
                    </button>
                </header>
                <p className="kids-tag-detail-state">Loading…</p>
            </div>
        );
    }

    return (
        <div className="kids-page kids-tag-detail">
            <div className="kids-home-bg" aria-hidden />
            <div ref={stack.stackRef} className="kids-stack kids-tag-detail-stack">
            <header className="kids-tag-detail-header">
                <button
                    type="button"
                    ref={backRef}
                    className={`kids-tag-detail-back ${focus.kind === "back" ? "focused" : ""}`}
                    tabIndex={focus.kind === "back" ? 0 : -1}
                    onClick={goBack}
                    onFocus={() => setFocus({ kind: "back" })}
                    aria-label="Back to tags"
                >
                    <ArrowLeft weight="fill" aria-hidden />
                </button>
                <div className="kids-tag-detail-titles">
                    <h1 className="kids-tag-detail-title">
                        <TagIcon name={data.icon} />
                        {data.name}
                    </h1>
                    {data.description && (
                        <p className="kids-tag-detail-desc">
                            {data.description}
                        </p>
                    )}
                </div>
                <div className="kids-tag-detail-controls">
                    <button
                        type="button"
                        ref={filterBtnRef}
                        className={`library-dropdown-btn ${focus.kind === "filter" ? "focused" : ""}`}
                        tabIndex={focus.kind === "filter" ? 0 : -1}
                        onClick={() => setFilterOpen(true)}
                        onFocus={() => setFocus({ kind: "filter" })}
                    >
                        <span className="library-dropdown-label">Filter:</span>
                        <span className="library-dropdown-value">
                            {labelFor(FILTER_OPTIONS, filter)}
                        </span>
                    </button>
                    <button
                        type="button"
                        ref={sortBtnRef}
                        className={`library-dropdown-btn ${focus.kind === "sort" ? "focused" : ""}`}
                        tabIndex={focus.kind === "sort" ? 0 : -1}
                        onClick={() => setSortOpen(true)}
                        onFocus={() => setFocus({ kind: "sort" })}
                    >
                        <span className="library-dropdown-label">Sort:</span>
                        <span className="library-dropdown-value">
                            {labelFor(SORT_OPTIONS, sort)}
                        </span>
                    </button>
                    <button
                        type="button"
                        ref={jumpBtnRef}
                        className={`library-alpha-btn library-jump-btn ${focus.kind === "jump" ? "focused" : ""}`}
                        tabIndex={focus.kind === "jump" ? 0 : -1}
                        onClick={() => setJumpOpen(true)}
                        onFocus={() => setFocus({ kind: "jump" })}
                        aria-label="Jump"
                        title="Jump"
                    >
                        <span>Jump</span>
                        <ArrowBendRightDown weight="bold" aria-hidden />
                    </button>
                </div>
            </header>
            {sections.length === 0 ? (
                showEmptyAction ? (
                    // The kid (or last kid) left the filter on
                    // movies-only or shows-only on a different tag,
                    // and this one has none of that type. Tell them
                    // big-and-bold what they're seeing, plus a
                    // focusable recovery button labeled with the
                    // count of items they'd unfilter into.
                    <div className="kids-tag-detail-state kids-tag-detail-empty">
                        <p className="kids-tag-detail-empty-msg">
                            No{" "}
                            {filter === "movies" ? "movies" : "shows"} in{" "}
                            {data.name}.
                        </p>
                        <button
                            type="button"
                            ref={emptyActionRef}
                            tabIndex={
                                focus.kind === "emptyAction" ? 0 : -1
                            }
                            className={`kids-tag-detail-empty-action ${
                                focus.kind === "emptyAction"
                                    ? "focused"
                                    : ""
                            }`}
                            onClick={() => {
                                setFilter("all");
                                setFocus({
                                    kind: "tile",
                                    section: 0,
                                    item: 0,
                                });
                            }}
                            onFocus={() => setFocus({ kind: "emptyAction" })}
                        >
                            Unfilter {hiddenCount} {hiddenLabel}
                        </button>
                    </div>
                ) : (
                    <p className="kids-tag-detail-state">
                        No items in this tag yet.
                    </p>
                )
            ) : (
                <>
                    {sections.map((s, sIdx) => (
                        <section
                            key={s.id}
                            className="kids-section"
                            aria-label={s.title ?? data.name}
                        >
                            {s.title && (
                                <h2 className="kids-section-title">
                                    {s.title}
                                </h2>
                            )}
                            <div
                                className="grid kids-tag-detail-grid"
                                ref={(el) =>
                                    (sectionGridRefs.current[sIdx] = el)
                                }
                            >
                                {s.items.map((it, i) => {
                                    const key = `tile:${sIdx}:${i}`;
                                    const isFoc =
                                        focus.kind === "tile" &&
                                        focus.section === sIdx &&
                                        focus.item === i;
                                    return (
                                        <Tile
                                            key={`${s.id}:${it.id}`}
                                            item={adaptItem(it)}
                                            size="library"
                                            focused={isFoc}
                                            showProgress
                                            priority
                                            onClick={() => {
                                                setFocus({
                                                    kind: "tile",
                                                    section: sIdx,
                                                    item: i,
                                                });
                                                nav(
                                                    `/watch/${encodeURIComponent(it.id)}${playSuffix}`,
                                                );
                                            }}
                                            onFocus={() =>
                                                setFocus({
                                                    kind: "tile",
                                                    section: sIdx,
                                                    item: i,
                                                })
                                            }
                                            refCallback={(el) => {
                                                tileRefs.current[key] = el;
                                            }}
                                        />
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </>
            )}
            </div>
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
            {filterOpen && (
                <OptionPickerModal
                    title="Filter"
                    options={FILTER_OPTIONS}
                    currentId={filter}
                    onSelect={(id) => {
                        setFilter(id as FilterId);
                        setFilterOpen(false);
                    }}
                    onClose={() => setFilterOpen(false)}
                />
            )}
            {sortOpen && (
                <OptionPickerModal
                    title="Sort"
                    options={SORT_OPTIONS}
                    currentId={sort}
                    onSelect={(id) => {
                        setSort(id as SortId);
                        setSortOpen(false);
                    }}
                    onClose={() => setSortOpen(false)}
                />
            )}
            {jumpOpen &&
                (sort === "name" ? (
                    <AlphaPickerModal
                        lettersByName={computeLettersByName(
                            sections[0]?.items ?? [],
                        )}
                        onPick={(idx) => {
                            setJumpOpen(false);
                            setFocus({
                                kind: "tile",
                                section: 0,
                                item: idx,
                            });
                        }}
                        onClose={() => {
                            setJumpOpen(false);
                            setFocus({ kind: "jump" });
                        }}
                    />
                ) : (
                    <OptionPickerModal
                        title="Jump to"
                        options={sections.map((s) => ({
                            id: s.id,
                            label: s.title ?? "All",
                        }))}
                        currentId=""
                        onSelect={(id) => {
                            const idx = sections.findIndex(
                                (s) => s.id === id,
                            );
                            setJumpOpen(false);
                            if (idx >= 0) {
                                setFocus({
                                    kind: "tile",
                                    section: idx,
                                    item: 0,
                                });
                            } else {
                                setFocus({ kind: "jump" });
                            }
                        }}
                        onClose={() => {
                            setJumpOpen(false);
                            setFocus({ kind: "jump" });
                        }}
                    />
                ))}
        </div>
    );
}

function moveTile(
    f: { kind: "tile"; section: number; item: number },
    key: string,
    sections: Section[],
    columns: number,
): Focus {
    const cols = Math.max(1, columns);
    const sec = sections[f.section];
    if (!sec) return f;
    const len = sec.items.length;
    const i = f.item;
    const col = i % cols;
    const rowInSec = Math.floor(i / cols);
    if (key === "ArrowLeft") {
        if (col === 0) return f;
        return { kind: "tile", section: f.section, item: i - 1 };
    }
    if (key === "ArrowRight") {
        if (col + 1 >= cols || i + 1 >= len) return f;
        return { kind: "tile", section: f.section, item: i + 1 };
    }
    if (key === "ArrowDown") {
        const nextRowStart = (rowInSec + 1) * cols;
        if (nextRowStart < len) {
            const nextRowItems = Math.min(cols, len - nextRowStart);
            const target = Math.min(col, nextRowItems - 1);
            return {
                kind: "tile",
                section: f.section,
                item: nextRowStart + target,
            };
        }
        const nextSec = sections[f.section + 1];
        if (nextSec) {
            const firstRowItems = Math.min(cols, nextSec.items.length);
            const target = Math.min(col, firstRowItems - 1);
            return {
                kind: "tile",
                section: f.section + 1,
                item: Math.max(0, target),
            };
        }
        return f;
    }
    if (key === "ArrowUp") {
        if (rowInSec > 0) {
            const prevRowStart = (rowInSec - 1) * cols;
            return {
                kind: "tile",
                section: f.section,
                item: prevRowStart + col,
            };
        }
        if (f.section > 0) {
            const prev = sections[f.section - 1];
            const prevLen = prev.items.length;
            const lastRowStart = Math.floor((prevLen - 1) / cols) * cols;
            const lastRowItems = prevLen - lastRowStart;
            const target = Math.min(col, lastRowItems - 1);
            return {
                kind: "tile",
                section: f.section - 1,
                item: lastRowStart + Math.max(0, target),
            };
        }
        return { kind: "back" };
    }
    return f;
}

// See Library's useGridColumns for the rationale: read
// gridTemplateColumns from computed style so a section with a single
// item (e.g. "Added today" with 1 entry) doesn't collapse the
// reported column count to 1.
function useGridColumns(
    refs: React.MutableRefObject<(HTMLDivElement | null)[]>,
    sections: Section[],
): number {
    const [cols, setCols] = useState(4);
    useEffect(() => {
        const update = () => {
            const grid = refs.current.find((g) => g && g.children.length > 0);
            if (!grid) return;
            const tpl = window
                .getComputedStyle(grid)
                .gridTemplateColumns.trim();
            if (tpl && tpl !== "none") {
                const tracks = tpl.split(/\s+/).filter(Boolean).length;
                if (tracks > 0) {
                    setCols(tracks);
                    return;
                }
            }
            let best: HTMLDivElement | null = null;
            let bestLen = 0;
            for (const g of refs.current) {
                if (g && g.children.length > bestLen) {
                    best = g;
                    bestLen = g.children.length;
                }
            }
            if (!best) return;
            const first = best.children[0] as HTMLElement;
            const firstTop = first.offsetTop;
            let count = 0;
            for (let i = 0; i < best.children.length; i++) {
                const c = best.children[i] as HTMLElement;
                if (Math.abs(c.offsetTop - firstTop) > 1) break;
                count++;
            }
            if (count > 0) setCols(count);
        };
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [refs, sections]);
    return cols;
}

function TagIcon({ name }: { name?: string }) {
    if (!name || !isTagIconName(name)) return null;
    const Icon = TAG_ICONS[name];
    return (
        <Icon
            weight="fill"
            className="kids-tag-detail-title-icon"
            aria-hidden
        />
    );
}
