import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Item, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";

// Browse the visible content for a profile. Single-tag filter (uses
// the server's tagId query param), optional name search. Tags on the
// active filter render as pills; click an item to open manage-item.
//
// Multi-tag intersection isn't supported server-side yet; the UI
// allows one tag at a time and we re-issue the listItems request
// when the selection changes.

const PAGE_SIZE = 60;

export default function Browse() {
    const { profile } = useActiveProfile();
    const [items, setItems] = useState<Item[]>([]);
    const [total, setTotal] = useState(0);
    const [tags, setTags] = useState<Tag[]>([]);
    const [activeTagId, setActiveTagId] = useState<number | null>(null);
    const [search, setSearch] = useState("");
    const [searchDebounced, setSearchDebounced] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            const res = await api.listItems({
                profileId: profile.id,
                state: "visible",
                limit: PAGE_SIZE,
                type: "Movie,Series",
                search: searchDebounced || undefined,
                tagId: activeTagId ?? undefined,
            });
            setItems(res.Items ?? []);
            setTotal(res.TotalRecordCount ?? 0);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        } finally {
            setLoading(false);
        }
    }, [profile?.id, searchDebounced, activeTagId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const tagsById = useMemo(() => {
        const m = new Map<number, Tag>();
        for (const t of tags) m.set(t.id, t);
        return m;
    }, [tags]);

    function toggleTagFilter(id: number) {
        setActiveTagId((prev) => (prev === id ? null : id));
    }

    const filtered = items;

    if (!profile) {
        return (
            <div className="page">
                <p className="muted">Pick a profile to browse its visible library.</p>
            </div>
        );
    }

    return (
        <div className="page browse-page">
            <div className="page-head">
                <div>
                    <h1>Browse</h1>
                    <p className="muted">
                        All visible content for <strong>{profile.name}</strong>.
                        Filter by tag or search by name.
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
            </div>

            {tags.length > 0 && (
                <div className="browse-tag-filter">
                    <span className="browse-tag-filter-label">Filter by tag:</span>
                    {tags.map((t) => {
                        const on = activeTagId === t.id;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                className={`pill-toggle ${on ? "active" : ""}`}
                                aria-pressed={on}
                                onClick={() => toggleTagFilter(t.id)}
                            >
                                {t.name}
                            </button>
                        );
                    })}
                    {activeTagId !== null && (
                        <button
                            type="button"
                            onClick={() => setActiveTagId(null)}
                            className="browse-tag-clear"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="browse-meta muted">
                {loading
                    ? "Loading..."
                    : `${total.toLocaleString()} visible item${total === 1 ? "" : "s"}${
                          activeTagId !== null
                              ? ` tagged ${tagsById.get(activeTagId)?.name ?? ""}`
                              : ""
                      }`}
            </div>

            {loading ? (
                <Spinner block size={36} label="Loading..." />
            ) : (
                <ul className="browse-grid">
                    {filtered.map((it) => (
                        <li key={it.Id} className="browse-item">
                            <Link
                                to={`/manage-item/${encodeURIComponent(it.Id)}`}
                                className="browse-item-link"
                            >
                                <span className="browse-item-name">
                                    {it.Name}
                                </span>
                                <span className="browse-item-type">
                                    {it.Type === "Series" ? "TV" : "Movie"}
                                    {it.ProductionYear
                                        ? ` · ${it.ProductionYear}`
                                        : ""}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
