import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
    authHeaders,
    clearSession,
    getSession,
    probeAdmin,
    type AdminUser,
    type Session,
} from "./auth";

// Library is the kid's main browsing screen. Layout top-to-bottom:
//
//   [type filter: Both | Movies | TV]
//   [Continue Watching row (scroll-x), hidden if empty]
//   [main grid - infinite paginated]
//
// All three regions participate in a single D-pad focus model. State
// shape: a discriminated union for what's focused, plus an index. Keys
// move focus; on focus change, we ensure the focused element is scrolled
// into view. Enter / Space / Click on a tile navigates to playback.
//
// Auth paths:
//   - Kid path: a Session is in localStorage (token + userId + profileId).
//     Bearer token + Jellyfin user id + deviceId go in headers.
//   - Admin path: ?profileId=N in the URL; admin cookie auths the request.

type LibraryItem = {
    Id: string;
    Name: string;
    Type: string;
    ImageTags?: { Primary?: string };
    UserData?: { PlaybackPositionTicks?: number; PlayedPercentage?: number };
};

type LibraryResponse = {
    Items: LibraryItem[] | null;
    HasMore?: boolean;
    NextStartIndex?: number;
    ProfileId?: number;
};

type TypeFilter = "Both" | "Movies" | "TV";

const FILTER_STORAGE = "jellybean.kids.typeFilter";
const TYPE_FILTERS: TypeFilter[] = ["Both", "Movies", "TV"];

function filterToType(t: TypeFilter): string {
    return t === "Movies" ? "Movie" : t === "TV" ? "Series" : "Movie,Series";
}

type Focus =
    | { kind: "filter"; index: number }
    | { kind: "cw"; index: number }
    | { kind: "grid"; index: number };

const PAGE_SIZE = 24;

export default function Library() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [session] = useState<Session | null>(() => getSession());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const adminProfileId = searchParams.get("profileId");
    // Preserve search params (e.g. admin's profileId) when navigating to
    // /play so the back link can return to the same filtered library
    // view. Real kid users have no search params; this is a no-op for them.
    const playSuffix = searchParams.toString() ? `?${searchParams.toString()}` : "";

    const [filter, setFilter] = useState<TypeFilter>(() => {
        const v = localStorage.getItem(FILTER_STORAGE);
        return TYPE_FILTERS.includes(v as TypeFilter) ? (v as TypeFilter) : "Both";
    });

    const [continueItems, setContinueItems] = useState<LibraryItem[]>([]);
    const [items, setItems] = useState<LibraryItem[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [nextStart, setNextStart] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [focus, setFocus] = useState<Focus>({ kind: "filter", index: 0 });
    const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        localStorage.setItem(FILTER_STORAGE, filter);
    }, [filter]);

    const buildURL = useCallback(
        (section: "all" | "continue-watching", startIndex: number) => {
            const url = new URL("/api/kids/library", window.location.origin);
            url.searchParams.set("section", section);
            url.searchParams.set("type", filterToType(filter));
            url.searchParams.set("limit", String(PAGE_SIZE));
            if (startIndex > 0) {
                url.searchParams.set("startIndex", String(startIndex));
            }
            if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
            return url.toString();
        },
        [filter, adminProfileId],
    );

    const fetchSection = useCallback(
        async (section: "all" | "continue-watching", startIndex: number) => {
            const res = await fetch(buildURL(section, startIndex), {
                credentials: "same-origin",
                headers: authHeaders(),
            });
            if (!res.ok) {
                throw new Error(`${res.status}: ${await res.text()}`);
            }
            return (await res.json()) as LibraryResponse;
        },
        [buildURL],
    );

    // Initial load (and re-load on filter change). Both sections fire in
    // parallel to keep the page snappy.
    useEffect(() => {
        if (admin === undefined) return;
        if (!session && !adminProfileId) {
            nav("/login", { replace: true });
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        setItems([]);
        setNextStart(0);
        setHasMore(false);

        Promise.all([fetchSection("all", 0), fetchSection("continue-watching", 0)])
            .then(([all, cw]) => {
                if (cancelled) return;
                setItems(all.Items ?? []);
                setHasMore(!!all.HasMore);
                setNextStart(all.NextStartIndex ?? (all.Items?.length ?? 0));
                setContinueItems(cw.Items ?? []);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(String(err.message ?? err));
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [admin, session, adminProfileId, fetchSection, nav]);

    // Infinite scroll for the main grid.
    useEffect(() => {
        if (!sentinelRef.current || !hasMore || loadingMore || loading) return;
        const el = sentinelRef.current;
        const obs = new IntersectionObserver(
            (entries) => {
                const visible = entries[0]?.isIntersecting ?? false;
                if (!visible) return;
                setLoadingMore(true);
                fetchSection("all", nextStart)
                    .then((page) => {
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
    }, [hasMore, loadingMore, loading, nextStart, fetchSection]);

    // Keep focused element on screen.
    useEffect(() => {
        const key = focusKey(focus);
        const el = tileRefs.current[key];
        if (el) {
            el.focus({ preventScroll: false });
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    }, [focus]);

    // Calculate columns in the grid based on viewport width to drive
    // up/down navigation. The CSS grid uses auto-fill with minmax(180px),
    // so we approximate by measuring the grid element.
    const gridRef = useRef<HTMLDivElement | null>(null);
    const columns = useGridColumns(gridRef);

    const onKey = useCallback(
        (e: React.KeyboardEvent) => {
            const key = e.key;
            if (
                key !== "ArrowLeft" &&
                key !== "ArrowRight" &&
                key !== "ArrowUp" &&
                key !== "ArrowDown" &&
                key !== "Enter" &&
                key !== " "
            ) {
                return;
            }
            e.preventDefault();
            setFocus((f) => moveFocus(f, key, {
                filterCount: TYPE_FILTERS.length,
                cwCount: continueItems.length,
                gridCount: items.length,
                columns,
                onActivate: () =>
                    activate(f, items, continueItems, filter, setFilter, nav, playSuffix),
            }));
        },
        [continueItems, items, columns, filter, nav],
    );

    if (admin === undefined) return <div className="screen">Loading...</div>;

    const heading = session
        ? (session.kidName ?? session.userName)
        : "Library";

    function signOut() {
        clearSession();
        nav("/login", { replace: true });
    }

    return (
        <div className="library" onKeyDown={onKey}>
            {adminProfileId && !session && <AdminPreviewBanner />}
            <header className="library-header">
                <div>
                    <h1>{heading}</h1>
                    {adminProfileId && !session && (
                        <p className="library-sub">
                            Admin preview: profile id {adminProfileId}
                        </p>
                    )}
                </div>
                {session ? (
                    <button
                        type="button"
                        className="picker-link signout-btn"
                        onClick={signOut}
                    >
                        Sign out
                    </button>
                ) : (
                    <Link to="/" className="picker-link">
                        back
                    </Link>
                )}
            </header>

            <div className="filter-row" role="tablist">
                {TYPE_FILTERS.map((f, i) => {
                    const k = `filter:${i}`;
                    const active = filter === f;
                    return (
                        <button
                            key={f}
                            ref={(el) => (tileRefs.current[k] = el)}
                            className={`filter-pill ${active ? "active" : ""} ${
                                isFocused(focus, "filter", i) ? "focused" : ""
                            }`}
                            onClick={() => {
                                setFilter(f);
                                setFocus({ kind: "filter", index: i });
                            }}
                            onFocus={() => setFocus({ kind: "filter", index: i })}
                            tabIndex={isFocused(focus, "filter", i) ? 0 : -1}
                            role="tab"
                        >
                            {f}
                        </button>
                    );
                })}
            </div>

            {error && <p className="error">{error}</p>}

            {loading ? (
                <p className="library-state">Loading...</p>
            ) : (
                <>
                    {continueItems.length > 0 && (
                        <section className="cw-row" aria-label="Continue watching">
                            <h2 className="row-title">Continue Watching</h2>
                            <div className="cw-scroll">
                                {continueItems.map((it, i) => (
                                    <Tile
                                        key={`cw:${it.Id}`}
                                        item={it}
                                        large={false}
                                        focused={isFocused(focus, "cw", i)}
                                        onClick={() => {
                                            setFocus({ kind: "cw", index: i });
                                            nav(`/play/${encodeURIComponent(it.Id)}${playSuffix}`);
                                        }}
                                        onFocus={() => setFocus({ kind: "cw", index: i })}
                                        refCallback={(el) => (tileRefs.current[`cw:${i}`] = el)}
                                        focusKey={`cw:${i}`}
                                    />
                                ))}
                            </div>
                        </section>
                    )}

                    <section aria-label="Library">
                        <h2 className="row-title">All</h2>
                        {items.length === 0 ? (
                            <p className="library-state">
                                Nothing here yet. Ask a parent to mark titles
                                visible.
                            </p>
                        ) : (
                            <div className="grid" ref={gridRef}>
                                {items.map((it, i) => (
                                    <Tile
                                        key={`grid:${it.Id}`}
                                        item={it}
                                        large
                                        focused={isFocused(focus, "grid", i)}
                                        onClick={() => {
                                            setFocus({ kind: "grid", index: i });
                                            nav(`/play/${encodeURIComponent(it.Id)}${playSuffix}`);
                                        }}
                                        onFocus={() => setFocus({ kind: "grid", index: i })}
                                        refCallback={(el) =>
                                            (tileRefs.current[`grid:${i}`] = el)
                                        }
                                        focusKey={`grid:${i}`}
                                    />
                                ))}
                            </div>
                        )}
                        <div ref={sentinelRef} className="sentinel" />
                        {loadingMore && <p className="library-state">Loading more...</p>}
                    </section>
                </>
            )}
        </div>
    );
}

// AdminPreviewBanner is rendered when the kids client is being previewed
// from the admin app (i.e. ?profileId=N is in the URL). The kids SPA's
// basename is /kids, so the link uses a real <a href> to escape back to
// the admin shell rather than the React Router Link.
function AdminPreviewBanner() {
    return (
        <div className="admin-preview-banner" role="status">
            <span>Previewing as admin. Resume / continue-watching are disabled in preview.</span>
            <a href="/manage-kids" className="admin-preview-back">
                Back to admin
            </a>
        </div>
    );
}

function focusKey(f: Focus): string {
    return `${f.kind}:${f.index}`;
}

function isFocused(f: Focus, kind: Focus["kind"], index: number): boolean {
    return f.kind === kind && f.index === index;
}

type MoveOpts = {
    filterCount: number;
    cwCount: number;
    gridCount: number;
    columns: number;
    onActivate: () => void;
};

function moveFocus(f: Focus, key: string, opts: MoveOpts): Focus {
    if (key === "Enter" || key === " ") {
        opts.onActivate();
        return f;
    }
    switch (f.kind) {
        case "filter":
            if (key === "ArrowLeft") return { kind: "filter", index: Math.max(0, f.index - 1) };
            if (key === "ArrowRight")
                return { kind: "filter", index: Math.min(opts.filterCount - 1, f.index + 1) };
            if (key === "ArrowDown") {
                if (opts.cwCount > 0) return { kind: "cw", index: 0 };
                if (opts.gridCount > 0) return { kind: "grid", index: 0 };
            }
            return f;
        case "cw":
            if (key === "ArrowLeft") return { kind: "cw", index: Math.max(0, f.index - 1) };
            if (key === "ArrowRight")
                return { kind: "cw", index: Math.min(opts.cwCount - 1, f.index + 1) };
            if (key === "ArrowUp") return { kind: "filter", index: 0 };
            if (key === "ArrowDown") {
                if (opts.gridCount > 0) return { kind: "grid", index: 0 };
            }
            return f;
        case "grid": {
            const cols = Math.max(1, opts.columns);
            const i = f.index;
            if (key === "ArrowLeft") return { kind: "grid", index: Math.max(0, i - 1) };
            if (key === "ArrowRight")
                return { kind: "grid", index: Math.min(opts.gridCount - 1, i + 1) };
            if (key === "ArrowDown") {
                const next = i + cols;
                if (next < opts.gridCount) return { kind: "grid", index: next };
                return { kind: "grid", index: opts.gridCount - 1 };
            }
            if (key === "ArrowUp") {
                if (i < cols) {
                    if (opts.cwCount > 0)
                        return { kind: "cw", index: Math.min(opts.cwCount - 1, i) };
                    return { kind: "filter", index: 0 };
                }
                return { kind: "grid", index: i - cols };
            }
            return f;
        }
    }
}

function activate(
    f: Focus,
    items: LibraryItem[],
    cw: LibraryItem[],
    filter: TypeFilter,
    setFilter: (t: TypeFilter) => void,
    nav: ReturnType<typeof useNavigate>,
    playSuffix: string,
) {
    if (f.kind === "filter") {
        const next = TYPE_FILTERS[f.index];
        if (next) setFilter(next);
        return;
    }
    const target = f.kind === "cw" ? cw[f.index] : items[f.index];
    if (target) nav(`/play/${encodeURIComponent(target.Id)}${playSuffix}`);
    void filter;
}

function useGridColumns(ref: React.RefObject<HTMLDivElement>): number {
    const [cols, setCols] = useState(4);
    useEffect(() => {
        if (!ref.current) return;
        const el = ref.current;
        const update = () => {
            const style = window.getComputedStyle(el);
            const cs = style.getPropertyValue("grid-template-columns");
            // "180px 180px 180px 180px" -> 4
            const n = cs.split(" ").filter(Boolean).length;
            if (n > 0) setCols(n);
        };
        update();
        const obs = new ResizeObserver(update);
        obs.observe(el);
        return () => obs.disconnect();
    }, [ref]);
    return cols;
}

type TileProps = {
    item: LibraryItem;
    large: boolean;
    focused: boolean;
    onClick: () => void;
    onFocus: () => void;
    refCallback: (el: HTMLButtonElement | null) => void;
    focusKey: string;
};

function Tile({ item, large, focused, onClick, onFocus, refCallback }: TileProps) {
    const tag = item.ImageTags?.Primary ?? "";
    const width = large ? 360 : 220;
    const src = `/api/kids/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=${width}${
        tag ? `&tag=${encodeURIComponent(tag)}` : ""
    }`;
    const isSeries = item.Type === "Series";
    return (
        <button
            ref={refCallback}
            className={`tile ${large ? "tile-grid" : "tile-cw"} ${focused ? "focused" : ""}`}
            onClick={onClick}
            onFocus={onFocus}
            tabIndex={focused ? 0 : -1}
        >
            <div className="tile-poster">
                {tag ? (
                    <img src={src} alt={item.Name} loading="lazy" />
                ) : (
                    <div className="tile-poster-placeholder">{item.Name}</div>
                )}
                {isSeries && <span className="tile-badge">TV</span>}
            </div>
            <div className="tile-title">{item.Name}</div>
        </button>
    );
}
