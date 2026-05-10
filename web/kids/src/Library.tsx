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
    bucketByAdded,
    bucketByWatched,
    ADDED_ORDER,
    WATCHED_ORDER,
    type AddedBucket,
    type Item,
    type WatchedBucket,
} from "jellybean-shared";
import {
    authHeaders,
    getSession,
    probeAdmin,
    withAuthRetry,
    type AdminUser,
    type Session,
} from "./auth";
import Tile from "./Tile";
import { clear as clearLibraryCache } from "./libraryCache";
import TileGrid, { type GridFocus, type GridSection } from "./TileGrid";
import {
    buildLibraryKey,
    idbLibraryCache,
    idbLibraryEtags,
} from "./kidsCache";
import { useKidsResource } from "./useKidsResource";
import { useItemHiddenEvent } from "./itemHidden";
import { useOnlineStatus } from "./onlineStatus";
import AlphaPickerModal from "./AlphaPickerModal";
import OptionPickerModal from "./OptionPickerModal";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import Keyboard from "./Keyboard";
import { useKidsHome } from "./KidsHome";
import { setHomeTab } from "./kidNav";
import { useProgressiveBack } from "./useProgressiveBack";
import { useStackScroll } from "./useStackScroll";
import { useHomeTabFocus } from "./useHomeTabFocus";

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

type LibraryItem = Pick<
    Item,
    "Id" | "Name" | "Type" | "DateCreated" | "ImageTags" | "UserData"
>;

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
    | { kind: "keyboard" }
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
    const [keyboardOpen, setKeyboardOpen] = useState(false);
    // The keyboard opens explicitly: Enter on the focused search wrap
    // (D-pad path) or a pointer click (admin preview / desktop test).
    // Earlier revisions auto-opened on first focus, but the kid keeps
    // arrowing up to search after typing - re-popping the keyboard
    // every time was annoying.
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
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [retryNonce, setRetryNonce] = useState(0);
    const online = useOnlineStatus();

    const chromeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const homeCtx = useKidsHome();
    const { focus, setFocus, tabFocused, setTabFocused, handleBack } =
        useHomeTabFocus<Focus>({
            initialFocus: { kind: "search" },
            getFirstContentSlot: () => ({ kind: "search" }),
            scrollToTop: () => stack.setStackY(0, true),
            // Back-then-down should reset, not restore. See the
            // matching reset in the useProgressiveBack handler below
            // for the keyboard-open path; this branch fires when the
            // kid was in the grid with the keyboard closed.
            onTabReset: () => {
                lastGridFocusRef.current = { section: 0, item: 0 };
                lastKeyboardPosRef.current = { row: 1, col: 1 };
                lastContentPaneRef.current = null;
            },
            tabNav: {
                tabFocused: homeCtx.tabFocused,
                setTabFocused: homeCtx.setTabFocused,
            },
        });
    const searchWrapRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    // Per-pane "last focused position" so ArrowDown from search (or
    // ArrowRight/ArrowLeft pane crossings) restores the kid to where
    // they were instead of slamming them back to (0, 0). The keyboard
    // already preserves its own internal `pos` as long as it stays
    // mounted, so we don't mirror that here - we only need this for
    // the grid. lastContentPaneRef remembers which pane below the
    // controls row was last in use; ArrowDown from search returns
    // there. Defaults to "keyboard" when the keyboard is open (it
    // sits directly below the controls), "grid" otherwise.
    const lastGridFocusRef = useRef<{ section: number; item: number }>({
        section: 0,
        item: 0,
    });
    const lastKeyboardPosRef = useRef<{ row: number; col: number }>({
        row: 1,
        col: 1,
    });
    // null = "no history yet, fall back to keyboard if open, grid
    // otherwise" (the kid hasn't been below the controls row this
    // session). Set to "grid" or "keyboard" once focus visits one
    // of those panes.
    const lastContentPaneRef = useRef<"grid" | "keyboard" | null>(null);
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

    // buildURL is shared between the first-page hook and the
    // load-more callback. The hook calls it with startIndex=0; load
    // more with the running cursor. searchDebounced disables both
    // the cache (server response varies per query) and the
    // background refetch on cache hit (no cache to revalidate).
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

    const useCache = !!session && !adminProfileId && !searchDebounced;
    const userId = session?.userId ?? "";
    const typeStr = filterToType(filter);
    const cacheKey = useCache
        ? buildLibraryKey(userId, "all", typeStr, PAGE_SIZE, 0, "", sort)
        : "";

    const cache = useMemo(() => idbLibraryCache<LibraryResponse>(), []);
    const etagBackend = useMemo(() => idbLibraryEtags(), []);
    const firstPageURL = useMemo(() => {
        if (admin === undefined) return null;
        if (!session && !adminProfileId) return null;
        return buildURL(0);
    }, [admin, session, adminProfileId, buildURL]);

    const {
        data: firstPage,
        error: hookError,
        loading,
        isStale: cacheHit,
        refreshError: hookRefreshError,
    } = useKidsResource<LibraryResponse>({
        url: firstPageURL,
        cache: useCache ? cache : undefined,
        cacheKey: useCache ? cacheKey : undefined,
        etag: useCache ? etagBackend : undefined,
        // Refetch when filter/sort/search/retry change. cacheKey
        // covers filter+sort+searchDebounced indirectly but isn't a
        // dep on its own (it's "" when useCache is false).
        deps: [firstPageURL, retryNonce],
    });

    // Drive the page-state from the hook's data. When the hook
    // delivers a cache hit synchronously, this fires immediately
    // and the kid sees tiles. When the network revalidation lands
    // and is a 200 (modified), the hook re-fires with the fresh
    // data and we re-derive. 304s don't refire data so we don't
    // re-derive (correct - the cached values are still current).
    useEffect(() => {
        if (!firstPage) return;
        setItems(firstPage.Items ?? []);
        setHasMore(!!firstPage.HasMore);
        setNextStart(firstPage.NextStartIndex ?? (firstPage.Items?.length ?? 0));
        setLettersByName(firstPage.LettersByName ?? {});
    }, [firstPage]);

    // Reset paging state when the URL changes (filter/sort/search
    // swap). Otherwise the IntersectionObserver-driven load-more
    // would fire against the previous filter's nextStart.
    useEffect(() => {
        setNextStart(0);
        setHasMore(false);
        setLoadMoreError(null);
    }, [firstPageURL]);

    // Map the hook's refreshError to Library's banner text. The
    // dedicated "unauthorized" sentinel surfaces a friendlier "Sign-in
    // expired" rather than the literal status code.
    const refreshError =
        hookRefreshError === "unauthorized"
            ? "Sign-in expired"
            : hookRefreshError !== null
              ? "Couldn't refresh"
              : null;
    const error = hookError;

    useEffect(() => {
        if (!loading) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [loading]);

    // Auth gate (mirrors Browse). Runs once admin probe completes.
    useEffect(() => {
        if (admin === undefined) return;
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [admin, session, adminProfileId, nav]);

    // Infinite scroll only applies when sort=name (recency sorts
    // return the entire visible set in one response, so there's no
    // sentinel to observe). Load-more stays a manual fetch (no
    // useKidsResource) - the hook is shaped for "page-level data
    // that flips on URL change," not for appending to a list.
    const loadMorePage = useCallback(async () => {
        const url = buildURL(nextStart);
        const res = await withAuthRetry(() =>
            fetch(url, {
                credentials: "same-origin",
                headers: authHeaders(),
            }),
        );
        if (!res.ok) {
            throw new Error(`${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as LibraryResponse;
    }, [buildURL, nextStart]);
    useEffect(() => {
        if (sort !== "name") return;
        if (!sentinelRef.current || !hasMore || loadingMore || loading) return;
        const el = sentinelRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                const visible = entries[0]?.isIntersecting ?? false;
                if (!visible) return;
                setLoadingMore(true);
                loadMorePage()
                    .then((page) => {
                        setItems((cur) => [...cur, ...(page.Items ?? [])]);
                        setNextStart(page.NextStartIndex ?? nextStart);
                        setHasMore(!!page.HasMore);
                    })
                    .catch((err) =>
                        setLoadMoreError(String(err.message ?? err)),
                    )
                    .finally(() => setLoadingMore(false));
            },
            { rootMargin: "400px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [sort, hasMore, loadingMore, loading, nextStart, loadMorePage]);

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
    const onGridExitLeft = useCallback(() => {
        // ArrowLeft off the grid's leftmost column hands focus to the
        // on-screen keyboard when it's open. When closed, the grid
        // already had nothing to its left - we no-op so the kid sees
        // a clamp instead of a flicker.
        if (!keyboardOpen) return;
        setFocus({ kind: "keyboard" });
    }, [keyboardOpen]);

    // Focus DOM management for chrome focus. TileGrid handles the
    // grid case (focus + scroll on cell change) on its own; the
    // Keyboard owns its internal cursor / DOM focus, so we skip
    // both here.
    //
    // When focus leaves "search" for keyboard / grid, we actively
    // blur the search wrap. The CSS rule `.library-search-wrap:focus`
    // keeps the white ring visible while the DOM holds focus on the
    // wrap; without an explicit blur the WebView leaves it there and
    // the kid sees the search ring AND the keyboard cell highlighted
    // simultaneously (the t17 stale-highlight bug).
    useEffect(() => {
        if (tabFocused) return;
        if (focus.kind === "grid" || focus.kind === "keyboard") {
            if (
                searchWrapRef.current &&
                document.activeElement === searchWrapRef.current
            ) {
                searchWrapRef.current.blur();
            }
            return;
        }
        if (focus.kind === "search") {
            searchWrapRef.current?.focus({ preventScroll: true });
            stack.scrollToTop();
            // Keyboard does NOT auto-open on focus. The kid presses
            // Enter on the focused search wrap to open it (handled by
            // moveControls -> openSearch).
            return;
        }
        const el = chromeRefs.current[focus.kind];
        if (el) el.focus({ preventScroll: true });
        stack.scrollToTop();
    }, [focus, tabFocused, stack]);

    // Position-memory tracking. Save the grid cursor whenever focus
    // is on a tile so we can restore it on re-entry from search /
    // keyboard. lastContentPaneRef records which pane below the
    // controls row was last used so ArrowDown from search returns
    // there (rather than always picking keyboard when open).
    useEffect(() => {
        if (focus.kind === "grid") {
            lastGridFocusRef.current = {
                section: focus.section,
                item: focus.item,
            };
            lastContentPaneRef.current = "grid";
        } else if (focus.kind === "keyboard") {
            lastContentPaneRef.current = "keyboard";
        }
    }, [focus]);

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

    // tabFocused → true scroll-to-top + blur lives in useHomeTabFocus.

    // Page keydown for the controls row. TileGrid runs its own
    // listener for grid arrow nav when grid focus is active; the two
    // listeners coexist because they target disjoint focus regions.
    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    useEffect(() => {
        if (override || tabFocused) return;
        if (filterOpen || sortOpen || alphaModalOpen) return;
        // Keyboard owns window keydown while focused. When the kid has
        // arrowed-right out of the keyboard into the grid (keyboard is
        // still open as a sibling pane), this listener should NOT
        // claim the keys - TileGrid owns them. The grid early-return
        // below handles that case naturally because focus.kind ===
        // "grid" while the kid is in the grid.
        if (focus.kind === "keyboard") return;
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
            // Activation (Enter / Space) on the chrome controls.
            // Handled here rather than inside moveControls so the
            // modal-open state setters fire as plain side effects
            // instead of being invoked from inside another setter's
            // updater (which made the click never reach React's
            // commit phase reliably on the WebView).
            if (k === "Enter" || k === " ") {
                if (focus.kind === "filter") {
                    setFilterOpen(true);
                    return;
                }
                if (focus.kind === "sort") {
                    setSortOpen(true);
                    return;
                }
                if (focus.kind === "alphaBtn") {
                    setAlphaModalOpen(true);
                    return;
                }
                if (focus.kind === "search") {
                    setKeyboardOpen(true);
                    setFocus({ kind: "keyboard" });
                    return;
                }
                return;
            }
            setFocus((f) =>
                moveControls(
                    f,
                    k,
                    sections,
                    keyboardOpen,
                    {
                        // ArrowDown from search returns to whichever
                        // content pane the kid was last in. Grid wins
                        // even when the keyboard is open if they were
                        // in the grid most recently. Falls back to
                        // keyboard (when open) or grid (when closed).
                        lastContentPane: lastContentPaneRef.current,
                        lastGridFocus: lastGridFocusRef.current,
                    },
                ),
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
        keyboardOpen,
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
            !alphaModalOpen &&
            // Only block long-press Enter when the keyboard owns
            // input. With focus in the grid (keyboard open as a
            // sibling pane), Enter on a tile should still navigate.
            focus.kind !== "keyboard",
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

    useProgressiveBack(
        useCallback(() => {
            // Keyboard registers its own back handler on top of the
            // useProgressiveBack stack when open AND focused. When the
            // keyboard is open but unfocused (the kid arrowed into the
            // grid), the keyboard's own handler returns false and we
            // fall through here. Back from the grid in that state
            // moves focus to the search input rather than closing the
            // keyboard - the kid can keep typing without re-popping it.
            //
            // Back from the grid is "I'm done with this list, take me
            // home" - reset the position memory so a follow-up
            // ArrowDown lands on the first tile rather than restoring
            // the buried cell the kid just walked away from. UP-then-
            // DOWN is the gesture that restores; BACK-then-DOWN starts
            // fresh.
            if (keyboardOpen && focus.kind !== "keyboard") {
                // Back from the grid (keyboard open as a sibling
                // pane). Keep the "last pane was the grid" flag so a
                // follow-up ArrowDown re-engages the grid rather than
                // re-popping the keyboard the kid just walked away
                // from, but reset the cell so we land on (0, 0)
                // instead of restoring the buried tile. Back from a
                // chrome control (filter / sort / alpha) leaves the
                // memory alone - the kid wasn't in the grid; clearing
                // would surprise their next ArrowDown.
                if (focus.kind === "grid") {
                    lastGridFocusRef.current = { section: 0, item: 0 };
                    lastContentPaneRef.current = "grid";
                }
                setFocus({ kind: "search" });
                return true;
            }
            // Belt-and-suspenders: if the keyboard's own back fired
            // and somehow returned false while focused (race between
            // setKeyboardOpen(true) and the child's effect-time push),
            // close the keyboard from here. Reset the keyboard
            // position too so the next open lands on "A".
            if (keyboardOpen) {
                lastKeyboardPosRef.current = { row: 1, col: 1 };
                lastContentPaneRef.current = null;
                setKeyboardOpen(false);
                setFocus({ kind: "search" });
                return true;
            }
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
            // Hand off to useHomeTabFocus for the load-bearing reset
            // (setTabFocused + setFocus(search) in a single render).
            // See web/kids/CLAUDE.md ("Back-then-Down focus contract").
            return handleBack();
        }, [
            keyboardOpen,
            focus,
            override,
            alphaModalOpen,
            filterOpen,
            sortOpen,
            setFocus,
            handleBack,
        ]),
    );

    // When the keyboard opens or closes the page reflows (controls +
    // grid get pushed into the right half). Fire a synthetic resize
    // so TileGrid's useGridColumns picks up the new computed
    // grid-template-columns track count instead of staying stuck on
    // the pre-toggle value.
    useEffect(() => {
        // requestAnimationFrame so the class transition + reflow
        // settle before useGridColumns reads computed style.
        const id = requestAnimationFrame(() => {
            window.dispatchEvent(new Event("resize"));
        });
        return () => cancelAnimationFrame(id);
    }, [keyboardOpen]);

    if (admin === undefined) return <div className="screen">Loading...</div>;

    return (
        <div className={`library ${keyboardOpen ? "keyboard-open" : ""}`}>
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
                    onClick={() => {
                        setKeyboardOpen(true);
                        setFocus({ kind: "keyboard" });
                    }}
                >
                    <input
                        ref={searchInputRef}
                        type="search"
                        className="library-search"
                        placeholder="Search"
                        value={searchInput}
                        // Keyboard owns the value while open; in normal
                        // pointer-driven flow (admin preview in a desktop
                        // browser) the click on the wrap pops the
                        // keyboard up too. The native onChange path is
                        // a fallback for accessibility tooling that
                        // injects characters directly.
                        onChange={(e) => setSearchInput(e.target.value)}
                        onClick={(e) => {
                            e.stopPropagation();
                            setKeyboardOpen(true);
                            setFocus({ kind: "keyboard" });
                        }}
                        readOnly={keyboardOpen}
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

            {(error || loadMoreError) && (
                <p className="error">{error ?? loadMoreError}</p>
            )}
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
                    onExitLeft={onGridExitLeft}
                    enabled={
                        !override &&
                        !filterOpen &&
                        !sortOpen &&
                        !alphaModalOpen
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
            {keyboardOpen && (
                <Keyboard
                    value={searchInput}
                    onChange={(v) => setSearchInput(v)}
                    onSubmit={(_v) => {
                        setKeyboardOpen(false);
                        // After "Done" the search results become the
                        // primary thing to interact with - drop focus
                        // straight onto the first grid tile when one
                        // exists, otherwise fall back to the search
                        // input so the kid isn't stranded with nothing
                        // focused.
                        if (
                            sections.length > 0 &&
                            sections[0].items.length > 0
                        ) {
                            setFocus({
                                kind: "grid",
                                section: 0,
                                item: 0,
                            });
                        } else {
                            setFocus({ kind: "search" });
                        }
                    }}
                    onClose={() => {
                        // Back from the keyboard while focused on it.
                        // Treat as "I'm done typing, take me up" -
                        // reset the cell memory so a re-open lands on
                        // "A" rather than the cell the kid backed
                        // out of. UP from the top row preserves the
                        // memory (handled by onExitUp); BACK does not.
                        lastKeyboardPosRef.current = { row: 1, col: 1 };
                        lastContentPaneRef.current = null;
                        setKeyboardOpen(false);
                        setFocus({ kind: "search" });
                    }}
                    focused={focus.kind === "keyboard"}
                    initialPos={lastKeyboardPosRef.current}
                    onPosChange={(p) => {
                        lastKeyboardPosRef.current = p;
                    }}
                    onExitRight={() => {
                        // ArrowRight off the keyboard's rightmost
                        // column hands focus into the grid at the
                        // last-remembered cell (defaulting to (0, 0)
                        // on first crossover). When the grid is empty
                        // (no results for the current search), there's
                        // nothing to focus - stay put. The keyboard's
                        // own listener is gated on `focused`, so once
                        // focus.kind flips out of "keyboard" we stop
                        // intercepting.
                        if (sections.length === 0) return;
                        if (sections[0].items.length === 0) return;
                        const m = lastGridFocusRef.current;
                        const sec = sections[m.section];
                        const valid = sec && m.item < sec.items.length;
                        setFocus({
                            kind: "grid",
                            section: valid ? m.section : 0,
                            item: valid ? m.item : 0,
                        });
                    }}
                    onExitUp={() => {
                        // ArrowUp from the keyboard's top row hands
                        // focus back to the search input above. The
                        // keyboard stays open; ArrowDown from search
                        // re-engages it.
                        setFocus({ kind: "search" });
                    }}
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

type PositionMemory = {
    /** null means "the kid hasn't visited a content pane yet this
     *  session." ArrowDown from search then falls back to keyboard
     *  (when open) or first grid cell. */
    lastContentPane: "grid" | "keyboard" | null;
    lastGridFocus: { section: number; item: number };
};

// moveControls handles arrow nav within the controls row only. Down
// from search hands off to the pane the kid was last in (grid or
// keyboard), at the position they last had focused there. When there
// is no history yet, default to keyboard when it's open (sits directly
// below the controls row) and to the first grid cell otherwise. Down
// from filter/sort/jump still goes to the grid - the keyboard isn't
// to their visual left, so steering them into it would feel
// arbitrary. Up off the row + Enter/Space activation are handled by
// the page's keydown listener separately.
function moveControls(
    f: Focus,
    key: string,
    sections: GridSection<LibraryItem>[],
    keyboardOpen: boolean,
    mem: PositionMemory,
): Focus {
    // Build the "first grid" / "remembered grid" candidate, clamped
    // against the current sections shape so a stale memory from a
    // previous filter/sort doesn't overshoot.
    const rememberedGrid = ((): Focus | null => {
        if (sections.length === 0) return null;
        const m = mem.lastGridFocus;
        const sec = sections[m.section];
        if (sec && m.item < sec.items.length) {
            return { kind: "grid", section: m.section, item: m.item };
        }
        if (sections[0].items.length === 0) return null;
        return { kind: "grid", section: 0, item: 0 };
    })();
    switch (f.kind) {
        case "search":
            if (key === "ArrowLeft") return f;
            if (key === "ArrowRight") return { kind: "filter" };
            if (key === "ArrowDown") {
                // Return to the pane the kid was last in. The
                // keyboard's own internal `pos` state is preserved
                // while it stays mounted, so just flipping focus.kind
                // back to "keyboard" lands them on the same cell they
                // left. Grid restoration goes through rememberedGrid.
                //
                // When there's no history yet (mem.lastContentPane is
                // null), prefer the keyboard if it's open since it
                // sits directly below the controls row; fall back to
                // the first grid cell otherwise.
                if (mem.lastContentPane === "grid" && rememberedGrid) {
                    return rememberedGrid;
                }
                if (mem.lastContentPane === "keyboard" && keyboardOpen) {
                    return { kind: "keyboard" };
                }
                if (keyboardOpen) return { kind: "keyboard" };
                return rememberedGrid ?? f;
            }
            return f;
        case "filter":
            if (key === "ArrowLeft") return { kind: "search" };
            if (key === "ArrowRight") return { kind: "sort" };
            if (key === "ArrowDown") return rememberedGrid ?? f;
            return f;
        case "sort":
            if (key === "ArrowLeft") return { kind: "filter" };
            if (key === "ArrowRight") return { kind: "alphaBtn" };
            if (key === "ArrowDown") return rememberedGrid ?? f;
            return f;
        case "alphaBtn":
            if (key === "ArrowLeft") return { kind: "sort" };
            if (key === "ArrowDown") return rememberedGrid ?? f;
            return f;
        case "grid":
            // grid arrows are owned by TileGrid; this case never
            // fires in practice (the page-level handler skips when
            // grid focus is active).
            return f;
        case "keyboard":
            // Keyboard arrows are owned by Keyboard.tsx's window
            // listener; this case never fires in practice (the page-
            // level handler skips when keyboard focus is active).
            return f;
    }
}
