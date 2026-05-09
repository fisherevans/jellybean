import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowBendRightDown } from "@phosphor-icons/react";
import {
    authHeaders,
    clearSession,
    getSession,
    probeAdmin,
    withAuthRetry,
    type AdminUser,
    type Session,
} from "./auth";
import Tile from "./Tile";
import TileGrid, { type GridFocus, type GridSection } from "./TileGrid";
import {
    cacheKey as buildCacheKey,
    get as cacheGet,
    set as cacheSet,
    clear as clearLibraryCache,
} from "./libraryCache";
import { useItemHiddenEvent } from "./itemHidden";
import { useOnlineStatus } from "./onlineStatus";
import AlphaPickerModal from "./AlphaPickerModal";
import OptionPickerModal from "./OptionPickerModal";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useKidsHome } from "./KidsHome";
import { setHomeTab } from "./kidNav";
import { useProgressiveBack } from "./useProgressiveBack";
import { useStackScroll } from "./useStackScroll";
import {
    bucketByAdded,
    bucketByWatched,
    ADDED_ORDER,
    WATCHED_ORDER,
    type AddedBucket,
    type WatchedBucket,
} from "./dateBuckets";

// Library is the kid's main browsing screen. Top-to-bottom:
//
//   [search][filter][sort][A-Z]   (controls row)
//   [grid - flat OR sectioned]
//
// Sort = "name" renders a single flat grid (with A-Z jump). Sort =
// "recently_added" / "recently_watched" renders time-bucketed
// sections (Added today / Watched this week / Never watched / etc.)
// and hides the A-Z jump - alpha quick-jump doesn't apply when
// content isn't alphabetized.
//
// The sectioned grid + arrow nav inside it lives in <TileGrid>; this
// page owns the controls row, the focus state machine, and the
// load-more sentinel.
//
// Continue Watching lives only on Browse; Library is curation +
// browse, not "what was I in the middle of."

type LibraryItem = {
    Id: string;
    Name: string;
    Type: string;
    DateCreated?: string;
    ImageTags?: { Primary?: string };
    UserData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        LastPlayedDate?: string;
    };
};

type LibraryResponse = {
    Items: LibraryItem[] | null;
    HasMore?: boolean;
    NextStartIndex?: number;
    ProfileId?: number;
    LettersByName?: Record<string, number>;
};

type FilterId = "all" | "movies" | "shows";
type SortId = "name" | "recently_added" | "recently_watched";

const FILTER_STORAGE = "jellybean.kids.library.filter";
const SORT_STORAGE = "jellybean.kids.library.sort";

const FILTER_OPTIONS: { id: FilterId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "movies", label: "Movies" },
    { id: "shows", label: "Shows" },
];
const SORT_OPTIONS: { id: SortId; label: string }[] = [
    { id: "name", label: "A - Z" },
    { id: "recently_added", label: "Recently added" },
    { id: "recently_watched", label: "Recently watched" },
];

function readFilter(): FilterId {
    try {
        const v = localStorage.getItem(FILTER_STORAGE);
        if (v === "all" || v === "movies" || v === "shows") return v;
    } catch {
        /* ignore */
    }
    return "all";
}
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
function filterToType(f: FilterId): string {
    if (f === "movies") return "Movie";
    if (f === "shows") return "Series";
    return "Movie,Series";
}
function labelFor<T extends { id: string; label: string }>(
    list: T[],
    id: string,
): string {
    return list.find((o) => o.id === id)?.label ?? "";
}

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

function buildSections(
    items: LibraryItem[],
    sort: SortId,
): GridSection<LibraryItem>[] {
    if (items.length === 0) return [];
    if (sort === "name") {
        return [{ id: "all", items }];
    }
    if (sort === "recently_added") {
        const adapted = items.map((it) => ({
            it,
            dateCreated: it.DateCreated,
        }));
        const buckets = bucketByAdded(adapted);
        return ADDED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
            id: `added:${b}`,
            label: ADDED_TITLES[b],
            items: buckets[b].map((x) => x.it),
        }));
    }
    // recently_watched
    const adapted = items.map((it) => ({
        it,
        name: it.Name,
        userData: { lastPlayedDate: it.UserData?.LastPlayedDate },
    }));
    const buckets = bucketByWatched(adapted);
    return WATCHED_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
        id: `watched:${b}`,
        label: WATCHED_TITLES[b],
        items: buckets[b].map((x) => x.it),
    }));
}

type Focus =
    | { kind: "alphaBtn" }
    | { kind: "search" }
    | { kind: "filter" }
    | { kind: "sort" }
    | { kind: "grid"; section: number; item: number };

const PAGE_SIZE = 5000;

export default function Library() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const adminProfileId = searchParams.get("profileId");

    useEffect(() => {
        setHomeTab("library");
    }, []);
    const restoredScrollRef = useRef(false);
    const playSuffix = searchParams.toString()
        ? `?${searchParams.toString()}`
        : "";

    // Transform-based vertical scroll. window.scrollTo on this
    // WebView retriggers a 200-1000ms full-viewport repaint per
    // write, which made the smoothScroll animator freeze for
    // seconds at a time on Down. Stack-based transform scroll
    // (same pattern Browse uses) stays GPU-only.
    const stack = useStackScroll();

    const navToWatch = useCallback(
        (itemId: string) => {
            try {
                // stackY is negative when scrolled down; persist
                // the absolute amount so the post-load restore
                // can re-apply it without sign confusion.
                const scrollAmount = Math.max(
                    0,
                    -(stack.stackYRef.current ?? 0),
                );
                sessionStorage.setItem(
                    "jellybean.kids.library.scrollY",
                    String(scrollAmount),
                );
                sessionStorage.setItem(
                    "jellybean.kids.library.expectBack",
                    "1",
                );
            } catch {
                /* ignore */
            }
            nav(`/watch/${encodeURIComponent(itemId)}${playSuffix}`);
        },
        [nav, playSuffix, stack.stackYRef],
    );

    const [filter, setFilter] = useState<FilterId>(() => readFilter());
    const [sort, setSort] = useState<SortId>(() => readSort());
    const [filterOpen, setFilterOpen] = useState(false);
    const [sortOpen, setSortOpen] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    useEffect(() => {
        const id = window.setTimeout(() => setSearchDebounced(searchInput), 300);
        return () => window.clearTimeout(id);
    }, [searchInput]);

    const [items, setItems] = useState<LibraryItem[]>([]);
    const [lettersByName, setLettersByName] = useState<Record<string, number>>(
        {},
    );
    const [alphaModalOpen, setAlphaModalOpen] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [nextStart, setNextStart] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [cacheHit, setCacheHit] = useState(false);
    useEffect(() => {
        if (!loading) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [loading]);
    const [retryNonce, setRetryNonce] = useState(0);
    const online = useOnlineStatus();

    const [focus, setFocus] = useState<Focus>({ kind: "search" });
    const chromeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const homeCtx = useKidsHome();
    const { tabFocused, setTabFocused } = homeCtx;
    const searchWrapRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const [override, setOverride] = useState<{
        itemId: string;
        itemName: string;
        itemType: string;
        seriesId?: string;
        seriesName?: string;
        played?: boolean;
    } | null>(null);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(FILTER_STORAGE, filter);
        } catch {
            /* ignore */
        }
    }, [filter]);
    useEffect(() => {
        try {
            localStorage.setItem(SORT_STORAGE, sort);
        } catch {
            /* ignore */
        }
    }, [sort]);

    const wasOnline = useRef(online);
    useEffect(() => {
        if (!wasOnline.current && online) {
            setRetryNonce((n) => n + 1);
        }
        wasOnline.current = online;
    }, [online]);

    const buildURL = useCallback(
        (startIndex: number) => {
            const url = new URL("/api/kids/library", window.location.origin);
            url.searchParams.set("section", "all");
            url.searchParams.set("type", filterToType(filter));
            url.searchParams.set("sort", sort);
            url.searchParams.set("limit", String(PAGE_SIZE));
            if (startIndex > 0) {
                url.searchParams.set("startIndex", String(startIndex));
            }
            if (searchDebounced) {
                url.searchParams.set("search", searchDebounced);
            }
            if (adminProfileId)
                url.searchParams.set("profileId", adminProfileId);
            return url.toString();
        },
        [filter, sort, adminProfileId, searchDebounced],
    );

    const fetchPage = useCallback(
        async (
            startIndex: number,
            ifNoneMatch?: string,
        ): Promise<
            | { status: "modified"; page: LibraryResponse; etag: string }
            | { status: "not-modified"; etag: string }
        > => {
            const headers: Record<string, string> = { ...authHeaders() };
            if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
            const res = await withAuthRetry(() =>
                fetch(buildURL(startIndex), {
                    credentials: "same-origin",
                    headers,
                }),
            );
            const etag = res.headers.get("ETag") ?? "";
            if (res.status === 304) {
                return { status: "not-modified", etag };
            }
            if (!res.ok) {
                if (res.status === 401) {
                    const e = new Error("unauthorized");
                    (e as Error & { code?: string }).code = "UNAUTHORIZED";
                    throw e;
                }
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            const page = (await res.json()) as LibraryResponse;
            return { status: "modified", page, etag };
        },
        [buildURL],
    );

    const useCache = !!session && !adminProfileId && !searchDebounced;
    const userId = session?.userId ?? "";
    const typeStr = filterToType(filter);
    const allKey = useCache
        ? buildCacheKey(userId, "all", typeStr, PAGE_SIZE, 0, "", sort)
        : null;

    useEffect(() => {
        if (admin === undefined) return;
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
            return;
        }
        let cancelled = false;
        setError(null);
        setRefreshError(null);
        setCacheHit(false);
        setNextStart(0);
        setHasMore(false);

        const allK = allKey;
        let allEtag: string | undefined;

        const cacheReads = (async () => {
            if (!allK) {
                setLoading(true);
                setItems([]);
                return;
            }
            const allHit = await cacheGet(allK);
            if (cancelled) return;
            if (allHit) {
                const cached = allHit.page as LibraryResponse;
                setItems(cached.Items ?? []);
                setHasMore(!!cached.HasMore);
                setNextStart(
                    cached.NextStartIndex ?? (cached.Items?.length ?? 0),
                );
                setLettersByName(cached.LettersByName ?? {});
                allEtag = allHit.etag;
                setLoading(false);
                setCacheHit(true);
            } else {
                setItems([]);
                setLoading(true);
            }
        })();

        cacheReads
            .then(() => fetchPage(0, allEtag))
            .then((all) => {
                if (cancelled) return;
                if (all.status === "modified") {
                    setItems(all.page.Items ?? []);
                    setHasMore(!!all.page.HasMore);
                    setNextStart(
                        all.page.NextStartIndex ??
                            (all.page.Items?.length ?? 0),
                    );
                    setLettersByName(all.page.LettersByName ?? {});
                    if (allK && all.etag) {
                        cacheSet(allK, all.page, all.etag).catch(() => {});
                    }
                }
                setLoading(false);
                setRefreshError(null);
                setCacheHit(false);
            })
            .catch((err) => {
                if (cancelled) return;
                const isUnauthorized =
                    err &&
                    typeof err === "object" &&
                    (err as { code?: string }).code === "UNAUTHORIZED";
                const haveCache = allEtag !== undefined;
                if (isUnauthorized && !haveCache) {
                    clearSession();
                    nav("/login", { replace: true });
                    return;
                }
                if (haveCache) {
                    setRefreshError(
                        isUnauthorized
                            ? "Sign-in expired"
                            : "Couldn't refresh",
                    );
                } else {
                    setError(String(err.message ?? err));
                }
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [admin, session, adminProfileId, fetchPage, nav, allKey, retryNonce]);

    // Infinite scroll only applies when sort=name (recency sorts
    // return the entire visible set in one response, so there's no
    // sentinel to observe).
    useEffect(() => {
        if (sort !== "name") return;
        if (!sentinelRef.current || !hasMore || loadingMore || loading) return;
        const el = sentinelRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                const visible = entries[0]?.isIntersecting ?? false;
                if (!visible) return;
                setLoadingMore(true);
                fetchPage(nextStart)
                    .then((res) => {
                        if (res.status !== "modified") return;
                        const page = res.page;
                        setItems((cur) => [...cur, ...(page.Items ?? [])]);
                        setNextStart(page.NextStartIndex ?? nextStart);
                        setHasMore(!!page.HasMore);
                    })
                    .catch((err) => setError(String(err.message ?? err)))
                    .finally(() => setLoadingMore(false));
            },
            { rootMargin: "400px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [sort, hasMore, loadingMore, loading, nextStart, fetchPage]);

    // Parent hid an item from the modal: drop it from the in-memory
    // list and nuke the library cache so a remount refetches a clean
    // slate. We don't surgically rewrite IDB here because the
    // alphabet index (LettersByName) would still point at stale
    // offsets; clearing forces a fresh fetch on next mount, which is
    // cheap and matches the kid's expectation that the item is just
    // gone.
    useItemHiddenEvent((hiddenId) => {
        setItems((cur) => cur.filter((it) => it.Id !== hiddenId));
        clearLibraryCache().catch(() => {});
    });

    const sections = useMemo(() => buildSections(items, sort), [items, sort]);
    const totalItems = items.length;

    // After a sort change, any "grid" focus that pointed into the
    // previous section layout may now point past the new sections /
    // out of bounds. Clamp it so TileGrid doesn't try to focus a
    // missing ref. Controls focus is fine as-is.
    useEffect(() => {
        if (focus.kind !== "grid") return;
        const sec = sections[focus.section];
        if (sec && focus.item < sec.items.length) return;
        if (sections.length === 0) {
            setFocus({ kind: "search" });
            return;
        }
        setFocus({ kind: "grid", section: 0, item: 0 });
    }, [sections, focus]);

    // Post-load scroll handling. The saved value is the absolute
    // scroll-amount (positive number representing how far down the
    // kid was); we apply it as a negative stackY (translate3d up).
    useEffect(() => {
        if (restoredScrollRef.current) return;
        if (loading) return;
        if (totalItems === 0) return;
        restoredScrollRef.current = true;
        const FLAG = "jellybean.kids.library.expectBack";
        const KEY = "jellybean.kids.library.scrollY";
        const expecting = sessionStorage.getItem(FLAG) === "1";
        sessionStorage.removeItem(FLAG);
        sessionStorage.removeItem(KEY);
        if (!expecting) {
            stack.setStackY(0, true);
            return;
        }
        const saved = sessionStorage.getItem(KEY);
        if (!saved) return;
        const y = Number(saved);
        if (!Number.isFinite(y) || y <= 0) return;
        // Two rAFs for parity with the old window-scroll path: lets
        // React commit + the browser settle layout before we
        // restore. With transform-based scroll the timing matters
        // less, but it doesn't hurt and keeps behavior stable across
        // image-load sizing wobble.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                stack.setStackY(-y, true);
            });
        });
    }, [loading, totalItems, stack]);

    // Bridge Library's Focus union to TileGrid's GridFocus shape.
    // null means a chrome control or the tab nav is focused and
    // TileGrid should idle.
    const gridFocus: GridFocus | null =
        focus.kind === "grid" && !tabFocused
            ? { sectionIdx: focus.section, itemIdx: focus.item }
            : null;
    const onGridFocusChange = useCallback((g: GridFocus) => {
        setFocus({ kind: "grid", section: g.sectionIdx, item: g.itemIdx });
    }, []);
    const onGridExitTop = useCallback(() => {
        // Up off section 0 row 0 hands focus back to the controls row.
        setFocus({ kind: "search" });
    }, []);

    // Focus DOM management for chrome focus. TileGrid handles the
    // grid case (focus + scroll on cell change) on its own.
    useEffect(() => {
        if (tabFocused) return;
        if (focus.kind === "grid") return;
        if (focus.kind === "search") {
            searchWrapRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
            return;
        }
        const el = chromeRefs.current[focus.kind];
        if (el) el.focus({ preventScroll: true });
        stack.scrollToTop();
    }, [focus, tabFocused, stack]);

    const wasTabFocused = useRef(true);
    useEffect(() => {
        if (wasTabFocused.current && !tabFocused) {
            setFocus({ kind: "search" });
        }
        wasTabFocused.current = tabFocused;
    }, [tabFocused]);

    useLayoutEffect(() => {
        stack.setStackY(0, true);
        // stack is stable across renders; safe to omit from deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!tabFocused) return;
        stack.setStackY(0, true);
        if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
        ) {
            document.activeElement.blur();
        }
    }, [tabFocused, stack]);

    // Page keydown for the controls row. TileGrid runs its own
    // listener for grid arrow nav when grid focus is active; the two
    // listeners coexist because they target disjoint focus regions.
    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    useEffect(() => {
        if (override || tabFocused) return;
        if (filterOpen || sortOpen || alphaModalOpen) return;
        if (focus.kind === "grid") return; // TileGrid owns the keys here
        const handler = (e: KeyboardEvent) => {
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
            const target = e.target as HTMLElement | null;
            const onSearchInput = target?.tagName === "INPUT";
            if (
                onSearchInput &&
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter"
            ) {
                return;
            }
            e.preventDefault();
            if (e.repeat) {
                const now = performance.now();
                if (now - lastMoveRef.current < REPEAT_MIN_MS) return;
                lastMoveRef.current = now;
            } else {
                lastMoveRef.current = performance.now();
            }
            // Up off the controls row hands focus back to the tab nav.
            if (k === "ArrowUp") {
                setTabFocused(true);
                return;
            }
            setFocus((f) =>
                moveControls(f, k, sections, {
                    setFilterOpen,
                    setSortOpen,
                    setAlphaModalOpen,
                    openSearch: () => searchInputRef.current?.focus(),
                }),
            );
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        focus,
        sections,
        override,
        tabFocused,
        setTabFocused,
        filterOpen,
        sortOpen,
        alphaModalOpen,
    ]);

    const focusedItem =
        focus.kind === "grid"
            ? sections[focus.section]?.items[focus.item]
            : undefined;
    const handleShortPress = useCallback(() => {
        if (!focusedItem) return;
        navToWatch(focusedItem.Id);
    }, [focusedItem, navToWatch]);
    const handleLongPress = useCallback(() => {
        if (!focusedItem) return;
        const pct = focusedItem.UserData?.PlayedPercentage ?? 0;
        setOverride({
            itemId: focusedItem.Id,
            itemName: focusedItem.Name,
            itemType: focusedItem.Type,
            played: pct >= 90,
        });
    }, [focusedItem]);
    useLongPressEnter({
        enabled:
            !!focusedItem &&
            !!session &&
            override === null &&
            !tabFocused &&
            !filterOpen &&
            !sortOpen &&
            !alphaModalOpen,
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

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
            if (alphaModalOpen) {
                setAlphaModalOpen(false);
                setFocus({ kind: "alphaBtn" });
                return true;
            }
            if (!tabFocused) {
                setTabFocused(true);
                // Reset content focus to the page's first slot
                // (search wrap) so the next Down lands on a fresh
                // entry point - not on the previously-focused tile.
                // wasTabFocused below already covers the
                // false→true→false cycle, but resetting here makes
                // the contract explicit (matches Browse) and avoids
                // a one-render flash where focus DOM-management
                // would re-focus the old tile and scrollWindowToCenter
                // it before the wasTabFocused effect's setFocus
                // commits. See web/kids/CLAUDE.md ("Back-then-Down
                // focus contract").
                setFocus({ kind: "search" });
                return true;
            }
            return false;
        }, [
            tabFocused,
            setTabFocused,
            override,
            alphaModalOpen,
            filterOpen,
            sortOpen,
        ]),
    );

    if (admin === undefined) return <div className="screen">Loading...</div>;

    return (
        <div className="library">
            {adminProfileId && !session && <AdminPreviewBanner />}
            <div ref={stack.stackRef} className="kids-stack library-stack">

            <div className="library-controls">
                <div
                    ref={searchWrapRef}
                    role="button"
                    aria-label="Search library"
                    className={`library-search-wrap ${
                        !tabFocused && focus.kind === "search" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "search" ? 0 : -1}
                    onClick={() => searchInputRef.current?.focus()}
                >
                    <input
                        ref={searchInputRef}
                        type="search"
                        className="library-search"
                        placeholder="Search"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
                <button
                    type="button"
                    ref={(el) => (chromeRefs.current["filter"] = el)}
                    className={`library-dropdown-btn ${
                        !tabFocused && focus.kind === "filter" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "filter" ? 0 : -1}
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
                    ref={(el) => (chromeRefs.current["sort"] = el)}
                    className={`library-dropdown-btn ${
                        !tabFocused && focus.kind === "sort" ? "focused" : ""
                    }`}
                    tabIndex={!tabFocused && focus.kind === "sort" ? 0 : -1}
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
                    ref={(el) => (chromeRefs.current["alphaBtn"] = el)}
                    className={`library-alpha-btn library-jump-btn ${
                        !tabFocused && focus.kind === "alphaBtn"
                            ? "focused"
                            : ""
                    }`}
                    tabIndex={
                        !tabFocused && focus.kind === "alphaBtn" ? 0 : -1
                    }
                    onClick={() => setAlphaModalOpen(true)}
                    onFocus={() => setFocus({ kind: "alphaBtn" })}
                    aria-label="Jump"
                    title="Jump"
                >
                    <span>Jump</span>
                    <ArrowBendRightDown weight="bold" aria-hidden />
                </button>
            </div>

            {error && <p className="error">{error}</p>}
            {!online && cacheHit && (
                <p className="kids-offline-pill" role="status">
                    Offline - showing cached library
                </p>
            )}
            {online && refreshError && (
                <p className="library-refresh-error" role="status">
                    {refreshError}
                </p>
            )}

            {loading ? (
                <p className="library-state">Loading...</p>
            ) : sections.length === 0 ? (
                <p className="library-state">
                    Nothing here yet. Ask a parent to mark titles visible.
                </p>
            ) : (
                <TileGrid<LibraryItem>
                    items={items}
                    sections={sections}
                    focus={gridFocus}
                    onFocusChange={onGridFocusChange}
                    onExitTop={onGridExitTop}
                    enabled={
                        !override && !filterOpen && !sortOpen && !alphaModalOpen
                    }
                    scrollToTop={stack.scrollToTop}
                    scrollToCenter={stack.scrollToCenter}
                    footer={
                        <>
                            {sort === "name" && (
                                <div ref={sentinelRef} className="sentinel" />
                            )}
                            {loadingMore && (
                                <p className="library-state">
                                    Loading more...
                                </p>
                            )}
                        </>
                    }
                    renderCell={(it, isFoc, refCallback, ctx) => (
                        <Tile
                            key={`${sections[ctx.sectionIdx].id}:${it.Id}`}
                            item={it}
                            size="library"
                            focused={!tabFocused && isFoc}
                            showProgress
                            onClick={() => {
                                setFocus({
                                    kind: "grid",
                                    section: ctx.sectionIdx,
                                    item: ctx.itemIdx,
                                });
                                navToWatch(it.Id);
                            }}
                            onFocus={() =>
                                setFocus({
                                    kind: "grid",
                                    section: ctx.sectionIdx,
                                    item: ctx.itemIdx,
                                })
                            }
                            refCallback={(el) =>
                                refCallback(el as HTMLElement | null)
                            }
                        />
                    )}
                />
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
            {alphaModalOpen &&
                (sort === "name" ? (
                    <AlphaPickerModal
                        lettersByName={lettersByName}
                        onPick={(gridIdx) => {
                            setAlphaModalOpen(false);
                            // Alpha picker indexes the flat (sort=name)
                            // grid; section 0 holds everything in that mode.
                            setFocus({
                                kind: "grid",
                                section: 0,
                                item: gridIdx,
                            });
                        }}
                        onClose={() => {
                            setAlphaModalOpen(false);
                            setFocus({ kind: "alphaBtn" });
                        }}
                    />
                ) : (
                    <OptionPickerModal
                        title="Jump to"
                        options={sections.map((s) => ({
                            id: s.id,
                            label: s.label ?? "All",
                        }))}
                        currentId=""
                        onSelect={(id) => {
                            const idx = sections.findIndex(
                                (s) => s.id === id,
                            );
                            setAlphaModalOpen(false);
                            if (idx >= 0) {
                                setFocus({
                                    kind: "grid",
                                    section: idx,
                                    item: 0,
                                });
                            } else {
                                setFocus({ kind: "alphaBtn" });
                            }
                        }}
                        onClose={() => {
                            setAlphaModalOpen(false);
                            setFocus({ kind: "alphaBtn" });
                        }}
                    />
                ))}
        </div>
    );
}

function AdminPreviewBanner() {
    return (
        <div className="admin-preview-banner" role="status">
            <span>
                Previewing as admin. Resume / continue-watching are disabled
                in preview.
            </span>
            <a href="/manage-kids" className="admin-preview-back">
                Back to admin
            </a>
        </div>
    );
}

type ActivateHandlers = {
    setFilterOpen: (v: boolean) => void;
    setSortOpen: (v: boolean) => void;
    setAlphaModalOpen: (v: boolean) => void;
    openSearch: () => void;
};

// moveControls handles arrow nav within the controls row only. Down
// from any control hands off to the first grid cell (TileGrid takes
// over from there). Up off the row is handled by the page's keydown
// listener separately.
function moveControls(
    f: Focus,
    key: string,
    sections: GridSection<LibraryItem>[],
    h: ActivateHandlers,
): Focus {
    if (key === "Enter" || key === " ") {
        if (f.kind === "filter") h.setFilterOpen(true);
        else if (f.kind === "sort") h.setSortOpen(true);
        else if (f.kind === "alphaBtn") h.setAlphaModalOpen(true);
        else if (f.kind === "search") h.openSearch();
        return f;
    }
    const firstGrid: Focus | null =
        sections.length > 0 && sections[0].items.length > 0
            ? { kind: "grid", section: 0, item: 0 }
            : null;
    switch (f.kind) {
        case "search":
            if (key === "ArrowLeft") return f;
            if (key === "ArrowRight") return { kind: "filter" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "filter":
            if (key === "ArrowLeft") return { kind: "search" };
            if (key === "ArrowRight") return { kind: "sort" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "sort":
            if (key === "ArrowLeft") return { kind: "filter" };
            if (key === "ArrowRight") return { kind: "alphaBtn" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "alphaBtn":
            if (key === "ArrowLeft") return { kind: "sort" };
            if (key === "ArrowDown") return firstGrid ?? f;
            return f;
        case "grid":
            // grid arrows are owned by TileGrid; this case never
            // fires in practice (the page-level handler skips when
            // grid focus is active).
            return f;
    }
}
