import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
    authHeaders,
    getSession,
    type Session,
} from "./auth";
import TabPill from "./TabPill";
import OverrideModal, { useLongPressUp } from "./OverrideModal";

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
    | { kind: "tab" }
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

    // Fetch on mount.
    const refresh = useCallback(async () => {
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
        if (focus.kind === "tile") {
            const row = rows[focus.row];
            if (!row) return;
            switch (e.key) {
                case "ArrowRight":
                    if (focus.col < row.items.length - 1) {
                        setFocus({ kind: "tile", row: focus.row, col: focus.col + 1 });
                        e.preventDefault();
                    }
                    return;
                case "ArrowLeft":
                    if (focus.col > 0) {
                        setFocus({ kind: "tile", row: focus.row, col: focus.col - 1 });
                        e.preventDefault();
                    }
                    return;
                case "ArrowDown":
                    if (focus.row < rows.length - 1) {
                        const nextLen = rows[focus.row + 1].items.length;
                        const nextCol = Math.min(focus.col, Math.max(0, nextLen - 1));
                        setFocus({ kind: "tile", row: focus.row + 1, col: nextCol });
                        e.preventDefault();
                    }
                    return;
                case "ArrowUp":
                    if (focus.row > 0) {
                        const prevLen = rows[focus.row - 1].items.length;
                        const prevCol = Math.min(focus.col, Math.max(0, prevLen - 1));
                        setFocus({ kind: "tile", row: focus.row - 1, col: prevCol });
                    } else {
                        lastTileRef.current = { row: focus.row, col: focus.col };
                        setFocus({ kind: "tab" });
                    }
                    e.preventDefault();
                    return;
                case "Enter":
                case " ": {
                    const item = row.items[focus.col];
                    if (item) {
                        nav(`/play/${encodeURIComponent(item.Id)}${location.search}`);
                    }
                    e.preventDefault();
                    return;
                }
            }
        }
        if (focus.kind === "tab") {
            switch (e.key) {
                case "ArrowDown":
                    setFocus({ kind: "tile", ...lastTileRef.current });
                    e.preventDefault();
                    return;
            }
        }
    }

    // Scroll focused tile into view when it changes.
    useEffect(() => {
        if (focus.kind !== "tile") return;
        const k = `${focus.row}:${focus.col}`;
        const el = tileRefs.current[k];
        if (el) el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
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
            <TabPill active="browse" search={location.search} />
            {data.rows.map((row, rIdx) => (
                <section key={row.rowId} className="browse-row">
                    <h2 className="browse-row-title">{row.title}</h2>
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
                            const progress = item.UserData?.PlayedPercentage ?? 0;
                            return (
                                <button
                                    key={item.Id}
                                    ref={(el) => (tileRefs.current[key] = el)}
                                    className={`browse-tile ${focused ? "focused" : ""}`}
                                    type="button"
                                    role="listitem"
                                    tabIndex={focused ? 0 : -1}
                                    onClick={() =>
                                        nav(
                                            `/play/${encodeURIComponent(item.Id)}${location.search}`,
                                        )
                                    }
                                    onFocus={() =>
                                        setFocus({ kind: "tile", row: rIdx, col: cIdx })
                                    }
                                >
                                    <Poster id={item.Id} hasPoster={!!item.ImageTags?.Primary} />
                                    <div className="browse-tile-name">{item.Name}</div>
                                    {progress > 1 && progress < 99 && (
                                        <div
                                            className="browse-tile-progress"
                                            style={{ width: `${progress}%` }}
                                            aria-hidden
                                        />
                                    )}
                                </button>
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
        </div>
    );
}

function Poster({ id, hasPoster }: { id: string; hasPoster: boolean }) {
    if (!hasPoster) {
        return <div className="browse-tile-poster placeholder">?</div>;
    }
    return (
        <img
            className="browse-tile-poster"
            src={`/api/kids/items/${encodeURIComponent(id)}/image?type=Primary&width=240`}
            alt=""
            loading="lazy"
        />
    );
}
