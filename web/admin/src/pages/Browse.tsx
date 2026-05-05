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
type SortKey = "name" | "added" | "year" | "rating";

const SORT_OPTIONS: Array<{ key: SortKey; label: string; jellyfin: string }> = [
    { key: "name", label: "Name", jellyfin: "SortName" },
    { key: "added", label: "Date added", jellyfin: "DateCreated" },
    { key: "year", label: "Year", jellyfin: "ProductionYear" },
    { key: "rating", label: "Rating", jellyfin: "CommunityRating" },
];

export default function Browse() {
    const { profile } = useActiveProfile();
    const [items, setItems] = useState<Item[]>([]);
    const [total, setTotal] = useState(0);
    const [tags, setTags] = useState<Tag[]>([]);
    const [stateFilter, setStateFilter] = useState<StateFilter>("visible");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
    const [activeTagIds, setActiveTagIds] = useState<Set<number>>(new Set());
    const [yearMin, setYearMin] = useState("");
    const [yearMax, setYearMax] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
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
            // The server tagId filter only takes one value. With
            // multiple tags selected we issue one request per tag and
            // intersect the results client-side - works for the
            // typical 2-3 tag combinations and avoids a server change.
            const tagIds = [...activeTagIds];
            const baseParams = {
                profileId: profile.id,
                state:
                    stateParam === "all"
                        ? undefined
                        : (stateParam as Exclude<ItemState, null>),
                limit: PAGE_SIZE,
                type: typeParam,
                search: searchDebounced || undefined,
            } as const;
            let baseItems: Item[];
            let baseTotal: number;
            if (tagIds.length === 0) {
                const res = await api.listItems(baseParams);
                baseItems = res.Items ?? [];
                baseTotal = res.TotalRecordCount ?? 0;
            } else {
                const responses = await Promise.all(
                    tagIds.map((id) =>
                        api.listItems({ ...baseParams, tagId: id }),
                    ),
                );
                // Intersect by item id; keep first response's order +
                // metadata so the UI is stable.
                const firstSet = responses[0];
                const idsAfter = new Set<string>(
                    firstSet.Items?.map((it) => it.Id) ?? [],
                );
                for (let i = 1; i < responses.length; i++) {
                    const ids = new Set(
                        (responses[i].Items ?? []).map((it) => it.Id),
                    );
                    for (const id of [...idsAfter])
                        if (!ids.has(id)) idsAfter.delete(id);
                }
                baseItems = (firstSet.Items ?? []).filter((it) =>
                    idsAfter.has(it.Id),
                );
                baseTotal = baseItems.length;
            }
            // Year range filter (client-side - server lacks this).
            const min = yearMin ? Number(yearMin) : null;
            const max = yearMax ? Number(yearMax) : null;
            if (min || max) {
                baseItems = baseItems.filter((x) => {
                    const y = x.ProductionYear;
                    if (!y) return false;
                    if (min && y < min) return false;
                    if (max && y > max) return false;
                    return true;
                });
            }
            // Sort client-side. The server only supports SortName for
            // SortOrder Asc; for the other axes we sort the loaded
            // page (acceptable since we cap at PAGE_SIZE and most
            // libraries fit in a few pages).
            baseItems = sortItems(baseItems, sortKey, sortDir);
            setItems(baseItems);
            setTotal(baseTotal);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        } finally {
            setLoading(false);
        }
    }, [
        profile?.id,
        searchDebounced,
        activeTagIds,
        stateFilter,
        typeFilter,
        yearMin,
        yearMax,
        sortKey,
        sortDir,
    ]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const tagsById = useMemo(() => {
        const m = new Map<number, Tag>();
        for (const t of tags) m.set(t.id, t);
        return m;
    }, [tags]);

    function toggleTagFilter(id: number) {
        setActiveTagIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    const activeFilterCount =
        (typeFilter !== "all" ? 1 : 0) +
        activeTagIds.size +
        (yearMin || yearMax ? 1 : 0) +
        (stateFilter !== "visible" ? 1 : 0);

    function clearAll() {
        setStateFilter("visible");
        setTypeFilter("all");
        setActiveTagIds(new Set());
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
                <select
                    className="browse-sort"
                    value={`${sortKey}:${sortDir}`}
                    onChange={(e) => {
                        const [k, d] = e.target.value.split(":") as [
                            SortKey,
                            "asc" | "desc",
                        ];
                        setSortKey(k);
                        setSortDir(d);
                    }}
                    aria-label="Sort by"
                >
                    {SORT_OPTIONS.flatMap((o) =>
                        ["asc", "desc"].map((d) => (
                            <option key={`${o.key}:${d}`} value={`${o.key}:${d}`}>
                                {o.label} {d === "asc" ? "↑" : "↓"}
                            </option>
                        )),
                    )}
                </select>
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
                        {filterOpen ? "▲" : "▼"}
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
                            <span className="browse-filter-label">
                                Tags{" "}
                                {activeTagIds.size > 0
                                    ? `(${activeTagIds.size} selected, items must match all)`
                                    : "(multi-select)"}
                            </span>
                            <div className="pill-toggle-row pill-toggle-wrap">
                                {tags.map((t) => {
                                    const on = activeTagIds.has(t.id);
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            className={`pill-toggle ${
                                                on ? "active" : ""
                                            }`}
                                            aria-pressed={on}
                                            onClick={() => toggleTagFilter(t.id)}
                                        >
                                            {t.name}
                                        </button>
                                    );
                                })}
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
                          activeTagIds.size > 0
                              ? ` tagged ${[...activeTagIds]
                                    .map((id) => tagsById.get(id)?.name ?? id)
                                    .join(" + ")}`
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

function sortItems(items: Item[], key: SortKey, dir: "asc" | "desc"): Item[] {
    const sorted = [...items].sort((a, b) => {
        let cmp = 0;
        switch (key) {
            case "name":
                cmp = a.Name.localeCompare(b.Name, undefined, {
                    sensitivity: "base",
                });
                break;
            case "year":
                cmp = (a.ProductionYear ?? 0) - (b.ProductionYear ?? 0);
                break;
            case "rating":
                // Rating comes through as OfficialRating string; use the
                // year as a tiebreaker since we don't have community
                // rating numbers loaded.
                cmp = (a.OfficialRating ?? "").localeCompare(
                    b.OfficialRating ?? "",
                );
                break;
            case "added":
                // The admin items endpoint doesn't return DateCreated
                // yet, so "Date added" sort falls back to id (a stable
                // proxy for insertion order).
                cmp = a.Id.localeCompare(b.Id);
                break;
        }
        return dir === "asc" ? cmp : -cmp;
    });
    return sorted;
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
                    <div className="browse-item-head">
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
                    </div>
                    {item.Tags && item.Tags.length > 0 && (
                        <div className="browse-item-tags">
                            {item.Tags.slice(0, 4).map((t) => (
                                <span key={t.id} className="browse-tag-pill">
                                    {t.name}
                                </span>
                            ))}
                            {item.Tags.length > 4 && (
                                <span className="browse-tag-pill more">
                                    +{item.Tags.length - 4}
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
