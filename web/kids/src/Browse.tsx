import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUUpLeft, Plus } from "@phosphor-icons/react";
import type { BrowseResponse, BrowseRow } from "jellybean-shared";
import {
    authHeaders,
    clearSession,
    getSession,
    withAuthRetry,
    type Session,
} from "./auth";
import { TAG_ICONS, isTagIconName } from "jellybean-shared";
import OverrideModal, { useLongPressEnter } from "./OverrideModal";
import { useItemHiddenEvent } from "./itemHidden";
import Tile from "./Tile";
import { useBrowseRowAnimator } from "./useBrowseRowAnimator";
import { useProgressiveBack } from "./useProgressiveBack";
import { useKidsHome } from "./KidsHome";
import { useKidsResource } from "./useKidsResource";
import { sessionCache } from "./kidsCache";

// Browse is the kid home (M8 #48). Renders a vertical stack of
// horizontally-scrolling rows from /api/kids/browse. Each row's
// items go to the player on click; D-pad navigation keeps focus
// on a sensible row + column when moving between rows.
//
// The Library tab still exists at /library; the tab pill at the
// top of both pages toggles between them.

// BrowseItem / BrowseRow / BrowseResponse: shared with admin's
// layout-preview consumer + the server wire format.

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
// We intentionally skip the background revalidation here because the
// browse layout includes random_unwatched / tag_fanout rows whose
// order is server-side cached for ~60min, but the client cache and
// server cache aren't perfectly in sync - a refetch can shuffle items
// the kid was already looking at. The menu's "Refresh from server"
// action clears the cache and reloads when fresh data is wanted.
const CACHE_KEY_PREFIX = "jellybean.kids.browse.cache.";
function browseCacheKey(profileId: string | null): string {
    return CACHE_KEY_PREFIX + (profileId ?? "kid");
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
    // Local copy so item-hidden + load-more can splice rows without
    // poking through the hook's state. Initial value mirrors the
    // hook's first emission (cache hit lands synchronously via
    // sessionStorage).
    const [data, setData] = useState<BrowseResponse | null>(fetchedData);
    useEffect(() => {
        if (fetchedData) setData(fetchedData);
    }, [fetchedData]);
    // Default focus is (0, 0). The back-from-watch effect below
    // overrides this when EXPECT_BACK_KEY is set; otherwise the
    // kid arrives with focus on the tab nav (tabFocused=true),
    // and pressing Down lands them on row 0 col 0 - a clean
    // entry point regardless of where they last played.
    const [focus, setFocus] = useState<Focus>({
        kind: "tile",
        row: 0,
        col: 0,
    });
    const tileRefs = useRef<Record<string, HTMLElement | null>>({});
    // Layout context: tab focus + menu opening live in KidsHome.
    const homeCtx = useKidsHome();
    const { tabFocused, setTabFocused } = homeCtx;
    // Vertical scroll for Browse is implemented as a transform on
    // .browse-stack rather than a real window scroll. window.scrollTo
    // on this WebView triggered a multi-second freeze per write;
    // translate3d on a paint-contained child stays GPU-only.
    const stackRef = useRef<HTMLDivElement | null>(null);
    const stackYRef = useRef(0);
    const stackTargetYRef = useRef(0);
    const stackRafRef = useRef<number | null>(null);
    // Image-priority latch: once a row has been within the priority
    // window, it stays priority=true for the rest of the Browse
    // session. Without this, every cross-row press evicts a row's
    // images from rendering and re-decodes them on the next visit.
    const warmRowsRef = useRef<Set<number>>(new Set());
    // Active priority radius. Starts at 2 (focused row + 2 in each
    // direction = ~5 rows loaded eagerly so the kid pre-loads
    // neighbors before arrowing into them) and progressively
    // expands while the page sits idle. After ~30s the whole
    // library is warm.
    const [warmRadius, setWarmRadius] = useState(2);
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
    // Tracks rows that are currently loading more items so a rapid
    // double-Enter on the terminal button doesn't fire two parallel
    // fetches.
    const [loadingMore, setLoadingMore] = useState<Set<number>>(new Set());

    // Parent hid an item: drop it from every row in-place + rewrite
    // the sessionStorage cache so a fresh mount doesn't resurrect it.
    // Surgical splice is important here because rows include
    // randomized layouts (random_unwatched, tag_fanout) that would
    // re-shuffle on a full refetch - the kid would see the entire
    // browse layout reorder for one hide. We keep row positions
    // stable and just remove the dead tile.
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

    // Long-press Enter (D-pad center) on a focused content tile
    // opens the override modal. Short-press Enter plays the tile.
    // The hook intercepts Enter via capture-phase listeners with
    // preventDefault, so the page's onKey handler below sees no
    // Enter events while the kid is on a content tile - the hook
    // handles both cases (synthesizing the play action via
    // onShortPress when keyup arrives before the timer).
    //
    // Gated on:
    //   - focusedItem exists (kid is on a content tile, not the
    //     terminal load-more button)
    //   - session present (admin preview can't override - server
    //     returns 403 anyway, no need to surface the modal)
    //   - override modal not already open
    //   - tab nav doesn't have focus (TabPill's own Enter-hold
    //     gesture takes precedence there)
    const focusedItem = !tabFocused && data
        ? data.rows[focus.row]?.items[focus.col]
        : undefined;
    const handleShortPress = useCallback(() => {
        if (!data) return;
        const row = data.rows[focus.row];
        if (!row) return;
        const item = row.items[focus.col];
        if (!item) return;
        rememberLastFocused(item.Id);
        nav(`/watch/${encodeURIComponent(item.Id)}${location.search}`);
    }, [data, focus, nav]);
    const handleLongPress = useCallback(() => {
        if (!focusedItem) return;
        const pct = focusedItem.UserData?.PlayedPercentage ?? 0;
        setOverride({
            itemId: focusedItem.Id,
            itemName: focusedItem.Name,
            itemType: focusedItem.Type,
            played: pct >= 90,
            // Browse rows surface Movies and Series tiles; episodes
            // / seasons aren't currently long-press surfaces. When
            // they become one, the slim browseItem on the server
            // also needs SeriesId / SeriesName fields here.
        });
    }, [focusedItem]);
    useLongPressEnter({
        enabled:
            !!focusedItem && !!session && override === null && !tabFocused,
        onShortPress: handleShortPress,
        onLongPress: handleLongPress,
    });

    // Auth gate (mirrors Library's behavior). Without a session and
    // without an admin ?profileId, kick to /login.
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // KidsHome owns setHomeTab() and the body.kids-scroll-active class, so
    // Browse no longer touches either - just renders content.

    // Progressive image warm-up. Every 1.5s the active priority
    // radius grows by 1, so rows further from focus start loading
    // their images. After ~30s the whole library is warm and the
    // kid never sees a placeholder. Decode load is spread out:
    // initial mount loads ~5 rows of images (~105 images), and
    // then one row's worth (~21 images) per 1.5s tick. This keeps
    // the WebView's raster pipeline from getting flooded the way
    // loading="eager" did. Stops once we've reached the row count.
    useEffect(() => {
        if (!data) return;
        const total = data.rows.length;
        const id = setInterval(() => {
            setWarmRadius((r) => {
                const next = r + 1;
                if (next >= total) {
                    clearInterval(id);
                    return total;
                }
                return next;
            });
        }, 1500);
        return () => clearInterval(id);
    }, [data]);


    // Tell main.tsx's splash gate we've got real content rendered.
    // Fires once when data first arrives (cache-primed or fresh
    // fetch). Re-renders after that no-op since we don't dispatch
    // again. main.tsx's listener self-removes on first event.
    useEffect(() => {
        if (data && data.rows.length > 0) {
            window.dispatchEvent(new Event("jellybean:ready"));
        }
    }, [data]);

    // Back-from-watch focus restoration. Gated on EXPECT_BACK_KEY -
    // we only auto-focus a tile when the kid just navigated TO
    // /watch from /browse (which sets the flag). Plain arrivals
    // from /library / /tags / app-load don't trip this; the kid
    // sees the layout's default tab focus.
    //
    // Plus a data-replacement-resilient resolve: focusedItemIdRef
    // tracks WHICH item the kid is on. When fresh data lands and
    // the item has moved to a different (row, col), we re-resolve
    // and update focus indices. Otherwise the visual focus would
    // stay on the OLD index, which now points to a different item
    // in the new layout (the "Peter Pan replacement" symptom).
    const didFocusBackOnceRef = useRef(false);
    const focusedItemIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!data || data.rows.length === 0) return;
        // Re-resolve the tracked item id in the new data on every
        // data update (covers cache->fresh swap + load-more).
        if (focusedItemIdRef.current) {
            const id = focusedItemIdRef.current;
            for (let r = 0; r < data.rows.length; r++) {
                const c = data.rows[r].items.findIndex((it) => it.Id === id);
                if (c >= 0) {
                    setFocus((prev) =>
                        prev.row === r && prev.col === c
                            ? prev
                            : { kind: "tile", row: r, col: c },
                    );
                    return;
                }
            }
            // Item not found in new data; drop tracking.
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
        // Consume the flag regardless of whether we found the item -
        // if it's not in the loaded data, the next mount shouldn't
        // accidentally retry. The kid lands on the tab nav.
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
                setFocus({ kind: "tile", row: r, col: c });
                setTabFocused(false);
                return;
            }
        }
    }, [data, setTabFocused]);

    // Track the currently-focused item id so the resolve effect
    // above can re-locate it when data changes. Updates whenever
    // focus moves to a new (row, col).
    useEffect(() => {
        if (!data) return;
        const item = data.rows[focus.row]?.items[focus.col];
        if (item) {
            focusedItemIdRef.current = item.Id;
        } else {
            focusedItemIdRef.current = null;
        }
    }, [focus, data]);

    // loadMoreForRow asks the server for more items for one row,
    // appends new (non-duplicate) items to the row's local state,
    // and updates hasMore. Called when the kid hits Enter on the
    // "Load more" terminal button. When the server says no more,
    // hasMore flips false and the terminal button switches to
    // "Loop back" on the next render.
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
                    const next = {
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
                    return next;
                });
            } catch (err) {
                // Silent failure for now: the terminal button stays
                // visible, kid can retry. Logged for diagnosis.
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
        [data, loadingMore, nav, session, adminProfileId],
    );

    function rememberLastFocused(itemId: string) {
        try {
            sessionStorage.setItem(
                LAST_FOCUSED_KEY,
                JSON.stringify({ itemId }),
            );
            // Flag we're about to leave for /watch; consumed on
            // the next Browse mount to gate auto-focus restoration.
            sessionStorage.setItem(EXPECT_BACK_KEY, "1");
        } catch {
            /* ignore */
        }
    }

    // Progressive Back: anywhere on the page collapses focus up to
    // the Browse pill in the top nav. From there, a second Back
    // falls through to the WebView and exits the kid app.
    // Stable ref to setStackY so the tabFocused effect below can
    // call it without becoming stale across renders. setStackY
    // closes over refs that mutate, so an old reference still
    // works correctly.
    const setStackYRef = useRef(setStackY);
    setStackYRef.current = setStackY;
    useProgressiveBack(
        useCallback(() => {
            if (override) {
                setOverride(null);
                return true;
            }
            if (!tabFocused) {
                setTabFocused(true);
                // Back resets the page to a "fresh" state: focus
                // collapses to (row 0, col 0), the per-row column
                // memory is wiped, and prevFocusRowRef is forgotten
                // so the next Down→tile snaps the stack to the top
                // without animating from the previous row's
                // position. Without this, pressing Down after Back
                // restored the kid to whatever tile they were on,
                // which contradicted the contract that Back means
                // "I'm done with this content area, take me to the
                // top of the page." See web/kids/CLAUDE.md
                // ("Back-then-Down focus contract") for the rule.
                setFocus({ kind: "tile", row: 0, col: 0 });
                rowColMemoryRef.current.clear();
                prevFocusRowRef.current = null;
                lastTileRef.current = { row: 0, col: 0 };
                return true;
            }
            return false;
        }, [tabFocused, setTabFocused, override]),
    );
    // Whenever tab focus engages (back press, mount, layout
    // re-route), scroll the stack back to the top and blur any
    // lingering DOM focus on a tile so its :focus state clears.
    // Without this, after Back the kid sees the tab pill marked
    // selected (Right/Left navigates) but the previously-focused
    // tile keeps its visual highlight, and the page stays at the
    // scrolled position. Snap (no animation) on Back so the kid
    // doesn't see the stack glide back when they explicitly
    // requested an exit.
    useEffect(() => {
        if (!tabFocused) return;
        setStackYRef.current(0, true);
        if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
        ) {
            document.activeElement.blur();
        }
    }, [tabFocused]);

    // D-pad / keyboard model (kept intentionally simple for v1):
    //   - tile + ArrowRight/Left: move within row
    //   - tile + ArrowDown: move to first col of next row (clamped)
    //   - tile + ArrowUp at row 0: jump to tab pill
    //   - tile + ArrowUp at row > 0: previous row, same col (clamped)
    //   - tab + ArrowDown: jump back to (lastRow, lastCol) tile
    //   - tile + Enter: play
    //
    // The handler attaches to window (not the page div) so it fires
    // even when DOM focus is on body - this happens during route
    // transitions and on cheap WebView builds where imperative
    // .focus() doesn't always take effect on the first try.
    const lastTileRef = useRef<{ row: number; col: number }>({ row: 0, col: 0 });
    // Per-row column memory: when the kid arrows down/up between
    // rows, restore the column they were last on for the destination
    // row instead of resetting to 0. So row 1 col 3 -> down to row 2
    // -> right to row 2 col 5 -> up returns to row 1 col 3.
    const rowColMemoryRef = useRef<Map<number, number>>(new Map());
    // Throttle for held-down arrow repeats. Manual taps go through
    // immediately; OS-synthesized e.repeat events get rate-limited so
    // the renderer + row animator have time to catch each step. At
    // ~90ms minimum interval the kid still scrolls fast (~11 Hz)
    // without state updates piling up faster than React can render.
    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    function onKey(e: KeyboardEvent) {
        if (!data) return;
        const rows = data.rows;
        if (rows.length === 0) return;
        // KidsHome's TabPill owns keyboard handling when tabFocused
        // is true. We early-return so listeners don't double-handle.
        if (tabFocused) return;
        // preventDefault for ANY arrow / Enter the page handles, even
        // if the move clamps at an edge. Otherwise the browser's
        // default arrow behavior scrolls the window.
        const isHandled =
            e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown" ||
            e.key === "Enter" ||
            e.key === " ";
        if (!isHandled) return;
        e.preventDefault();

        // Held-down repeat: drop events that arrive faster than
        // REPEAT_MIN_MS. Manual presses (e.repeat=false) reset the
        // window so the next held repeat doesn't suppress the very
        // next manual tap.
        if (e.repeat) {
            const now = performance.now();
            if (now - lastMoveRef.current < REPEAT_MIN_MS) return;
            lastMoveRef.current = now;
        } else {
            lastMoveRef.current = performance.now();
        }

        const key = e.key;

        // Enter / Space on content tiles is owned by useLongPressEnter
        // (capture-phase listener with preventDefault, so this code
        // never sees the keydown when on a content tile). Here we
        // only handle Enter on the TERMINAL tile at the end of a row
        // (load-more or loop-back to start) - the hook is disabled
        // for that case (focusedItem is undefined), so the event
        // bubbles through to us.
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

        // Arrows: functional setter so each press resolves against the
        // latest committed focus, not the closure-captured one.
        if (key === "ArrowUp" && focus.row === 0) {
            // Topmost row + Up: hand focus back to the tab nav.
            // Internal focus stays at this tile so a subsequent
            // Down from tab returns the kid to the same column.
            rowColMemoryRef.current.set(focus.row, focus.col);
            lastTileRef.current = { row: focus.row, col: focus.col };
            setTabFocused(true);
            return;
        }
        setFocus((prev) => {
            const row = rows[prev.row];
            if (!row) return prev;
            const lastCol = row.items.length;
            switch (key) {
                case "ArrowRight":
                    return prev.col < lastCol
                        ? { kind: "tile", row: prev.row, col: prev.col + 1 }
                        : prev;
                case "ArrowLeft":
                    return prev.col > 0
                        ? { kind: "tile", row: prev.row, col: prev.col - 1 }
                        : prev;
                case "ArrowDown":
                    if (prev.row < rows.length - 1) {
                        rowColMemoryRef.current.set(prev.row, prev.col);
                        const nextRow = prev.row + 1;
                        const remembered =
                            rowColMemoryRef.current.get(nextRow) ?? 0;
                        const nextLen = rows[nextRow].items.length;
                        const col = Math.min(
                            remembered,
                            Math.max(0, nextLen - 1),
                        );
                        return { kind: "tile", row: nextRow, col };
                    }
                    return prev;
                case "ArrowUp": {
                    rowColMemoryRef.current.set(prev.row, prev.col);
                    const prevRow = prev.row - 1;
                    const remembered =
                        rowColMemoryRef.current.get(prevRow) ?? 0;
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

    // Focus DOM management. Vertical positioning is a transform write
    // on .browse-stack (see setStackY below). Horizontal positioning
    // is owned by useBrowseRowAnimator inside <AnimatedRowTrack>:
    // focus.col updates the row's targetCol prop, the animator eases
    // its track toward that target on its own rAF loop.
    //
    // Cheap-WebView optimization: skip the vertical math when the
    // kid is moving WITHIN a row (focus.kind=tile, row unchanged).
    // getBoundingClientRect forces a synchronous layout pass on a
    // page with ~140 mounted tiles - same row → just imperative
    // .focus(), no rect read, no transform write.
    // applyStackY writes the visual state directly: stack transform
    // always; bg position only on fast devices. Slow devices keep
    // the bg static at the random per-session offset (the CSS
    // variable provides that, no inline override needed). Per-
    // frame bg writes - both background-position-y and
    // filter:hue-rotate - measurably re-paint the bg layer on the
    // kid TV's WebView and reintroduce sluggishness, so we leave
    // the bg alone there.
    function applyStackY(y: number) {
        const el = stackRef.current;
        if (el) {
            el.style.transform = `translate3d(0, ${y}px, 0)`;
        }
        // Drive the layout's TabPill slot with the same y so the
        // top nav scrolls in lockstep with the stack. Variable
        // defaults to 0 elsewhere, so Library/Tags ignore it.
        document.documentElement.style.setProperty(
            "--kids-scroll-y",
            `${y}px`,
        );
        if (document.body?.dataset.perf === "slow") return;
        // Drive the layout's bg layer (.kids-home-bg) by writing
        // --kids-bg-pos-y. KidsHome's per-tab offset is mirrored
        // on documentElement.dataset.kidsBgOffsetY so we can sum
        // it with the scroll y here. CSS uses --kids-bg-pos-y
        // when set, falling back to --kids-bg-offset-y otherwise
        // (Library/Tags don't write --kids-bg-pos-y so they get
        // the static per-tab offset).
        const baseOffset = Number(
            document.documentElement.dataset.kidsBgOffsetY ?? 0,
        );
        document.documentElement.style.setProperty(
            "--kids-bg-pos-y",
            `${baseOffset + y}px`,
        );
    }
    // Clear shared CSS variables on unmount so Library / Tags
    // start with the TabPill at top and the bg at the per-session
    // random offset (no Browse-applied scroll).
    useEffect(() => {
        return () => {
            document.documentElement.style.removeProperty("--kids-scroll-y");
            document.documentElement.style.removeProperty("--kids-bg-pos-y");
        };
    }, []);
    // setStackY animates from the current Y toward `y` via a rAF
    // loop (same observed-velocity-preserving pattern as
    // useBrowseRowAnimator). Pass snap=true to skip the animation
    // and write the target immediately (used on first paint so
    // back-navigation lands instantly on the previously-focused
    // tile rather than animating into place).
    //
    // Mid-flight retargeting is free: a second call while the loop
    // is running just updates stackTargetYRef and the next frame
    // eases toward the new target. Two rapid Down presses produce
    // continuous motion, no restart-from-zero per press.
    function setStackY(y: number, snap = false) {
        stackTargetYRef.current = y;
        if (snap) {
            if (stackRafRef.current !== null) {
                cancelAnimationFrame(stackRafRef.current);
                stackRafRef.current = null;
            }
            stackYRef.current = y;
            applyStackY(y);
            return;
        }
        // Already at target (within settle threshold) - skip the
        // wake-up to keep the loop idle.
        if (Math.abs(stackYRef.current - y) < 0.5) {
            stackYRef.current = y;
            applyStackY(y);
            return;
        }
        if (stackRafRef.current !== null) return;
        const step = () => {
            const target = stackTargetYRef.current;
            const current = stackYRef.current;
            const dist = target - current;
            if (Math.abs(dist) < 0.5) {
                stackYRef.current = target;
                applyStackY(target);
                stackRafRef.current = null;
                return;
            }
            // Two-zone curve (mirrors useStackScroll - keep both in
            // sync if you tune one). Close to target: smooth
            // single-row motion (linear cap on slow, exp ease on
            // fast). Far from target: linear step scaled by remaining
            // distance so a held-Down catches up quickly without
            // single-frame teleports.
            const NEAR = 300;
            const FLOOR_SLOW = 120;
            const FAR_CAP = 600;
            const FAR_SCALE = 0.5;
            const absDist = Math.abs(dist);
            const isSlow = document.body?.dataset.perf === "slow";
            let next: number;
            if (absDist > NEAR) {
                const stepPx = Math.min(FAR_CAP, absDist * FAR_SCALE);
                next = current + stepPx * Math.sign(dist);
            } else if (isSlow) {
                const move =
                    Math.min(absDist, FLOOR_SLOW) * Math.sign(dist);
                next = current + move;
            } else {
                next = current + dist * 0.22;
            }
            stackYRef.current = next;
            applyStackY(next);
            stackRafRef.current = requestAnimationFrame(step);
        };
        stackRafRef.current = requestAnimationFrame(step);
    }
    // Cancel the loop on unmount so we don't leak rAF callbacks.
    useEffect(() => {
        return () => {
            if (stackRafRef.current !== null) {
                cancelAnimationFrame(stackRafRef.current);
                stackRafRef.current = null;
            }
        };
    }, []);
    const didInitialFocusScroll = useRef(false);
    const prevFocusRowRef = useRef<number | null>(null);
    useEffect(() => {
        if (tabFocused) return;
        const el = tileRefs.current[`${focus.row}:${focus.col}`];
        if (!el) return;
        el.focus({ preventScroll: true });
        const isFirst = !didInitialFocusScroll.current;
        didInitialFocusScroll.current = true;
        const sameRow =
            !isFirst && prevFocusRowRef.current === focus.row;
        prevFocusRowRef.current = focus.row;
        if (sameRow) return;
        // Vertical target: row 0 pins stack to top; deeper rows
        // center the focused tile. First paint snaps (no animation)
        // so back-navigation with a primed cache lands instantly
        // on the previously-focused tile; subsequent moves animate.
        const pinToTop = focus.row === 0;
        if (pinToTop) {
            setStackY(0, isFirst);
        } else {
            // Center on the ROW's rect, not the tile's. The focused
            // tile has transform: scale(1.12), and reading
            // getBoundingClientRect on a transformed element can
            // return inconsistent values on this WebView. Rows
            // aren't transformed, so the row rect is stable. The
            // delta is relative to stackYRef.current (the
            // animator's CURRENT position, which is what the rect
            // reflects); applied on top gives the absolute target.
            const rowEl = el.closest(".browse-row") as HTMLElement | null;
            const target = rowEl ?? el;
            const rect = target.getBoundingClientRect();
            const rowCenter = rect.top + rect.height / 2;
            const delta = window.innerHeight / 2 - rowCenter;
            setStackY(stackYRef.current + delta, isFirst);
        }
    }, [focus, tabFocused]);

    // Window-level keyboard listener. Skip while an override modal
    // is open (the modal owns the keys via its own bubbled handler).
    // Listener also early-returns inside onKey when tabFocused so
    // the layout's TabPill can own those events.
    useEffect(() => {
        if (override) return;
        const handler = (e: KeyboardEvent) => onKey(e);
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
        // onKey closes over focus + data + tabFocused.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus, data, override, tabFocused]);

    // Row anchor for image-priority gating. We render every row's
    // DOM (no virtualization placeholder) so layout stays
    // consistent - virtualization with placeholders caused
    // centering drift when rows transitioned between placeholder
    // (~360px), intrinsic-size (~400px), and natural height
    // (~510px). The cost we were trying to avoid by virtualizing
    // (DOM size, paint, decode) is now handled by:
    //   - content-visibility: auto on .browse-row skips paint for
    //     off-viewport rows.
    //   - Tile.priority gates whether <img> tags render so off-
    //     window rows just have placeholder divs (no decode).
    //   - Tile is memoized so most rows skip render reconciliation.
    // anchorRowImmediate drives the priority window so visited
    // rows warm up immediately without a deferred-render lag.
    const anchorRowImmediate =
        focus.kind === "tile" ? focus.row : lastTileRef.current.row;

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
                <p>Loading…</p>
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


    return (
        <div className="browse">
            <div className="browse-stack" ref={stackRef}>
            {data.rows.map((row, rIdx) => {
                // Each row's targetCol drives useBrowseRowAnimator:
                // active row tracks the kid's focus.col, inactive rows
                // hold their remembered col (default 0) so they don't
                // drift when the kid arrows past. The animator on each
                // row owns its own translateX; React just sets the
                // target.
                const trackCol =
                    !tabFocused && focus.row === rIdx
                        ? focus.col
                        : (rowColMemoryRef.current.get(rIdx) ?? 0);
                // Image-load priority: render <img> for rows within
                // warmRadius of the focused row, plus any row
                // previously latched warm. Initial radius is 2 (so
                // tiles just past the visible viewport are pre-
                // loading before the kid arrows into them). The
                // radius grows by 1 every 1.5s while the page sits
                // idle, so eventually the whole library is warm.
                const inActiveWindow =
                    Math.abs(rIdx - anchorRowImmediate) <= warmRadius;
                if (inActiveWindow) warmRowsRef.current.add(rIdx);
                const rowImagePriority =
                    inActiveWindow || warmRowsRef.current.has(rIdx);
                return (
                    <section key={row.rowId} className="browse-row">
                        <h2 className="browse-row-title">
                            <RowIcon name={row.icon} />
                            {row.title}
                        </h2>
                        <div
                            className="browse-row-items"
                            role="list"
                            aria-label={row.title}
                        >
                            <AnimatedRowTrack targetCol={trackCol}>
                                {row.items.map((item, cIdx) => {
                                    const key = `${rIdx}:${cIdx}`;
                                    const focused =
                                        !tabFocused &&
                                        focus.row === rIdx &&
                                        focus.col === cIdx;
                                    return (
                                        <Tile
                                            key={item.Id}
                                            item={item}
                                            size="browse"
                                            focused={focused}
                                            showProgress
                                            priority={rowImagePriority}
                                            onClick={() => {
                                                rememberLastFocused(item.Id);
                                                nav(`/watch/${encodeURIComponent(item.Id)}${location.search}`);
                                            }}
                                            onFocus={() =>
                                                setFocus({ kind: "tile", row: rIdx, col: cIdx })
                                            }
                                            refCallback={(el) =>
                                                (tileRefs.current[key] = el)
                                            }
                                        />
                                    );
                                })}
                                <TerminalTile
                                    rowIdx={rIdx}
                                    col={row.items.length}
                                    focused={
                                        !tabFocused &&
                                        focus.row === rIdx &&
                                        focus.col === row.items.length
                                    }
                                    hasMore={!!row.hasMore}
                                    loading={loadingMore.has(rIdx)}
                                    onClick={() => {
                                        if (row.hasMore) {
                                            void loadMoreForRow(rIdx);
                                        } else {
                                            setFocus({
                                                kind: "tile",
                                                row: rIdx,
                                                col: 0,
                                            });
                                        }
                                    }}
                                    onFocus={() =>
                                        setFocus({
                                            kind: "tile",
                                            row: rIdx,
                                            col: row.items.length,
                                        })
                                    }
                                    refCallback={(el) =>
                                        (tileRefs.current[
                                            `${rIdx}:${row.items.length}`
                                        ] = el)
                                    }
                                />
                            </AnimatedRowTrack>
                        </div>
                    </section>
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

// AnimatedRowTrack is the .browse-row-track div with an rAF-driven
// horizontal scroll animator attached. The wrapper exists so the
// hook can own a stable trackRef per row (React forbids hooks in
// loops, so the .map can't call useBrowseRowAnimator inline).
//
// Each row mounts one of these; React reuses the same component
// instance across re-renders thanks to the parent <section> being
// keyed by row.rowId. The hook's effect only re-runs when targetCol
// actually changes, so inactive rows are zero-cost across
// rapid-press flurries on the active row.
function AnimatedRowTrack({
    targetCol,
    children,
}: {
    targetCol: number;
    children: ReactNode;
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
// allow-list. Unknown names render as nothing - tolerates server
// drift (e.g. an admin set an icon that we later removed). The
// favorites row's "Heart" + every tag-set icon flows through here.
function RowIcon({ name }: { name?: string }) {
    if (!name || !isTagIconName(name)) return null;
    const Icon = TAG_ICONS[name];
    return <Icon weight="fill" className="browse-row-icon" aria-hidden />;
}

// TerminalTile is the focusable button rendered at the end of every
// browse row. Two modes:
//   - hasMore  -> "Load more" (Plus icon). Enter triggers a fetch
//                 that appends more items + flips hasMore to false
//                 if the server has nothing left.
//   - !hasMore -> "Loop back to start" (U-turn icon). Enter sends
//                 focus back to col 0 of the same row.
//
// Visually styled like a tile so it slots into the row track and
// gets the same focus zoom as content tiles - just with an icon +
// label instead of a poster.
type TerminalTileProps = {
    rowIdx: number;
    col: number;
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
