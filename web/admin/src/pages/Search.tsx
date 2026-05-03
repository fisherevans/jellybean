import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, HttpError, type Item } from "../api";
import ItemCard from "../ItemCard";

export default function Search() {
    const [params, setParams] = useSearchParams();
    const [query, setQuery] = useState(params.get("q") ?? "");
    const [items, setItems] = useState<Item[] | null>(null);
    const [total, setTotal] = useState<number>(0);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        const trimmed = query.trim();
        if (!trimmed) {
            setItems(null);
            setTotal(0);
            setHasMore(false);
            return;
        }
        const handle = setTimeout(async () => {
            try {
                const res = await api.listItems({ search: trimmed, limit: 100 });
                setItems(res.Items);
                setTotal(res.TotalRecordCount);
                setHasMore(res.HasMore);
            } catch (err) {
                setError(err instanceof HttpError ? err.message : String(err));
            }
        }, 250);
        return () => clearTimeout(handle);
    }, [query]);

    useEffect(() => {
        if (query) {
            params.set("q", query);
        } else {
            params.delete("q");
        }
        setParams(params, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    async function setAge(itemId: string, age: number | null) {
        setBusy(itemId);
        setError(null);
        try {
            await api.setAge(itemId, age);
            setItems((cur) =>
                cur
                    ? cur.map((it) =>
                          it.Id === itemId
                              ? {
                                    ...it,
                                    MinAge: age,
                                    Bucket:
                                        age === null
                                            ? "uncategorized"
                                            : age < 13
                                            ? "kid"
                                            : "adult",
                                }
                              : it,
                      )
                    : cur,
            );
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="page">
            <h1>Search</h1>
            <p className="muted">
                Substring match on item names. Use this to find a specific title and
                re-categorize it.
            </p>
            <input
                className="search-input"
                placeholder="Type a title..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
            />
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
                                    onAgeChange={(c) => setAge(it.Id, c)}
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
