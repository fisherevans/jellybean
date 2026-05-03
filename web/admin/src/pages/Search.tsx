import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, HttpError, typeFilterParam, type Item, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";
import { useTypeFilter } from "../useTypeFilter";
import ItemCard from "../ItemCard";
import TypeFilterPicker from "../TypeFilter";

// Search hits Jellyfin's substring filter and shows results with the
// active profile's visibility state per item.

export default function Search() {
    const { profile } = useActiveProfile();
    const [typeFilter, setTypeFilter] = useTypeFilter();
    const [params, setParams] = useSearchParams();
    const [query, setQuery] = useState(params.get("q") ?? "");
    const [items, setItems] = useState<Item[] | null>(null);
    const [total, setTotal] = useState<number>(0);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        if (!profile) return;
        const trimmed = query.trim();
        if (!trimmed) {
            setItems(null);
            setTotal(0);
            setHasMore(false);
            return;
        }
        const handle = setTimeout(async () => {
            try {
                const res = await api.listItems({
                    profileId: profile.id,
                    search: trimmed,
                    limit: 100,
                    type: typeFilterParam(typeFilter),
                });
                setItems(res.Items);
                setTotal(res.TotalRecordCount);
                setHasMore(res.HasMore);
            } catch (err) {
                setError(err instanceof HttpError ? err.message : String(err));
            }
        }, 250);
        return () => clearTimeout(handle);
    }, [query, profile?.id, typeFilter]);

    useEffect(() => {
        if (query) {
            params.set("q", query);
        } else {
            params.delete("q");
        }
        setParams(params, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    async function setItemState(itemId: string, state: ItemState) {
        if (!profile) return;
        setBusy(itemId);
        setError(null);
        try {
            await api.setState(itemId, profile.id, state);
            setItems((cur) =>
                cur ? cur.map((it) => (it.Id === itemId ? { ...it, State: state } : it)) : cur,
            );
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <h1>Search</h1>
                <p>No profile selected. <Link to="/profiles">Pick or create one</Link>.</p>
            </div>
        );
    }

    return (
        <div className="page">
            <h1>Search</h1>
            <p className="muted">
                Substring match on item names. Visibility shown is for{" "}
                <strong>{profile.name}</strong>; switch profiles in the top nav.
            </p>
            <div className="search-controls">
                <input
                    className="search-input"
                    placeholder="Type a title..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                />
                <TypeFilterPicker value={typeFilter} onChange={setTypeFilter} />
            </div>
            {error && <div className="error">{error}</div>}
            {items === null && query.trim() === "" ? (
                <p className="muted">Start typing.</p>
            ) : items === null ? (
                <p className="muted">Searching...</p>
            ) : items.length === 0 ? (
                <p className="muted">No matches.</p>
            ) : (
                <>
                    <p className="muted">
                        Showing {items.length} of {total}
                        {hasMore && " — refine the search to see more."}
                    </p>
                    <ul className="search-list">
                        {items.map((it) => (
                            <li key={it.Id}>
                                <ItemCard
                                    item={it}
                                    onStateChange={(s) => setItemState(it.Id, s)}
                                    busy={busy === it.Id}
                                />
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
