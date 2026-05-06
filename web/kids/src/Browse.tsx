import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Heart } from "@phosphor-icons/react";
import {
    authHeaders,
    getSession,
    type Session,
} from "./auth";
import TabPill, { TAB_SLOT_COUNT, tabHref } from "./TabPill";
import OverrideModal, { useLongPressUp } from "./OverrideModal";
import MainMenuModal from "./MainMenuModal";
import Tile from "./Tile";
import { useProgressiveBack } from "./useProgressiveBack";
import { shouldShowWatchMenu } from "./Watch";

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

export default function Browse() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const adminProfileId = searchParams.get("profileId");
    const [data, setData] = useState<BrowseResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [focus, setFocus] = useState<Focus>({ kind: "tile", row: 0, col: 0 });
    const tileRefs = useRef<Record<string, HTMLElement | null>>({});
    const [override, setOverride] = useState<
        { itemId: string; itemName: string } | null
    >(null);
    const [menuOpen, setMenuOpen] = useState(false);

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
            if (!session && adminProfileId) {
                url.searchParams.set("profileId", adminProfileId);
            }
            const res = await fetch(url.toString(), {
                credentials: "same-origin",
                headers: authHeaders(),
            });
            if (!res.ok) {
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            const body: BrowseResponse = await res.json();
            setData(body);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [session, adminProfileId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    // Progressive Back escape: anywhere off (tile 0,0) collapses there
    // first. From (tile 0,0) the next back falls through to the WebView
    // and exits the kid app.
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
            if (focus.kind === "tab") {
                setFocus({ kind: "tile", row: 0, col: 0 });
                return true;
            }
            if (focus.kind === "tile" && (focus.row !== 0 || focus.col !== 0)) {
                setFocus({ kind: "tile", row: 0, col: 0 });
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
    // Out of scope here: Browse <-> Library swap via Left/Right on the
    // tab. The pill's onClick handles that via mouse / Enter, which is
    // sufficient for v1; D-pad-on-pill can come in a follow-up.
    const lastTileRef = useRef<{ row: number; col: number }>({ row: 0, col: 0 });
    function onKey(e: React.KeyboardEvent) {
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
        if (isHandled) e.preventDefault();
        if (focus.kind === "tile") {
            const row = rows[focus.row];
            if (!row) return;
            switch (e.key) {
                case "ArrowRight":
                    if (focus.col < row.items.length - 1) {
                        setFocus({ kind: "tile", row: focus.row, col: focus.col + 1 });
                    }
                    return;
                case "ArrowLeft":
                    if (focus.col > 0) {
                        setFocus({ kind: "tile", row: focus.row, col: focus.col - 1 });
                    }
                    return;
                case "ArrowDown":
                    if (focus.row < rows.length - 1) {
                        const nextLen = rows[focus.row + 1].items.length;
                        const nextCol = Math.min(focus.col, Math.max(0, nextLen - 1));
                        setFocus({ kind: "tile", row: focus.row + 1, col: nextCol });
                    }
                    return;
                case "ArrowUp":
                    if (focus.row > 0) {
                        const prevLen = rows[focus.row - 1].items.length;
                        const prevCol = Math.min(focus.col, Math.max(0, prevLen - 1));
                        setFocus({ kind: "tile", row: focus.row - 1, col: prevCol });
                    } else {
                        lastTileRef.current = { row: focus.row, col: focus.col };
                        setFocus({ kind: "tab", index: 0 });
                    }
                    return;
                case "Enter":
                case " ": {
                    const item = row.items[focus.col];
                    if (item) {
                        const target = shouldShowWatchMenu(item)
                            ? `/watch/${encodeURIComponent(item.Id)}`
                            : `/play/${encodeURIComponent(item.Id)}`;
                        nav(`${target}${location.search}`);
                    }
                    return;
                }
            }
        }
        if (focus.kind === "tab") {
            switch (e.key) {
                case "ArrowDown":
                    setFocus({ kind: "tile", ...lastTileRef.current });
                    return;
                case "ArrowLeft":
                    if (focus.index > 0) {
                        setFocus({ kind: "tab", index: focus.index - 1 });
                    }
                    return;
                case "ArrowRight":
                    if (focus.index < TAB_SLOT_COUNT - 1) {
                        setFocus({ kind: "tab", index: focus.index + 1 });
                    }
                    return;
                case "Enter":
                case " ": {
                    if (focus.index === 2) {
                        setMenuOpen(true);
                    } else {
                        const target = focus.index === 0 ? "browse" : "library";
                        nav(tabHref(target, location.search));
                    }
                    return;
                }
            }
        }
    }

    // Scroll the focused element into view + imperatively focus the
    // DOM element. preventScroll=true suppresses the browser's
    // automatic scroll-into-view from focus() so it doesn't race the
    // explicit smooth scroll below.
    //
    // Tab focus pins the window to top. Tile focus uses inline:"start"
    // (combined with scroll-padding-inline-start in CSS) so the focused
    // tile stays anchored at a fixed left position as the kid arrows
    // through the row - the row scrolls under a stationary cursor.
    // Block:"center" on the row keeps the focused row vertically
    // centered as the kid arrows down through rows.
    useEffect(() => {
        const k =
            focus.kind === "tile"
                ? `${focus.row}:${focus.col}`
                : `tab:${focus.index}`;
        const el = tileRefs.current[k];
        if (!el) return;
        el.focus({ preventScroll: true });
        if (focus.kind === "tab") {
            window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
            el.scrollIntoView({
                block: "center",
                inline: "start",
                behavior: "smooth",
            });
        }
    }, [focus]);

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
        <div className="browse" onKeyDown={onKey}>
            <TabPill
                active="browse"
                search={location.search}
                focusedIndex={focus.kind === "tab" ? focus.index : null}
                tabRef={(i, el) => {
                    tileRefs.current[`tab:${i}`] = el;
                }}
                onOpenMenu={() => setMenuOpen(true)}
            />
            {data.rows.map((row, rIdx) => (
                <section key={row.rowId} className="browse-row">
                    <h2 className="browse-row-title">
                        {row.type === "favorites" && (
                            <Heart
                                weight="fill"
                                className="browse-row-icon"
                                aria-hidden
                            />
                        )}
                        {row.title}
                    </h2>
                    <div
                        className="browse-row-items"
                        role="list"
                        aria-label={row.title}
                    >
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
                                        const target = shouldShowWatchMenu(item)
                                            ? `/watch/${encodeURIComponent(item.Id)}`
                                            : `/play/${encodeURIComponent(item.Id)}`;
                                        nav(`${target}${location.search}`);
                                    }}
                                    onFocus={() =>
                                        setFocus({ kind: "tile", row: rIdx, col: cIdx })
                                    }
                                    refCallback={(el) => (tileRefs.current[key] = el)}
                                />
                            );
                        })}
                    </div>
                </section>
            ))}
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
