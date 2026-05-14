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

// Browse is the kid home (M8 #48). t41/t45/t46 rewrite:
//
// Instead of mounting every row simultaneously and gating visibility
// via display:none + data-pos flips, we maintain a sliding window of
// at most 4 mounted components (2 hint titles + 2 active rows during
// a swap, 3 in steady state). Each visual role - hint-prev title,
// active row, hint-next title - is its OWN React component. Roles
// are not reassigned mid-animation by flipping a data attribute on a
// shared DOM element; instead the React tree mounts and unmounts the
// right per-role component as focus.row changes. The horizontal
// title flash that prompted the rewrite goes away because the active
// row's title is rendered by <ActiveRow> while the hint title is
// rendered by <HintRowTitle> - they are different DOM nodes with
// different visual languages.
//
// Animation (t46): during a swap we mount up to 4 components at
// once - the leaving ActiveRow, the entering ActiveRow, plus one
// leaving HintRowTitle (the old prev for ArrowDown / old next for
// ArrowUp) and one entering HintRowTitle (the new next for ArrowDown
// / new prev for ArrowUp). Each gets a CSS keyframe that drives BOTH
// translateY and opacity end-to-end - the stack-level transform from
// t45 is gone because two concurrent transforms on the same elements
// (the stack's transition + each row's keyframe) were aborting the
// animation mid-flight in WebKit. Now every animating element owns
// its motion exclusively.
//
// Leaving rows snapshot their focused state (column + focusedItem +
// focusedDetail) at the moment of swap so the leaving row's focused
// tile keeps its combo styling (poster + meta card + ring) for the
// entire fade-out - otherwise it'd re-render unfocused on the same
// frame the swap starts.

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

// Row swap animation timing - matches the per-row keyframe durations
// in styles.css. The +50ms in the cleanup setTimeout below absorbs
// any animationend slop from WebKit so we don't tear down leaving
// components before their keyframes finish. Slow-perf devices snap.
const SWAP_DURATION_MS = 380;

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
    //
    // t48: focusedItem stays populated even when tabFocused is true,
    // so the focused-row-combo can keep rendering at its full size on
    // row 0 with just an opacity dim. Without this the combo would
    // unmount the moment focus moves to TabPill, and remount full-size
    // on ArrowDown - producing a visible "flash big" snap. Dimming is
    // a paint-only transition (compositor-friendly) so the layout
    // stays put.
    const focusedItem = data
        ? data.rows[focus.row]?.items[focus.col]
        : undefined;
    const focusedDetail = useFocusedItemDetail(
        focusedItem,
        !session,
        adminProfileId,
    );

    // Dimmed-combo state: tabFocused is only reachable from row 0, so
    // this is effectively "kid moved up off row 0 into TabPill." We
    // keep the combo mounted at full size with reduced opacity + no
    // focus ring; ArrowDown back from TabPill brightens it instantly.
    const dimmedCombo = tabFocused && focus.row === 0;

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
    // on fast devices; slow snaps.
    //
    // t47: this used to write `baseOffset + focus.row * ROW_BG_OFFSET`
    // into --kids-bg-pos-y and the CSS drove `background-position-y`
    // off it with a 380ms transition. That transition forced a
    // fullscreen repaint on the position:fixed .kids-home-bg every
    // frame (background-position changes can't be composited), which
    // produced ~140ms main-thread blocking spikes during the row swap
    // and read as "rows animate halfway, then snap to end" - the
    // M3-reported flash that survived t41/t45/t46. The fix below moves
    // the per-row shift onto a compositor-only transform (see styles.css
    // .kids-home-bg). --kids-bg-pos-y here is just the row delta now;
    // the per-tab random offset stays on background-position-y where
    // it doesn't animate.
    useEffect(() => {
        if (tabFocused) return;
        if (document.body?.dataset.perf === "slow") return;
        const ROW_BG_OFFSET = -560;
        const y = focus.row * ROW_BG_OFFSET;
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

    // === Row-swap animation state (t46) ===
    //
    // The visible tree is computed from focus.row. In steady state we
    // mount 3 components (prev hint / active / next hint, clamped).
    // When focus.row changes we ALSO mount:
    //   - the outgoing row as a second <ActiveRow> (leaving role)
    //   - the OLD prev hint (ArrowDown) or OLD next hint (ArrowUp) as
    //     a leaving HintRowTitle
    // and the NEW next hint (ArrowDown) or NEW prev hint (ArrowUp)
    // mounts as an entering HintRowTitle. All four animate via
    // per-role keyframes that drive both translateY AND opacity end
    // to end - no parent stack transform is involved, which is what
    // killed t45's animation mid-flight (two concurrent transforms
    // on the same DOM aborted the keyframe).
    //
    // swap stores enough info to render the leaving row + leaving
    // hint off the current data array (the row reference might
    // disappear after a hide event). Cleared by a setTimeout that
    // cancels itself on any new swap to avoid mid-animation leaks.
    // Snapshot leavingFocusedItem + leavingFocusedDetail so the
    // leaving ActiveRow keeps painting the focused-row-combo styling
    // for its full leaving lifecycle (problem #1).
    type SwapState = {
        leavingKey: string;
        leavingRow: BrowseRow;
        leavingFocusCol: number;
        leavingFocusedItem: BrowseRow["items"][number] | undefined;
        leavingHintRow: BrowseRow | null;
        leavingHintKey: string | null;
        enteringHintRow: BrowseRow | null;
        enteringHintKey: string | null;
        enteringKey: string;
        dir: "down" | "up";
    };
    const [swap, setSwap] = useState<SwapState | null>(null);
    const prevFocusRowRef = useRef(focus.row);
    const prevFocusColRef = useRef(focus.col);
    const stackRef = useRef<HTMLDivElement | null>(null);
    const swapTimerRef = useRef<number | null>(null);

    // Compute the swap state whenever focus.row changes.
    // useLayoutEffect so the leaving-row mount + CSS animation classes
    // are committed BEFORE the next paint - any frame gap would show a
    // visible "leaving row pops in then animates" flash.
    useLayoutEffect(() => {
        const prevRow = prevFocusRowRef.current;
        const prevCol = prevFocusColRef.current;
        prevFocusRowRef.current = focus.row;
        prevFocusColRef.current = focus.col;
        if (focus.row === prevRow) return;
        const dir: "down" | "up" = focus.row > prevRow ? "down" : "up";

        const isSlow = document.body?.dataset.perf === "slow";
        const skipSwap = skipNextSwapRef.current;
        skipNextSwapRef.current = false;
        const rowsNow = data?.rows;
        const leavingRow = rowsNow ? rowsNow[prevRow] : undefined;
        const enteringRow = rowsNow ? rowsNow[focus.row] : undefined;
        if (isSlow || skipSwap || !leavingRow || !enteringRow) {
            // Snap: slow-perf, or the back-to-tab handler asked for a
            // hard reset, or data shifted under us. Drop any in-flight
            // swap.
            if (swapTimerRef.current !== null) {
                window.clearTimeout(swapTimerRef.current);
                swapTimerRef.current = null;
            }
            setSwap(null);
            return;
        }

        // Cancel any in-flight swap so back-to-back arrow presses don't
        // leave a stale leaving-row mounted when the next press lands.
        if (swapTimerRef.current !== null) {
            window.clearTimeout(swapTimerRef.current);
            swapTimerRef.current = null;
        }

        // For ArrowDown the leaving hint is the OLD prev hint
        // (rows[prevRow-1]); the entering hint is the NEW next hint
        // (rows[focus.row+1]). For ArrowUp the leaving hint is the OLD
        // next hint (rows[prevRow+1]); the entering hint is the NEW
        // prev hint (rows[focus.row-1]). Either may not exist at
        // boundary rows - null means "no leaving/entering hint to
        // mount."
        const leavingHintRow =
            dir === "down"
                ? prevRow - 1 >= 0
                    ? rowsNow![prevRow - 1]
                    : null
                : prevRow + 1 < rowsNow!.length
                  ? rowsNow![prevRow + 1]
                  : null;
        const enteringHintRow =
            dir === "down"
                ? focus.row + 1 < rowsNow!.length
                    ? rowsNow![focus.row + 1]
                    : null
                : focus.row - 1 >= 0
                  ? rowsNow![focus.row - 1]
                  : null;

        // Snapshot the leaving row's focused item. focusedItem in this
        // render is already the ENTERING row's focused item (recomputed
        // when focus.row changed), so we derive the leaving focused
        // item from rowsNow[prevRow] + prevCol directly.
        const leavingFocusedItem = leavingRow.items[prevCol];

        setSwap({
            leavingKey: rowKeyOf(leavingRow),
            leavingRow,
            leavingFocusCol: prevCol,
            leavingFocusedItem,
            leavingHintRow,
            leavingHintKey: leavingHintRow ? rowKeyOf(leavingHintRow) : null,
            enteringHintRow,
            enteringHintKey: enteringHintRow ? rowKeyOf(enteringHintRow) : null,
            enteringKey: rowKeyOf(enteringRow),
            dir,
        });

        // Cleanup buffer: keyframe duration + a frame's worth of
        // safety margin so React doesn't tear down the leaving
        // components before their keyframes finish. The WebKit
        // animation engine occasionally fires the animationend event
        // a hair before the keyframe's stated end - the buffer keeps
        // the leaving classes attached until visual settle.
        swapTimerRef.current = window.setTimeout(() => {
            setSwap(null);
            swapTimerRef.current = null;
        }, SWAP_DURATION_MS + 50);
    }, [focus.row, focus.col, data]);

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
    // Steady state: {prev hint, active, next hint} clamped to bounds
    // (3 components max).
    //
    // During swap: ALSO mount the leaving ActiveRow + animate one
    // leaving hint title + one entering hint title. The new prev or
    // next hint whose row key matches the leaving ActiveRow's key is
    // intentionally skipped during the swap window - the leaving
    // ActiveRow's fade-out trajectory ends at the prev/next slot
    // visually so a separate hint title there would double-render the
    // same row. 4 components max during swap.
    const rows = data.rows;
    const activeIdx = focus.row;
    const enteringKey = rowKeyOf(rows[activeIdx]);

    // Steady-state prev/next hint rows (the entering ones during swap).
    const prevHintRow = activeIdx - 1 >= 0 ? rows[activeIdx - 1] : null;
    const nextHintRow = activeIdx + 1 < rows.length ? rows[activeIdx + 1] : null;

    type HintRole = "steady" | "leaving" | "entering";
    type Mount =
        | {
              kind: "hint";
              row: BrowseRow;
              rowKey: string;
              slot: "prev" | "next";
              role: HintRole;
          }
        | {
              kind: "active";
              row: BrowseRow;
              rowKey: string;
              rowIndex: number;
              role: "active" | "leaving";
          };
    const mounts: Mount[] = [];

    // Steady-state prev hint: mounted unless during swap it's the
    // same row as the leaving ActiveRow (ArrowDown case - the leaving
    // row's slide-and-fade trajectory ends visually at this slot).
    // During an ArrowUp swap the steady-state prev hint is the
    // ENTERING hint, and we tag it accordingly so the keyframe slides
    // it down + fades it in.
    if (prevHintRow) {
        const k = rowKeyOf(prevHintRow);
        const isLeavingRowSlot = swap && k === swap.leavingKey;
        if (!isLeavingRowSlot) {
            const role: HintRole =
                swap && swap.dir === "up" && swap.enteringHintKey === k
                    ? "entering"
                    : "steady";
            mounts.push({
                kind: "hint",
                row: prevHintRow,
                rowKey: k,
                slot: "prev",
                role,
            });
        }
    }
    mounts.push({
        kind: "active",
        row: rows[activeIdx],
        rowKey: enteringKey,
        rowIndex: activeIdx,
        role: "active",
    });
    if (nextHintRow) {
        const k = rowKeyOf(nextHintRow);
        const isLeavingRowSlot = swap && k === swap.leavingKey;
        if (!isLeavingRowSlot) {
            const role: HintRole =
                swap && swap.dir === "down" && swap.enteringHintKey === k
                    ? "entering"
                    : "steady";
            mounts.push({
                kind: "hint",
                row: nextHintRow,
                rowKey: k,
                slot: "next",
                role,
            });
        }
    }
    if (swap) {
        if (swap.leavingKey !== enteringKey) {
            // Leaving ActiveRow: starts at active slot, slides past
            // prev/next slot and fades out via per-row keyframe.
            mounts.push({
                kind: "active",
                row: swap.leavingRow,
                rowKey: swap.leavingKey,
                rowIndex: -1,
                role: "leaving",
            });
        }
        if (swap.leavingHintRow && swap.leavingHintKey) {
            // Leaving hint: the OLD prev hint (ArrowDown) or OLD next
            // hint (ArrowUp) that needs to slide further out of frame
            // before unmount.
            const slot: "prev" | "next" = swap.dir === "down" ? "prev" : "next";
            mounts.push({
                kind: "hint",
                row: swap.leavingHintRow,
                rowKey: swap.leavingHintKey,
                slot,
                role: "leaving",
            });
        }
    }

    return (
        <div className="browse">
            <div className="browse-stack" ref={stackRef}>
                {mounts.map((m) => {
                    if (m.kind === "hint") {
                        const isLeaving = m.role === "leaving";
                        const isEntering = m.role === "entering";
                        // Hint swap classes encode (role x direction).
                        // The CSS keyframes drive both translateY and
                        // opacity end to end.
                        let hintClass = "";
                        if (swap) {
                            if (isLeaving) {
                                hintClass =
                                    swap.dir === "down"
                                        ? "browse-hint-leaving-up"
                                        : "browse-hint-leaving-down";
                            } else if (isEntering) {
                                hintClass =
                                    swap.dir === "down"
                                        ? "browse-hint-entering-up"
                                        : "browse-hint-entering-down";
                            }
                        }
                        return (
                            <HintRowTitle
                                key={m.rowKey + (isLeaving ? ":leaving" : "")}
                                row={m.row}
                                rowKey={m.rowKey}
                                slot={m.slot}
                                hintClass={hintClass}
                            />
                        );
                    }
                    const isLeaving = m.role === "leaving";
                    const rowKey = m.rowKey;
                    const row = m.row;
                    const rowIndex = m.rowIndex;
                    const swapClass = swap
                        ? isLeaving
                            ? swap.dir === "down"
                                ? "browse-row-leaving-down"
                                : "browse-row-leaving-up"
                            : swap.dir === "down"
                                ? "browse-row-entering-down"
                                : "browse-row-entering-up"
                        : "";
                    // Leaving row: use the snapshot focused item from
                    // swap state. Detail is set to null because the
                    // detail hook reacts on the CURRENT focused item -
                    // we can't reconstruct the prior detail cheaply.
                    // The meta card renders its synchronous shell
                    // (title + year + runtime) without detail, which
                    // is sufficient for a 380ms fade-out.
                    const rowFocusedItem = isLeaving
                        ? swap!.leavingFocusedItem
                        : focusedItem;
                    const rowFocusedDetail = isLeaving ? null : focusedDetail;
                    // t48: dimmedCombo only applies to the entering
                    // (non-leaving) row 0. Leaving rows already snapshot
                    // their own focused-row-combo state at swap time and
                    // never coexist with TabPill focus (the keydown
                    // handler returns early when tabFocused), so they
                    // pass false.
                    const rowDimmed = !isLeaving && dimmedCombo && rowIndex === 0;
                    return (
                        <ActiveRow
                            key={rowKey + (isLeaving ? ":leaving" : "")}
                            row={row}
                            rowKey={rowKey}
                            rowIndex={isLeaving ? -1 : rowIndex}
                            focusCol={isLeaving ? swap!.leavingFocusCol : focus.col}
                            focusedItem={rowFocusedItem}
                            focusedDetail={rowFocusedDetail}
                            session={session}
                            tabFocused={tabFocused}
                            dimmedCombo={rowDimmed}
                            warmRowsRef={warmRowsRef}
                            rowState={getRowState(rowKey)}
                            setFocus={setFocus}
                            leaving={isLeaving}
                            swapClass={swapClass}
                            onPlay={(item) => {
                                if (isLeaving) return;
                                rememberLastFocused(item.Id);
                                nav(
                                    `/play/${encodeURIComponent(item.Id)}${location.search}`,
                                );
                            }}
                            onTerminal={() => {
                                if (isLeaving) return;
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
                            terminalLoading={
                                isLeaving ? false : loadingMore.has(rowIndex)
                            }
                            registerTileRef={(col, el) => {
                                if (isLeaving) return;
                                tileRefs.current[`${rowIndex}:${col}`] = el;
                            }}
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
    hintClass,
}: {
    row: BrowseRow;
    rowKey: string;
    slot: "prev" | "next";
    hintClass?: string;
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
    return (
        <section
            className={`browse-hint${hintClass ? ` ${hintClass}` : ""}`}
            data-slot={slot}
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
    /**
     * t48: render the focused-row-combo with a dimmed modifier class
     * instead of unmounting it when focus has moved up to TabPill.
     * Keeps the combo at full size so the return trip (ArrowDown from
     * TabPill) is a paint-only opacity transition with no layout snap.
     */
    dimmedCombo: boolean;
    warmRowsRef: React.MutableRefObject<Set<string>>;
    rowState: RowState;
    setFocus: (f: Focus) => void;
    onPlay: (item: BrowseRow["items"][number]) => void;
    onTerminal: () => void;
    terminalLoading: boolean;
    registerTileRef: (col: number, el: HTMLElement | null) => void;
    leaving?: boolean;
    swapClass?: string;
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
    dimmedCombo,
    warmRowsRef,
    rowState,
    setFocus,
    onPlay,
    onTerminal,
    terminalLoading,
    registerTileRef,
    leaving,
    swapClass,
}: ActiveRowProps) {
    // Persist the focused column for future remount. Effect (not
    // direct write) so the rowState ref is updated AFTER the render
    // commits - matches the "memory follows the user" semantics.
    // Skip for leaving rows: they're transient and shouldn't clobber
    // the rowState that the entering ActiveRow will read on mount.
    useEffect(() => {
        if (leaving) return;
        rowState.scrollColumn = focusCol;
    }, [focusCol, rowState, leaving]);

    // Image priority latch: once the row has been ActiveRow it stays
    // warm so a future re-mount (after arrowing away and back) skips
    // the placeholder-then-image flash. Effect (not direct ref write)
    // so the mutation runs after commit, not during render.
    useEffect(() => {
        warmRowsRef.current.add(rowKey);
    }, [rowKey, warmRowsRef]);
    const priority = true; // ActiveRow is always priority warm.

    const lastCol = row.items.length;
    // t46: leaving rows pass their SNAPSHOT focused item via
    // focusedItem prop so the focused-row-combo (poster + meta card +
    // ring) keeps painting for the full leaving lifecycle. Without
    // this snapshot the leaving row re-renders with focusedItem ==
    // entering row's item, mismatches every column, falls through to
    // the plain Tile branch, and the kid sees the focused tile snap
    // to an unfocused size while the row is still mid-fade.
    // focusedDetail is null for leaving rows because the detail hook
    // reacts on the CURRENT focused item; the meta card renders its
    // synchronous title+meta shell without detail, which is enough
    // for a sub-400ms fade-out.
    // t48: when dimmedCombo is true (kid moved up to TabPill while on
    // row 0), keep the combo hosting the tracked column at full size so
    // the return trip is opacity-only. The dimmed state suppresses the
    // ring + lowers opacity via the .focused-row-combo--dimmed modifier.
    const focusedKey = !tabFocused || dimmedCombo ? focusCol : -1;
    const comboClass = dimmedCombo
        ? "focused-row-combo focused-row-combo--dimmed"
        : "focused-row-combo";

    return (
        <section
            className={`browse-row${swapClass ? ` ${swapClass}` : ""}`}
            data-slot="active"
            aria-hidden={leaving ? true : undefined}
        >
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
                                <div key={item.Id} className={comboClass}>
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
