import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Item, type ItemState, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";

// Browse the profile's library. Replaces the old separate Search
// page (search bar lives here now). Filters expand into a panel:
// state (visible / hidden / unset), type, year range, single tag
// (server only supports one tag id per query). Cards show poster +
// name + year + type + tag pills; a kebab on each card opens a
// quick-action menu (Mark hidden / Mark visible / Edit on detail
// page).

const PAGE_SIZE = 60;

type StateFilter = "visible" | "hidden" | "unset" | "all";
type TypeFilter = "all" | "Movie" | "Series";

export default function Browse() {
    const { profile } = useActiveProfile();
    const [items, setItems] = useState<Item[]>([]);
    const [total, setTotal] = useState(0);
    const [tags, setTags] = useState<Tag[]>([]);
    const [stateFilter, setStateFilter] = useState<StateFilter>("visible");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
    const [activeTagId, setActiveTagId] = useState<number | null>(null);
    const [yearMin, setYearMin] = useState("");
    const [yearMax, setYearMax] = useState("");
    const [search, setSearch] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    const [filterOpen, setFilterOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyItemId, setBusyItemId] = useState<string | null>(null);

    useEffect(() => {
        const id = window.setTimeout(() => setSearchDebounced(search.trim()), 300);
        return () => window.clearTimeout(id);
    }, [search]);

    useEffect(() => {
        api.listTags({ sort: "name" }).then((res) => setTags(res.tags));
    }, []);

    const refresh = useCallback(async () => {
        if (!profile) return;
        setLoading(true);
        setError(null);
        try {
            const stateParam: ItemState | "all" =
                stateFilter === "all" ? "all" : (stateFilter as ItemState);
            const typeParam =
                typeFilter === "all" ? "Movie,Series" : typeFilter;
            const res = await api.listItems({
                profileId: profile.id,
                state: stateParam === "all" ? undefined : (stateParam as Exclude<ItemState, null>),
                limit: PAGE_SIZE,
                type: typeParam,
                search: searchDebounced || undefined,
                tagId: activeTagId ?? undefined,
            });
            let it = res.Items ?? [];
            // Year range is filtered client-side; the server doesn't
            // expose a year query param yet.
            const min = yearMin ? Number(yearMin) : null;
            const max = yearMax ? Number(yearMax) : null;
            if (min || max) {
                it = it.filter((x) => {
                    const y = x.ProductionYear;
                    if (!y) return false;
                    if (min && y < min) return false;
                    if (max && y > max) return false;
                    return true;
                });
            }
            setItems(it);
            setTotal(res.TotalRecordCount ?? 0);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        } finally {
            setLoading(false);
        }
    }, [profile?.id, searchDebounced, activeTagId, stateFilter, typeFilter, yearMin, yearMax]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const tagsById = useMemo(() => {
        const m = new Map<number, Tag>();
        for (const t of tags) m.set(t.id, t);
        return m;
    }, [tags]);

    const activeFilterCount =
        (typeFilter !== "all" ? 1 : 0) +
        (activeTagId !== null ? 1 : 0) +
        (yearMin || yearMax ? 1 : 0) +
        (stateFilter !== "visible" ? 1 : 0);

    function clearAll() {
        setStateFilter("visible");
        setTypeFilter("all");
        setActiveTagId(null);
        setYearMin("");
        setYearMax("");
    }

    async function setItemState(id: string, next: ItemState) {
        if (!profile) return;
        setBusyItemId(id);
        try {
            await api.setState(id, profile.id, next);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyItemId(null);
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <p className="muted">Pick a profile to browse its library.</p>
            </div>
        );
    }

    return (
        <div className="page browse-page">
            <div className="page-head">
                <div>
                    <h1>Browse</h1>
                    <p className="muted">
                        Library for <strong>{profile.name}</strong>. Filter
                        and search across visibility, type, year, and tags.
                    </p>
                </div>
            </div>

            <div className="browse-controls">
                <input
                    type="search"
                    className="browse-search"
                    placeholder="Search by name..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button
                    type="button"
                    className={`browse-filter-toggle ${
                        filterOpen ? "open" : ""
                    }`}
                    onClick={() => setFilterOpen((v) => !v)}
                    aria-expanded={filterOpen}
                >
                    Filters
                    {activeFilterCount > 0 && (
                        <span className="browse-filter-count">
                            {activeFilterCount}
                        </span>
                    )}
                    <span className="browse-filter-caret" aria-hidden>
                        {filterOpen ? "▴" : "▾"}
                    </span>
                </button>
            </div>

            {filterOpen && (
                <div className="browse-filter-panel">
                    <div className="browse-filter-group">
                        <span className="browse-filter-label">Visibility</span>
                        <div className="pill-toggle-row">
                            {(["visible", "hidden", "unset", "all"] as StateFilter[]).map(
                                (s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        className={`pill-toggle ${
                                            stateFilter === s ? "active" : ""
                                        }`}
                                        aria-pressed={stateFilter === s}
                                        onClick={() => setStateFilter(s)}
                                    >
                                        {s === "all"
                                            ? "All"
                                            : s[0].toUpperCase() + s.slice(1)}
                                    </button>
                                ),
                            )}
                        </div>
                    </div>

                    <div className="browse-filter-group">
                        <span className="browse-filter-label">Type</span>
                        <div className="pill-toggle-row">
                            {(["all", "Movie", "Series"] as TypeFilter[]).map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    className={`pill-toggle ${
                                        typeFilter === t ? "active" : ""
                                    }`}
                                    aria-pressed={typeFilter === t}
                                    onClick={() => setTypeFilter(t)}
                                >
                                    {t === "all" ? "All" : t === "Series" ? "TV" : t}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="browse-filter-group">
                        <span className="browse-filter-label">Year</span>
                        <div className="browse-year-range">
                            <input
                                type="number"
                                placeholder="From"
                                value={yearMin}
                                onChange={(e) => setYearMin(e.target.value)}
                                min={1900}
                                max={2100}
                            />
                            <span className="muted">to</span>
                            <input
                                type="number"
                                placeholder="To"
                                value={yearMax}
                                onChange={(e) => setYearMax(e.target.value)}
                                min={1900}
                                max={2100}
                            />
                        </div>
                    </div>

                    {tags.length > 0 && (
                        <div className="browse-filter-group">
                            <span className="browse-filter-label">Tag</span>
                            <div className="pill-toggle-row pill-toggle-wrap">
                                {tags.map((t) => (
                                    <button
                                        key={t.id}
                                        type="button"
                                        className={`pill-toggle ${
                                            activeTagId === t.id ? "active" : ""
                                        }`}
                                        aria-pressed={activeTagId === t.id}
                                        onClick={() =>
                                            setActiveTagId((prev) =>
                                                prev === t.id ? null : t.id,
                                            )
                                        }
                                    >
                                        {t.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {activeFilterCount > 0 && (
                        <div className="browse-filter-actions">
                            <button type="button" onClick={clearAll}>
                                Clear all
                            </button>
                        </div>
                    )}
                </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="browse-meta muted">
                {loading
                    ? "Loading..."
                    : `${items.length} of ${total.toLocaleString()} ${
                          stateFilter === "all" ? "" : stateFilter + " "
                      }item${total === 1 ? "" : "s"}${
                          activeTagId !== null
                              ? ` tagged ${tagsById.get(activeTagId)?.name ?? ""}`
                              : ""
                      }`}
            </div>

            {loading ? (
                <Spinner block size={36} label="Loading..." />
            ) : (
                <ul className="browse-grid">
                    {items.map((it) => (
                        <BrowseCard
                            key={it.Id}
                            item={it}
                            tagsById={tagsById}
                            busy={busyItemId === it.Id}
                            onMarkVisible={() => setItemState(it.Id, "visible")}
                            onMarkHidden={() => setItemState(it.Id, "hidden")}
                            onClearState={() => setItemState(it.Id, null)}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

type CardProps = {
    item: Item;
    tagsById: Map<number, Tag>;
    busy: boolean;
    onMarkVisible: () => void;
    onMarkHidden: () => void;
    onClearState: () => void;
};

function BrowseCard({
    item,
    busy,
    onMarkVisible,
    onMarkHidden,
    onClearState,
}: CardProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const wrapRef = useRef<HTMLLIElement | null>(null);

    useEffect(() => {
        if (!menuOpen) return;
        function onClick(e: MouseEvent) {
            if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setMenuOpen(false);
        }
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    const posterURL = item.ImageTags?.Primary
        ? `/api/admin/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=80&tag=${encodeURIComponent(
              item.ImageTags.Primary,
          )}`
        : null;

    return (
        <li ref={wrapRef} className="browse-item">
            <Link
                to={`/items/${encodeURIComponent(item.Id)}`}
                className="browse-item-link"
            >
                {posterURL ? (
                    <img
                        src={posterURL}
                        alt=""
                        className="browse-item-poster"
                        loading="lazy"
                    />
                ) : (
                    <div className="browse-item-poster placeholder" aria-hidden>
                        ?
                    </div>
                )}
                <div className="browse-item-body">
                    <div className="browse-item-name">{item.Name}</div>
                    <div className="browse-item-meta">
                        <span
                            className={`browse-state-pill state-${
                                item.State ?? "unset"
                            }`}
                        >
                            {item.State ?? "unset"}
                        </span>
                        <span className="muted">
                            {item.Type === "Series" ? "TV" : "Movie"}
                            {item.ProductionYear ? ` · ${item.ProductionYear}` : ""}
                        </span>
                    </div>
                    {item.Tags && item.Tags.length > 0 && (
                        <div className="browse-item-tags">
                            {item.Tags.slice(0, 3).map((t) => (
                                <span key={t.id} className="browse-tag-pill">
                                    {t.name}
                                </span>
                            ))}
                            {item.Tags.length > 3 && (
                                <span className="browse-tag-pill more">
                                    +{item.Tags.length - 3}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </Link>
            <button
                type="button"
                className="browse-item-kebab"
                aria-label="Quick actions"
                aria-expanded={menuOpen}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen((v) => !v);
                }}
                disabled={busy}
            >
                ⋯
            </button>
            {menuOpen && (
                <div className="browse-item-menu" role="menu">
                    {item.State !== "visible" && (
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
                                onMarkVisible();
                            }}
                        >
                            Mark visible
                        </button>
                    )}
                    {item.State !== "hidden" && (
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
                                onMarkHidden();
                            }}
                        >
                            Mark hidden
                        </button>
                    )}
                    {item.State !== null && (
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setMenuOpen(false);
                                onClearState();
                            }}
                        >
                            Clear state
                        </button>
                    )}
                    <Link
                        to={`/items/${encodeURIComponent(item.Id)}`}
                        role="menuitem"
                        className="browse-item-menu-link"
                    >
                        Edit details + tags →
                    </Link>
                </div>
            )}
        </li>
    );
}
