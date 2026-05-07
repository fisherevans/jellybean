import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowUUpLeft, Plus } from "@phosphor-icons/react";
import {
    authHeaders,
    clearSession,
    getSession,
    withAuthRetry,
    type Session,
} from "./auth";
import { TAG_ICONS, isTagIconName } from "./tagIcons";
import TabPill, { TAB_SLOT_COUNT, tabHref } from "./TabPill";
import OverrideModal, { useLongPressUp } from "./OverrideModal";
import MainMenuModal from "./MainMenuModal";
import { scrollWindowToCenter, scrollWindowToTop } from "./smoothScroll";
import Tile from "./Tile";
import { consumeTabFocus, flagTabFocus, setHomeTab } from "./kidNav";
import { useBrowseRowAnimator } from "./useBrowseRowAnimator";
import { useProgressiveBack } from "./useProgressiveBack";

// Browse is the kid home (M8 #48). Renders a vertical stack of
// horizontally-scrolling rows from /api/kids/browse. Each row's
// items go to the player on click; D-pad navigation keeps focus
// on a sensible row + column when moving between rows.
//
// The Library tab still exists at /library; the tab pill at the
// top of both pages toggles between them.

type BrowseItem = {
    Id: string;
    Name: string;
    Type: string;
    ImageTags?: { Primary?: string };
    UserData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
    };
};

type BrowseRow = {
    rowId: number;
    type: string;
    title: string;
    subtitle?: string;
    // Optional Phosphor icon name set by the server. "Heart" for the
    // favorites row; the tag's own icon for tag / tag_fanout rows
    // when configured. Empty/missing = no icon.
    icon?: string;
    // True when more items are available beyond what was returned.
    // Drives the terminal button: "Load more" (true) vs "Loop back
    // to start" (false). Set by random_unwatched + recently_added;
    // every other row type stays false.
    hasMore?: boolean;
    items: BrowseItem[];
};

type BrowseResponse = {
    layoutId: number;
    layoutName: string;
    profileId: number;
    rows: BrowseRow[];
};

type Focus =
    | { kind: "tab"; index: number }
    | { kind: "tile"; row: number; col: number };

// sessionStorage key for the last activated tile (used to restore
// focus when the kid pops back from /watch or /play).
const LAST_FOCUSED_KEY = "jellybean.kids.browse.lastFocused";

// sessionStorage cache for the most recent /api/kids/browse response.
// Keyed by profileId (admin preview varies; bearer-auth path uses "kid").
// On Back navigation from /watch or /play, react-router unmounts +
// remounts Browse, which would otherwise fire a fresh /browse fetch
// and show a 3-4s "Loading..." while the layout cache + Jellyfin
// hits resolve. With sessionStorage primed, the initial render uses
// the cached body and the user sees their previous state instantly;
// the network fetch still runs in the background and replaces if
// anything changed (stale-while-revalidate).
const CACHE_KEY_PREFIX = "jellybean.kids.browse.cache.";
function browseCacheKey(profileId: string | null): string {
    return CACHE_KEY_PREFIX + (profileId ?? "kid");
}
function readBrowseCache(profileId: string | null): BrowseResponse | null {
    try {
        const raw = sessionStorage.getItem(browseCacheKey(profileId));
        if (!raw) return null;
        return JSON.parse(raw) as BrowseResponse;
    } catch {
        return null;
    }
}
function writeBrowseCache(profileId: string | null, body: BrowseResponse) {
    try {
        sessionStorage.setItem(browseCacheKey(profileId), JSON.stringify(body));
    } catch {
        // Quota exceeded or storage disabled - ignore; the page still
        // renders fine without the cache, just with the loading flash.
    }
}

// findItemPosition returns the (row, col) of an item id in a browse
// response, or null when the item isn't in any row. Used to seed
// initial focus from cached data + LAST_FOCUSED_KEY.
function findItemPosition(
    data: BrowseResponse | null,
    itemId: string | null,
): { row: number; col: number } | null {
    if (!data || !itemId) return null;
    for (let r = 0; r < data.rows.length; r++) {
        const c = data.rows[r].items.findIndex((it) => it.Id === itemId);
        if (c >= 0) return { row: r, col: c };
    }
    return null;
}
function readLastFocusedId(): string | null {
    try {
        const raw = sessionStorage.getItem(LAST_FOCUSED_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { itemId?: string };
        return parsed.itemId ?? null;
    } catch {
        return null;
    }
}

export default function Browse() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const adminProfileId = searchParams.get("profileId");
    // Synchronously prime data + focus from sessionStorage so back-
    // navigation lands instantly on the same tile the kid was on,
    // without a loading flash or post-fetch focus animation.
    const [data, setData] = useState<BrowseResponse | null>(() =>
        readBrowseCache(adminProfileId),
    );
    const [error, setError] = useState<string | null>(null);
    const [focus, setFocus] = useState<Focus>(() => {
        const cached = readBrowseCache(adminProfileId);
        const pos = findItemPosition(cached, readLastFocusedId());
        if (pos) return { kind: "tile", row: pos.row, col: pos.col };
        return { kind: "tile", row: 0, col: 0 };
    });
    const tileRefs = useRef<Record<string, HTMLElement | null>>({});
    const [override, setOverride] = useState<
        { itemId: string; itemName: string } | null
    >(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // Tracks rows that are currently loading more items so a rapid
    // double-Enter on the terminal button doesn't fire two parallel
    // fetches.
    const [loadingMore, setLoadingMore] = useState<Set<number>>(new Set());

    // Long-press UP on a focused tile opens the override modal. The
    // hook is gated on having a focused tile + an active session
    // (admin preview can't override - server returns 403 anyway, no
    // need to surface the modal).
    const focusedItem =
        focus.kind === "tile" && data
            ? data.rows[focus.row]?.items[focus.col]
            : undefined;
    useLongPressUp(
        () => {
            if (!focusedItem || !session) return;
            setOverride({ itemId: focusedItem.Id, itemName: focusedItem.Name });
        },
        focus.kind === "tile" && !!session && override === null,
        600,
    );

    // Auth gate (mirrors Library's behavior). Without a session and
    // without an admin ?profileId, kick to /login.
    useEffect(() => {
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
        }
    }, [session, adminProfileId, nav]);

    // Stamp the kid's current home tab so /watch's Back knows where
    // to send them. See kidNav.ts.
    useEffect(() => {
        setHomeTab("browse");
    }, []);

    // Tab-arrow navigation from /library lands here with the
    // tabFocus flag set; consume on mount BEFORE the data-loaded
    // effect runs so focus pins to the tab pill from the very first
    // paint instead of flashing through a default tile focus.
    const initialFocusSetRef = useRef(false);
    useEffect(() => {
        const slot = consumeTabFocus();
        if (slot !== null) {
            setFocus({ kind: "tab", index: slot });
            initialFocusSetRef.current = true;
        }
    }, []);

    // Fetch on mount. Gated on having either a kid session or an
    // admin ?profileId - the auth gate above redirects to /login in
    // either-missing case, but without this guard we'd briefly
    // surface the server's 400 ("profileId query param required").
    const refresh = useCallback(async () => {
        if (!session && !adminProfileId) return;
        try {
            const url = new URL(
                "/api/kids/browse",
                window.location.origin,
            );
            // Always include adminProfileId when present, regardless
            // of whether localStorage has a kid session. The server
            // gives admin cookie auth priority over the bearer token
            // (resolveKidsAuth), so a stale kid session doesn't help
            // the admin preview path - it needs the profileId in the
            // query string to know which profile to load.
            if (adminProfileId) {
                url.searchParams.set("profileId", adminProfileId);
            }
            // withAuthRetry: a single 401 retries once after 800ms
            // before we give up + bounce to /login. Hides transient
            // Jellyfin restarts; real revocation still 401s on retry.
            const res = await withAuthRetry(() =>
                fetch(url.toString(), {
                    credentials: "same-origin",
                    headers: authHeaders(),
                }),
            );
            if (!res.ok) {
                if (res.status === 401) {
                    // Stale bearer token. Wipe local session and bounce
                    // to login - the only sane recovery.
                    clearSession();
                    nav("/login", { replace: true });
                    return;
                }
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            const body: BrowseResponse = await res.json();
            setData(body);
            writeBrowseCache(adminProfileId, body);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [session, adminProfileId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // First-time focus seeding when data lands. Two strategies, in
    // priority order:
    //   1. sessionStorage holds the last activated tile id (saved on
    //      Enter / click). When present and findable in the loaded
    //      rows, restore focus there - the kid pressed back from
    //      /watch or /play and expects to land where they came from.
    //   2. Otherwise, focus the first tile of the first row in the
    //      kid's layout. The default page-load entry is always (0,0)
    //      regardless of which row type is at the top.
    useEffect(() => {
        if (initialFocusSetRef.current) return;
        if (!data || data.rows.length === 0) return;
        initialFocusSetRef.current = true;

        const remembered = (() => {
            try {
                const raw = sessionStorage.getItem(LAST_FOCUSED_KEY);
                return raw ? (JSON.parse(raw) as { itemId: string }) : null;
            } catch {
                return null;
            }
        })();
        if (remembered?.itemId) {
            for (let r = 0; r < data.rows.length; r++) {
                const c = data.rows[r].items.findIndex(
                    (it) => it.Id === remembered.itemId,
                );
                if (c >= 0) {
                    setFocus({ kind: "tile", row: r, col: c });
                    return;
                }
            }
        }
        setFocus({ kind: "tile", row: 0, col: 0 });
    }, [data]);

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
        } catch {
            /* ignore */
        }
    }

    // Progressive Back: anywhere on the page collapses focus up to
    // the Browse pill in the top nav. From there, a second Back
    // falls through to the WebView and exits the kid app.
    useProgressiveBack(
        useCallback(() => {
            if (menuOpen) {
                setMenuOpen(false);
                return true;
            }
            if (override) {
                setOverride(null);
                return true;
            }
            if (focus.kind !== "tab" || focus.index !== 0) {
                setFocus({ kind: "tab", index: 0 });
                return true;
            }
            return false;
        }, [focus, menuOpen, override]),
    );

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

        // Enter / Space activate against the closure-captured focus.
        // That matches what the kid sees on screen: if a render is
        // queued behind a flurry of arrows, the visual focus is what
        // they pressed against. Activations don't repeat, so this
        // doesn't have the stale-state problem the arrows do.
        if (key === "Enter" || key === " ") {
            if (focus.kind === "tile") {
                const row = rows[focus.row];
                if (!row) return;
                const lastCol = row.items.length;
                if (focus.col === lastCol) {
                    if (row.hasMore) {
                        void loadMoreForRow(focus.row);
                    } else {
                        setFocus({ kind: "tile", row: focus.row, col: 0 });
                    }
                    return;
                }
                const item = row.items[focus.col];
                if (item) {
                    rememberLastFocused(item.Id);
                    // Always land on /watch first - the interstitial
                    // auto-pushes /play for items that have nothing
                    // useful to show in the menu, but the /watch
                    // history entry stays so Back from /play returns
                    // here instead of skipping straight to /browse.
                    nav(`/watch/${encodeURIComponent(item.Id)}${location.search}`);
                }
                return;
            }
            if (focus.kind === "tab") {
                if (focus.index === 2) {
                    setMenuOpen(true);
                } else {
                    const target = focus.index === 0 ? "browse" : "library";
                    nav(tabHref(target, location.search));
                }
                return;
            }
            return;
        }

        // Arrows: functional setter so each press resolves against the
        // latest committed focus, not the closure-captured one. Without
        // this, two presses arriving before the next render both read
        // the same stale focus and only one move sticks - the
        // double-tap-only-moves-once symptom.
        setFocus((prev) => {
            if (prev.kind === "tile") {
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
                    case "ArrowUp":
                        if (prev.row > 0) {
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
                        rowColMemoryRef.current.set(prev.row, prev.col);
                        lastTileRef.current = { row: prev.row, col: prev.col };
                        return { kind: "tab", index: 0 };
                }
                return prev;
            }
            if (prev.kind === "tab") {
                switch (key) {
                    case "ArrowDown":
                        return { kind: "tile", ...lastTileRef.current };
                    case "ArrowLeft":
                        return prev.index > 0
                            ? { kind: "tab", index: prev.index - 1 }
                            : prev;
                    case "ArrowRight":
                        // From the Browse tab (slot 0), Right both
                        // navigates to /library AND lands focus on
                        // the Library tab. flagTabFocus carries the
                        // intent across the page swap so the kid can
                        // keep arrowing without re-establishing focus.
                        if (prev.index === 0) {
                            flagTabFocus(1);
                            nav(`/library${location.search}`);
                            return prev;
                        }
                        return prev.index < TAB_SLOT_COUNT - 1
                            ? { kind: "tab", index: prev.index + 1 }
                            : prev;
                }
                return prev;
            }
            return prev;
        });
    }

    // Focus DOM management. Vertical positioning uses the smoothScroll
    // animator (window scroll). Horizontal positioning is owned by
    // useBrowseRowAnimator inside <AnimatedRowTrack> below: focus.col
    // updates the row's targetCol prop, the animator eases its track
    // toward that target on its own rAF loop. Decoupled from React's
    // render so rapid D-pad presses stay smooth.
    //
    // The very first focus scroll after mount is instant (no
    // animation) so a back-navigation with a primed cache lands
    // immediately on the previously-focused tile rather than
    // animating into place. Subsequent focus changes (kid moving the
    // D-pad) use the smooth animator.
    const didInitialFocusScroll = useRef(false);
    useEffect(() => {
        const k =
            focus.kind === "tile"
                ? `${focus.row}:${focus.col}`
                : `tab:${focus.index}`;
        const el = tileRefs.current[k];
        if (!el) return;
        el.focus({ preventScroll: true });
        const isFirst = !didInitialFocusScroll.current;
        didInitialFocusScroll.current = true;
        // Vertical scroll target: tab + first content row pin to the
        // top of the page; deeper rows center on the focused tile.
        // Pinning row 0 to the top means the kid sees the tab pill +
        // row 0 together, which matches the "you're at the start"
        // mental model.
        const pinToTop =
            focus.kind === "tab" ||
            (focus.kind === "tile" && focus.row === 0);
        if (pinToTop) {
            if (isFirst) window.scrollTo({ top: 0 });
            else scrollWindowToTop();
        } else if (focus.kind === "tile") {
            if (isFirst) {
                const rect = el.getBoundingClientRect();
                const elCenter = rect.top + window.scrollY + rect.height / 2;
                const target = Math.max(0, elCenter - window.innerHeight / 2);
                window.scrollTo({ top: target });
            } else {
                scrollWindowToCenter(el);
            }
        }
    }, [focus]);

    // Window-level keyboard listener so D-pad navigation works even
    // when DOM focus drifts to body (route transitions, occasional
    // WebView quirks where imperative .focus() doesn't take effect
    // on the first try). Skip while a modal is open - the modal owns
    // the keys via its own bubbled handler.
    useEffect(() => {
        if (menuOpen || override) return;
        const handler = (e: KeyboardEvent) => onKey(e);
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
        // onKey closes over focus + data; recreate on each change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focus, data, menuOpen, override]);

    // Re-focus the Menu tab when the menu modal closes. The modal's
    // close path doesn't change `focus` state (still tab[2]), so the
    // focus effect above doesn't re-fire and DOM focus stays on body
    // (the modal's last-focused element was unmounted with the modal).
    const wasMenuOpen = useRef(false);
    useEffect(() => {
        if (wasMenuOpen.current && !menuOpen) {
            tileRefs.current["tab:2"]?.focus({ preventScroll: true });
        }
        wasMenuOpen.current = menuOpen;
    }, [menuOpen]);

    if (error) {
        return (
            <div className="kids-page kids-error">
                <TabPill active="browse" search={location.search} />
                <p className="error">{error}</p>
                <Link to="/library">Back to library</Link>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="kids-page kids-loading">
                <TabPill active="browse" search={location.search} />
                <p>Loading…</p>
            </div>
        );
    }
    if (data.rows.length === 0) {
        return (
            <div className="kids-page kids-empty">
                <TabPill active="browse" search={location.search} />
                <h1>Nothing to browse yet</h1>
                <p>Ask a grown-up to set up your shows.</p>
            </div>
        );
    }

    return (
        <div className="browse">
            <TabPill
                active="browse"
                search={location.search}
                focusedIndex={focus.kind === "tab" ? focus.index : null}
                tabRef={(i, el) => {
                    tileRefs.current[`tab:${i}`] = el;
                }}
                onOpenMenu={() => setMenuOpen(true)}
            />
            {data.rows.map((row, rIdx) => {
                // Each row's targetCol drives useBrowseRowAnimator:
                // active row tracks the kid's focus.col, inactive rows
                // hold their remembered col (default 0) so they don't
                // drift when the kid arrows past. The animator on each
                // row owns its own translateX; React just sets the
                // target.
                const trackCol =
                    focus.kind === "tile" && focus.row === rIdx
                        ? focus.col
                        : (rowColMemoryRef.current.get(rIdx) ?? 0);
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
                                        focus.kind === "tile" &&
                                        focus.row === rIdx &&
                                        focus.col === cIdx;
                                    return (
                                        <Tile
                                            key={item.Id}
                                            item={item}
                                            size="browse"
                                            focused={focused}
                                            showProgress
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
                                        focus.kind === "tile" &&
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
            {override && (
                <OverrideModal
                    itemId={override.itemId}
                    itemName={override.itemName}
                    onClose={() => setOverride(null)}
                />
            )}
            {menuOpen && <MainMenuModal onClose={() => setMenuOpen(false)} />}
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
