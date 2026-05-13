import {
    Fragment,
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUUpLeft, CaretUp, CaretDown, Plus } from "@phosphor-icons/react";
import type { BrowseResponse, BrowseRow } from "jellybean-shared";
import {
    authHeaders,
    clearSession,
    getSession,
    imageAuthSuffix,
    withAuthRetry,
    type Session,
} from "./auth";
import { TAG_ICONS, isTagIconName } from "jellybean-shared";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useItemHiddenEvent } from "./itemHidden";
import FocusedTileMetaCard, { useFocusedItemDetail } from "./BrowseHero";
import Tile from "./Tile";
import { useBrowseRowAnimator } from "./useBrowseRowAnimator";
import { useProgressiveBack } from "./useProgressiveBack";
import { useKidsHome } from "./KidsHome";
import { useKidsResource } from "./useKidsResource";
import { sessionCache } from "./kidsCache";
import { useHomeTabFocus } from "./useHomeTabFocus";
import { posterWidthForViewport } from "./perfMode";

// Browse is the kid home (M8 #48). t41 rewrite:
//
// Instead of mounting every row simultaneously and gating visibility
// via display:none + data-pos flips, we maintain a sliding window of
// at most 4 mounted rows (3 in steady state, +1 outgoing during a
// row-swap animation). Each visual role - hint-prev title, active
// row, hint-next title - is its OWN React component. Roles are not
// reassigned mid-animation by flipping a data attribute on a shared
// DOM element; instead the React tree mounts and unmounts the right
// per-role component as focus.row changes. The horizontal title
// flash that prompted the rewrite goes away because the active row's
// title is rendered by <ActiveRow> while the hint title is rendered
// by <HintRowTitle> - they are different DOM nodes with different
// visual languages.
//
// Animation: a wrapping <StackContainer> applies a translateY to
// the new tree equal to "+1 slot" at the moment focus.row changes,
// then transitions it back to 0. From the kid's perspective every
// mounted element slides in lockstep into its new slot.

type Focus = { kind: "tile"; row: number; col: number };

// sessionStorage key for the last activated tile (used to restore
// focus when the kid pops back from /watch or /play).
const LAST_FOCUSED_KEY = "jellybean.kids.browse.lastFocused";
// One-shot flag set right before nav to /watch and consumed on the
// next Browse mount. Without this, LAST_FOCUSED_KEY would keep
// auto-focusing a stale tile every time the kid arrived at /browse
// from anywhere (e.g., navigating from /library after a previous
// session). The flag scopes the auto-focus strictly to "kid just
// played something and is back".
const EXPECT_BACK_KEY = "jellybean.kids.browse.expectBack";

// sessionStorage cache for the most recent /api/kids/browse response.
// Keyed by profileId (admin preview varies; bearer-auth path uses "kid").
// On Back navigation from /watch or /play, react-router unmounts +
// remounts Browse, which would otherwise fire a fresh /browse fetch
// and show a 3-4s "Loading..." while the layout cache + Jellyfin
// hits resolve. With sessionStorage primed, the initial render uses
// the cached body and the user sees their previous state instantly.
const CACHE_KEY_PREFIX = "jellybean.kids.browse.cache.";
function browseCacheKey(profileId: string | null): string {
    return CACHE_KEY_PREFIX + (profileId ?? "kid");
}

// Slot names describe a row's vertical position relative to the
// active row. The StackContainer's children get a data-slot attr
// and CSS positions them absolutely from there. "far-prev" and
// "far-next" are used only briefly during a row swap to hold the
// outgoing row off-screen while the stack slides.
type SlotName = "far-prev" | "prev" | "active" | "next" | "far-next";

// Row swap animation timing - matches t39's curve so the slide feels
// substantial. Slow-perf devices snap to the new state.
const SWAP_DURATION_MS = 380;
const SWAP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// Per-row state that survives mount/unmount of a row's components.
// Indexed by rowKey so a row that becomes active again (e.g. after
// scrolling away and back) remembers where its track was positioned.
type RowState = {
    // Last focused column index within this row. Browse reads this on
    // ActiveRow mount to seed the horizontal track position.
    scrollColumn: number;
};

// rowKeyOf produces a unique stable identifier per resolved browse row.
//
// The server's `rowId` is the LayoutRow DB id - NOT unique for
// `tag_fanout` rows. One LayoutRow of type tag_fanout produces N
// ResolvedRows (one per tag) and the server emits all of them with the
// same `rowId`. Using `rowId` directly as a React key collapses every
// fanout child into a single reconciliation slot, so as the kid arrows
// through them React's diff fails to swap component types correctly
// and old rows pile up at the active slot (the "Dinosaursal" /
// "Mr. Rogers'-behind-Horton" bug). The wire field name is misleading
// but fixing it server-side would also need a load-more rewrite; for
// the hotfix we compute a unique key on the client. Tag titles are
// unique within a layout, so `${rowId}:${title}` is sufficient.
function rowKeyOf(row: BrowseRow): string {
    return `${row.rowId}:${row.title}`;
}

export default function Browse() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const adminProfileId = searchParams.get("profileId");
    const cacheKey = browseCacheKey(adminProfileId);
    const browseURL = useMemo(() => {
        if (!session && !adminProfileId) return null;
        const url = new URL("/api/kids/browse", window.location.origin);
        if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
        return url.toString();
    }, [session, adminProfileId]);
    const cache = useMemo(() => sessionCache<BrowseResponse>(), []);
    const { data: fetchedData, error } = useKidsResource<BrowseResponse>({
        url: browseURL,
        cache,
        cacheKey,
        skipFetchWhenCacheHit: true,
    });
    const [data, setData] = useState<BrowseResponse | null>(fetchedData);
    useEffect(() => {
        if (fetchedData) setData(fetchedData);
    }, [fetchedData]);

    const tileRefs = useRef<Record<string, HTMLElement | null>>({});
    const homeCtx = useKidsHome();
    const { setTabVisible } = homeCtx;

    // Per-row memory: last column the kid had focus on inside a row.
    // Survives unmount/remount of <ActiveRow> as the kid scrolls past.
    // Keyed by rowKey (see rowKeyOf) so tag_fanout rows that share
    // a server-side LayoutRow.ID don't collide their scroll columns.
    const rowStateRef = useRef<Map<string, RowState>>(new Map());
    function getRowState(rowKey: string): RowState {
        let s = rowStateRef.current.get(rowKey);
        if (!s) {
            s = { scrollColumn: 0 };
            rowStateRef.current.set(rowKey, s);
        }
        return s;
    }

    // One-shot flag: skip the next swap animation. Set by the
    // back-to-tab handler so a Back press from row N -> row 0 snaps
    // instead of animating a single-slot slide that visually lies
    // about the actual focus jump.
    const skipNextSwapRef = useRef(false);

    // Default focus is (0, 0). The back-from-watch effect below
    // overrides this when EXPECT_BACK_KEY is set; otherwise the
    // kid arrives with focus on the tab nav (tabFocused=true).
    const { focus, setFocus, tabFocused, setTabFocused, handleBack } = useHomeTabFocus<Focus>(
        {
            initialFocus: { kind: "tile", row: 0, col: 0 },
            getFirstContentSlot: () => ({ kind: "tile", row: 0, col: 0 }),
            onTabReset: () => {
                rowStateRef.current.clear();
                // Tell the animation useLayoutEffect to snap (not
                // animate) on the focus.row reset that handleBack
                // schedules in the same render. A single-slot slide
                // doesn't match a multi-row jump back to row 0.
                skipNextSwapRef.current = true;
            },
            scrollToTop: () => undefined,
            tabNav: { tabFocused: homeCtx.tabFocused, setTabFocused: homeCtx.setTabFocused },
        },
    );

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

    const [loadingMore, setLoadingMore] = useState<Set<number>>(new Set());

    // Per-row image-priority latch. Once a row's tiles have been
    // rendered with <img> they stay in the warm set so a future
    // re-mount of <ActiveRow> for the same row doesn't re-decode
    // images from cold. Image priority is independent of mount state
    // because the browser HTTP cache + decoded-image cache survive
    // unmount. Keyed by rowKey (see rowKeyOf).
    const warmRowsRef = useRef<Set<string>>(new Set());

    // Long-press Enter handling. Same shape as before the rewrite.
    const focusedItem = !tabFocused && data
        ? data.rows[focus.row]?.items[focus.col]
        : undefined;
    const focusedDetail = useFocusedItemDetail(
        focusedItem,
        !session,
        adminProfileId,
    );

    const handleShortPress = useCallback(() => {
        if (!data) return;
        const row = data.rows[focus.row];
        if (!row) return;
        const item = row.items[focus.col];
        if (!item) return;
        rememberLastFocused(item.Id);
        nav(`/play/${encodeURIComponent(item.Id)}${location.search}`);
    }, [data, focus, nav]);

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
            !!focusedItem && !!session && override === null && !tabFocused,
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

    // Auth gate.
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Parent hid an item: surgically splice it out + rewrite the cache.
    useItemHiddenEvent((hiddenId) => {
        setData((prev) => {
            if (!prev) return prev;
            const next: BrowseResponse = {
                ...prev,
                rows: prev.rows.map((row) => ({
                    ...row,
                    items: row.items.filter((it) => it.Id !== hiddenId),
                })),
            };
            cache.write(cacheKey, next);
            return next;
        });
    });

    // TabPill visibility: shown on row 0 or when tab nav has focus.
    useEffect(() => {
        const showPill = tabFocused || focus.row === 0;
        setTabVisible(showPill);
    }, [focus.row, tabFocused, setTabVisible]);

    // Bg-pos-y shift: the rainbow background re-anchors per active row
    // so the kid sees the painted texture shift as they scroll. Only
    // on fast devices; slow snaps. Preserved from t34.
    useEffect(() => {
        if (tabFocused) return;
        if (document.body?.dataset.perf === "slow") return;
        const baseOffset = Number(
            document.documentElement.dataset.kidsBgOffsetY ?? 0,
        );
        const ROW_BG_OFFSET = -560;
        const y = baseOffset + focus.row * ROW_BG_OFFSET;
        document.documentElement.style.setProperty(
            "--kids-bg-pos-y",
            `${y}px`,
        );
    }, [focus.row, tabFocused]);

    // Clear bg-pos-y on unmount so Library/Tags don't inherit a
    // Browse-applied scroll.
    useEffect(() => {
        return () => {
            document.documentElement.style.removeProperty("--kids-bg-pos-y");
        };
    }, []);

    // Ready signal for the splash gate.
    useEffect(() => {
        if (data && data.rows.length > 0) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [data]);

    // Back-from-watch focus restoration + item-id resilient resolve.
    const didFocusBackOnceRef = useRef(false);
    const focusedItemIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!data || data.rows.length === 0) return;
        if (focusedItemIdRef.current) {
            const id = focusedItemIdRef.current;
            for (let r = 0; r < data.rows.length; r++) {
                const c = data.rows[r].items.findIndex((it) => it.Id === id);
                if (c >= 0) {
                    setFocus((prev) => {
                        if (prev.row === r && prev.col === c) return prev;
                        // Data shuffled the tracked item to a new
                        // (row, col). Snap to it; the row-swap animator
                        // shouldn't animate a "jump" that wasn't kid-
                        // initiated.
                        if (prev.row !== r) skipNextSwapRef.current = true;
                        return { kind: "tile", row: r, col: c };
                    });
                    return;
                }
            }
            focusedItemIdRef.current = null;
            return;
        }
        if (didFocusBackOnceRef.current) return;
        let expecting = false;
        try {
            expecting = sessionStorage.getItem(EXPECT_BACK_KEY) === "1";
        } catch {
            /* ignore */
        }
        if (!expecting) return;
        let remembered: { itemId: string } | null = null;
        try {
            const raw = sessionStorage.getItem(LAST_FOCUSED_KEY);
            if (raw) remembered = JSON.parse(raw) as { itemId: string };
        } catch {
            /* ignore */
        }
        try {
            sessionStorage.removeItem(EXPECT_BACK_KEY);
        } catch {
            /* ignore */
        }
        if (!remembered?.itemId) return;
        for (let r = 0; r < data.rows.length; r++) {
            const c = data.rows[r].items.findIndex(
                (it) => it.Id === remembered!.itemId,
            );
            if (c >= 0) {
                didFocusBackOnceRef.current = true;
                focusedItemIdRef.current = remembered!.itemId;
                // Back-from-watch: snap straight to the remembered
                // tile. Animating a "jump" of multiple rows would
                // misrepresent it as a single-slot slide.
                if (r !== 0) skipNextSwapRef.current = true;
                setFocus({ kind: "tile", row: r, col: c });
                setTabFocused(false);
                return;
            }
        }
    }, [data, setTabFocused, setFocus]);

    // Track the focused item id for the resilient resolve effect.
    useEffect(() => {
        if (!data) return;
        const item = data.rows[focus.row]?.items[focus.col];
        focusedItemIdRef.current = item ? item.Id : null;
    }, [focus, data]);

    // Load-more handler.
    const loadMoreForRow = useCallback(
        async (rowIdx: number) => {
            if (loadingMore.has(rowIdx)) return;
            const row = data?.rows[rowIdx];
            if (!row) return;
            const targetLimit = row.items.length + 20;
            setLoadingMore((s) => new Set(s).add(rowIdx));
            try {
                const url = new URL(
                    `/api/kids/browse/row/${row.rowId}`,
                    window.location.origin,
                );
                url.searchParams.set("limit", String(targetLimit));
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
                    throw new Error(`load more: ${res.status}`);
                }
                const body = (await res.json()) as BrowseRow;
                setData((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        rows: prev.rows.map((r, i) =>
                            i === rowIdx
                                ? {
                                      ...r,
                                      items: body.items,
                                      hasMore: body.hasMore ?? false,
                                  }
                                : r,
                        ),
                    };
                });
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn("load more failed", err);
            } finally {
                setLoadingMore((s) => {
                    const next = new Set(s);
                    next.delete(rowIdx);
                    return next;
                });
            }
        },
        [data, loadingMore, nav, adminProfileId],
    );

    function rememberLastFocused(itemId: string) {
        try {
            sessionStorage.setItem(
                LAST_FOCUSED_KEY,
                JSON.stringify({ itemId }),
            );
            sessionStorage.setItem(EXPECT_BACK_KEY, "1");
        } catch {
            /* ignore */
        }
    }

    // Progressive Back: collapses focus up to the TabPill, then exits.
    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            return handleBack();
        }, [override, handleBack]),
    );

    // D-pad / keyboard handler.
    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    function onKey(e: KeyboardEvent) {
        if (!data) return;
        const rows = data.rows;
        if (rows.length === 0) return;
        if (tabFocused) return;
        const isHandled =
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown" ||
            e.key === "Enter" ||
            e.key === " ";
        if (!isHandled) return;
        e.preventDefault();
        if (e.repeat) {
            const now = performance.now();
            if (now - lastMoveRef.current < REPEAT_MIN_MS) return;
            lastMoveRef.current = now;
        } else {
            lastMoveRef.current = performance.now();
        }
        const key = e.key;

        // Enter on the terminal tile (the only Enter path the page
        // handles - content tiles are owned by useLongPressEnter).
        if (key === "Enter" || key === " ") {
            const row = rows[focus.row];
            if (!row) return;
            const lastCol = row.items.length;
            if (focus.col === lastCol) {
                if (row.hasMore) {
                    void loadMoreForRow(focus.row);
                } else {
                    setFocus({ kind: "tile", row: focus.row, col: 0 });
                }
            }
            return;
        }

        if (key === "ArrowUp" && focus.row === 0) {
            const rowKey = rowKeyOf(rows[focus.row]);
            getRowState(rowKey).scrollColumn = focus.col;
            setTabFocused(true);
            return;
        }

        setFocus((prev) => {
            const row = rows[prev.row];
            if (!row) return prev;
            const lastCol = row.items.length;
            const rowKey = rowKeyOf(row);
            switch (key) {
                case "ArrowRight": {
                    if (prev.col < lastCol) {
                        const nextCol = prev.col + 1;
                        getRowState(rowKey).scrollColumn = nextCol;
                        return { kind: "tile", row: prev.row, col: nextCol };
                    }
                    return prev;
                }
                case "ArrowLeft": {
                    if (prev.col > 0) {
                        const nextCol = prev.col - 1;
                        getRowState(rowKey).scrollColumn = nextCol;
                        return { kind: "tile", row: prev.row, col: nextCol };
                    }
                    return prev;
                }
                case "ArrowDown": {
                    if (prev.row < rows.length - 1) {
                        getRowState(rowKey).scrollColumn = prev.col;
                        const nextRow = prev.row + 1;
                        const nextRowKey = rowKeyOf(rows[nextRow]);
                        const remembered =
                            getRowState(nextRowKey).scrollColumn;
                        const nextLen = rows[nextRow].items.length;
                        const col = Math.min(
                            remembered,
                            Math.max(0, nextLen - 1),
                        );
                        return { kind: "tile", row: nextRow, col };
                    }
                    return prev;
                }
                case "ArrowUp": {
                    getRowState(rowKey).scrollColumn = prev.col;
                    const prevRow = prev.row - 1;
                    const prevRowKey = rowKeyOf(rows[prevRow]);
                    const remembered = getRowState(prevRowKey).scrollColumn;
                    const prevLen = rows[prevRow].items.length;
                    const col = Math.min(
                        remembered,
                        Math.max(0, prevLen - 1),
                    );
                    return { kind: "tile", row: prevRow, col };
                }
            }
            return prev;
        });
    }

    // Window keydown listener. Skipped while the override modal is up.
    useEffect(() => {
        if (override) return;
        const handler = (e: KeyboardEvent) => onKey(e);
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus, data, override, tabFocused]);

    // Imperative .focus() on the active row's focused tile any time
    // focus moves. Keeps DOM focus in sync with the React-tracked
    // index so screen readers + keyboard event targets are correct.
    useEffect(() => {
        if (tabFocused) return;
        const el = tileRefs.current[`${focus.row}:${focus.col}`];
        if (el) {
            el.focus({ preventScroll: true });
        }
    }, [focus, tabFocused]);

    // === Sliding-window animation state ===
    //
    // The visible tree is computed from focus.row. In steady state we
    // mount up to 3 components (prev / active / next). When focus.row
    // changes we also keep the OUTGOING row mounted briefly in the
    // appropriate far slot and slide the whole stack so the kid sees
    // continuous motion.
    //
    // animDir tracks which direction the most recent swap moved. While
    // it's "down" or "up" the outgoing row is mounted; when the
    // transition lands we reset it to null, which drops the outgoing
    // row from the render tree.
    type AnimDir = "up" | "down" | null;
    const [animDir, setAnimDir] = useState<AnimDir>(null);
    const prevFocusRowRef = useRef(focus.row);
    const stackRef = useRef<HTMLDivElement | null>(null);
    const swapTimerRef = useRef<number | null>(null);

    // Compute the visible row mountset whenever focus.row changes.
    // useLayoutEffect so the start-of-animation transform is applied
    // BEFORE the browser paints the new tree at its rest position.
    useLayoutEffect(() => {
        const prevRow = prevFocusRowRef.current;
        if (focus.row === prevRow) return;
        const dir: AnimDir = focus.row > prevRow ? "down" : "up";
        prevFocusRowRef.current = focus.row;

        const isSlow = document.body?.dataset.perf === "slow";
        const skipSwap = skipNextSwapRef.current;
        skipNextSwapRef.current = false;
        const el = stackRef.current;
        if (!el || isSlow || skipSwap) {
            // Snap: slow-perf, or the back-to-tab handler asked for a
            // hard reset, or no stack element yet (initial mount). No
            // translate, no transition.
            setAnimDir(null);
            return;
        }

        // Cancel any in-flight swap so back-to-back arrow presses don't
        // leave the stack mid-animation when the next press arrives.
        if (swapTimerRef.current !== null) {
            window.clearTimeout(swapTimerRef.current);
            swapTimerRef.current = null;
        }

        setAnimDir(dir);

        // Initial transform: snap the stack to the "old visual state."
        // For ArrowDown (focus moved from N to N+1) each role moved up
        // by one slot, so to make the kid see the OLD positions while
        // rendering the NEW tree we translate the stack DOWN by one
        // slot. Then on the next frame we transition the transform to
        // 0 and the kid sees everything slide UP into place.
        const slotShift = dir === "down" ? "var(--browse-slot-h)" : "calc(-1 * var(--browse-slot-h))";
        el.style.transition = "none";
        el.style.transform = `translate3d(0, ${slotShift}, 0)`;
        // Force a reflow so the browser commits the start-state before
        // we attach the transition. Reading offsetHeight is the
        // canonical reflow-flush trick.
        void el.offsetHeight;
        el.style.transition = `transform ${SWAP_DURATION_MS}ms ${SWAP_EASING}`;
        el.style.transform = "translate3d(0, 0, 0)";

        swapTimerRef.current = window.setTimeout(() => {
            // Settle: clear the transition + drop the outgoing row.
            const node = stackRef.current;
            if (node) {
                node.style.transition = "none";
                node.style.transform = "translate3d(0, 0, 0)";
            }
            setAnimDir(null);
            swapTimerRef.current = null;
        }, SWAP_DURATION_MS);
    }, [focus.row]);

    useEffect(() => {
        return () => {
            if (swapTimerRef.current !== null) {
                window.clearTimeout(swapTimerRef.current);
            }
        };
    }, []);

    if (error) {
        return (
            <div className="kids-page kids-error">
                <p className="error">{error}</p>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="kids-page kids-loading">
                <div
                    className="kids-loading-center"
                    role="status"
                    aria-live="polite"
                >
                    <div className="kids-loading-dots" aria-hidden>
                        <span />
                        <span />
                        <span />
                    </div>
                    <p className="kids-loading-label">Loading…</p>
                </div>
            </div>
        );
    }
    if (data.rows.length === 0) {
        return (
            <div className="kids-page kids-empty">
                <h1>Nothing to browse yet</h1>
                <p>Ask a grown-up to set up your shows.</p>
            </div>
        );
    }

    // === Sliding-window mountset ===
    //
    // In steady state mount {prev, active, next} (clamped to row
    // bounds). During a swap also mount the outgoing row in the
    // appropriate far slot so the kid sees it slide off-screen.
    const rows = data.rows;
    const activeIdx = focus.row;
    const mounts: Array<{ rowIndex: number; slot: SlotName }> = [];
    if (activeIdx - 1 >= 0) {
        mounts.push({ rowIndex: activeIdx - 1, slot: "prev" });
    }
    mounts.push({ rowIndex: activeIdx, slot: "active" });
    if (activeIdx + 1 < rows.length) {
        mounts.push({ rowIndex: activeIdx + 1, slot: "next" });
    }
    if (animDir === "down" && activeIdx - 2 >= 0) {
        // ArrowDown: the row that USED to be prev (activeIdx-2) is
        // now leaving off the top edge.
        mounts.push({ rowIndex: activeIdx - 2, slot: "far-prev" });
    }
    if (animDir === "up" && activeIdx + 2 < rows.length) {
        // ArrowUp: the row that USED to be next (activeIdx+2) is now
        // leaving off the bottom edge.
        mounts.push({ rowIndex: activeIdx + 2, slot: "far-next" });
    }

    return (
        <div className="browse">
            <div className="browse-stack" ref={stackRef}>
                {mounts.map(({ rowIndex, slot }) => {
                    const row = rows[rowIndex];
                    const rowKey = rowKeyOf(row);
                    if (slot === "active") {
                        return (
                            <ActiveRow
                                key={rowKey}
                                row={row}
                                rowKey={rowKey}
                                rowIndex={rowIndex}
                                focusCol={focus.col}
                                focusedItem={focusedItem}
                                focusedDetail={focusedDetail}
                                session={session}
                                tabFocused={tabFocused}
                                warmRowsRef={warmRowsRef}
                                rowState={getRowState(rowKey)}
                                setFocus={setFocus}
                                onPlay={(item) => {
                                    rememberLastFocused(item.Id);
                                    nav(
                                        `/play/${encodeURIComponent(item.Id)}${location.search}`,
                                    );
                                }}
                                onTerminal={() => {
                                    if (row.hasMore) {
                                        void loadMoreForRow(rowIndex);
                                    } else {
                                        setFocus({
                                            kind: "tile",
                                            row: rowIndex,
                                            col: 0,
                                        });
                                    }
                                }}
                                terminalLoading={loadingMore.has(rowIndex)}
                                registerTileRef={(col, el) => {
                                    tileRefs.current[`${rowIndex}:${col}`] = el;
                                }}
                            />
                        );
                    }
                    return (
                        <HintRowTitle
                            key={rowKey}
                            row={row}
                            rowKey={rowKey}
                            slot={slot}
                        />
                    );
                })}
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
        </div>
    );
}

// HintRowTitle renders just the row title + chevron in a slot above
// or below the active row. Horizontally centered (different language
// from the active row's cursor-anchored title). On mount it kicks off
// a side-effect that warms the row's first ~6 poster URLs via Image()
// so when the kid arrows into this row and it becomes ActiveRow, the
// posters are already in the HTTP cache.
function HintRowTitleImpl({
    row,
    rowKey,
    slot,
}: {
    row: BrowseRow;
    rowKey: string;
    slot: SlotName;
}) {
    // Image preload: warm the row's first ~6 poster URLs. These never
    // render to the DOM but the browser caches the responses for when
    // <ActiveRow> mounts <img> tags for this row.
    useEffect(() => {
        const width = posterWidthForViewport();
        const auth = imageAuthSuffix();
        const items = row.items.slice(0, 6);
        const imgs: HTMLImageElement[] = [];
        for (const item of items) {
            const tag = item.ImageTags?.Primary ?? "";
            if (!tag) continue;
            const src = `/api/kids/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=${width}&tag=${encodeURIComponent(tag)}${auth}`;
            const img = new Image();
            img.src = src;
            imgs.push(img);
        }
        return () => {
            // Cancel pending requests by clearing the src - browsers
            // generally abort the underlying request when the Image
            // object is GC'd, but explicitly clearing src is the
            // belt-and-suspenders move.
            for (const img of imgs) {
                img.src = "";
            }
        };
    }, [rowKey, row.items]);

    const isPrev = slot === "prev";
    const isFar = slot === "far-prev" || slot === "far-next";
    return (
        <section
            className="browse-hint"
            data-slot={slot}
            aria-hidden={isFar ? true : undefined}
        >
            <h2 className="browse-hint-title">
                {isPrev ? (
                    <CaretUp
                        weight="bold"
                        className="browse-hint-caret"
                        aria-hidden
                    />
                ) : (
                    <CaretDown
                        weight="bold"
                        className="browse-hint-caret"
                        aria-hidden
                    />
                )}
                <RowIcon name={row.icon} />
                {row.title}
            </h2>
        </section>
    );
}
const HintRowTitle = memo(HintRowTitleImpl);

// ActiveRow renders the focused row in the center slot. Owns the
// horizontal tile track + the focused tile combo + meta card + the
// terminal "load more" tile. Mounts/unmounts as focus.row changes;
// per-row scroll position is restored from the rowState ref so a
// row that's been visited before comes back to the column the kid
// was on.
type ActiveRowProps = {
    row: BrowseRow;
    rowKey: string;
    rowIndex: number;
    focusCol: number;
    focusedItem: BrowseRow["items"][number] | undefined;
    focusedDetail: ReturnType<typeof useFocusedItemDetail>;
    session: Session | null;
    tabFocused: boolean;
    warmRowsRef: React.MutableRefObject<Set<string>>;
    rowState: RowState;
    setFocus: (f: Focus) => void;
    onPlay: (item: BrowseRow["items"][number]) => void;
    onTerminal: () => void;
    terminalLoading: boolean;
    registerTileRef: (col: number, el: HTMLElement | null) => void;
};

function ActiveRow({
    row,
    rowKey,
    rowIndex,
    focusCol,
    focusedItem,
    focusedDetail,
    session,
    tabFocused,
    warmRowsRef,
    rowState,
    setFocus,
    onPlay,
    onTerminal,
    terminalLoading,
    registerTileRef,
}: ActiveRowProps) {
    // Persist the focused column for future remount. Effect (not
    // direct write) so the rowState ref is updated AFTER the render
    // commits - matches the "memory follows the user" semantics.
    useEffect(() => {
        rowState.scrollColumn = focusCol;
    }, [focusCol, rowState]);

    // Image priority latch: once the row has been ActiveRow it stays
    // warm so a future re-mount (after arrowing away and back) skips
    // the placeholder-then-image flash. Effect (not direct ref write)
    // so the mutation runs after commit, not during render.
    useEffect(() => {
        warmRowsRef.current.add(rowKey);
    }, [rowKey, warmRowsRef]);
    const priority = true; // ActiveRow is always priority warm.

    const lastCol = row.items.length;
    const focusedKey = !tabFocused ? focusCol : -1;

    return (
        <section className="browse-row" data-slot="active">
            <h2 className="browse-row-title">
                <RowIcon name={row.icon} />
                {row.title}
            </h2>
            <div className="browse-row-items" role="list" aria-label={row.title}>
                <AnimatedRowTrack targetCol={focusCol}>
                    {row.items.map((item, cIdx) => {
                        const focused = focusedKey === cIdx;
                        const showCombo = focused && focusedItem && focusedItem.Id === item.Id;
                        if (showCombo && focusedItem) {
                            return (
                                <div key={item.Id} className="focused-row-combo">
                                    <Tile
                                        item={item}
                                        size="browse"
                                        focused={focused}
                                        showProgress
                                        priority={priority}
                                        loading="eager"
                                        onClick={() => onPlay(item)}
                                        onFocus={() =>
                                            setFocus({
                                                kind: "tile",
                                                row: rowIndex,
                                                col: cIdx,
                                            })
                                        }
                                        refCallback={(el) =>
                                            registerTileRef(cIdx, el)
                                        }
                                    />
                                    <div
                                        key={focusedItem.Id}
                                        className="focused-meta-card-fade"
                                    >
                                        <FocusedTileMetaCard
                                            item={focusedItem}
                                            detail={focusedDetail}
                                            adminPreview={!session}
                                        />
                                    </div>
                                </div>
                            );
                        }
                        return (
                            <Fragment key={item.Id}>
                                <Tile
                                    item={item}
                                    size="browse"
                                    focused={focused}
                                    showProgress
                                    priority={priority}
                                    loading="eager"
                                    onClick={() => onPlay(item)}
                                    onFocus={() =>
                                        setFocus({
                                            kind: "tile",
                                            row: rowIndex,
                                            col: cIdx,
                                        })
                                    }
                                    refCallback={(el) =>
                                        registerTileRef(cIdx, el)
                                    }
                                />
                            </Fragment>
                        );
                    })}
                    <TerminalTile
                        focused={focusedKey === lastCol}
                        hasMore={!!row.hasMore}
                        loading={terminalLoading}
                        onClick={onTerminal}
                        onFocus={() =>
                            setFocus({
                                kind: "tile",
                                row: rowIndex,
                                col: lastCol,
                            })
                        }
                        refCallback={(el) => registerTileRef(lastCol, el)}
                    />
                </AnimatedRowTrack>
            </div>
        </section>
    );
}

// AnimatedRowTrack: thin wrapper that hangs useBrowseRowAnimator off a
// stable ref for the active row's horizontal track.
function AnimatedRowTrack({
    targetCol,
    children,
}: {
    targetCol: number;
    children: React.ReactNode;
}) {
    const ref = useRef<HTMLDivElement | null>(null);
    useBrowseRowAnimator(ref, targetCol);
    return (
        <div className="browse-row-track" ref={ref}>
            {children}
        </div>
    );
}

// RowIcon resolves a server-supplied icon name from the curated
// allow-list. Unknown names render as nothing.
function RowIcon({ name }: { name?: string }) {
    if (!name || !isTagIconName(name)) return null;
    const Icon = TAG_ICONS[name];
    return <Icon weight="fill" className="browse-row-icon" aria-hidden />;
}

// TerminalTile is the focusable button at the end of every row.
// "Load more" when hasMore; "Back to start" otherwise.
type TerminalTileProps = {
    focused: boolean;
    hasMore: boolean;
    loading: boolean;
    onClick: () => void;
    onFocus: () => void;
    refCallback: (el: HTMLButtonElement | null) => void;
};

function TerminalTile({
    focused,
    hasMore,
    loading,
    onClick,
    onFocus,
    refCallback,
}: TerminalTileProps) {
    const Icon = hasMore ? Plus : ArrowUUpLeft;
    const label = loading
        ? "Loading…"
        : hasMore
          ? "Load more"
          : "Back to start";
    return (
        <button
            ref={refCallback}
            type="button"
            className={`tile tile-browse tile-terminal ${focused ? "focused" : ""} ${hasMore ? "tile-terminal-load" : "tile-terminal-loop"}`}
            onClick={onClick}
            onFocus={onFocus}
            tabIndex={focused ? 0 : -1}
            disabled={loading}
        >
            <div className="tile-poster tile-terminal-face">
                <Icon weight="bold" aria-hidden className="tile-terminal-icon" />
                <span className="tile-terminal-label">{label}</span>
            </div>
        </button>
    );
}
