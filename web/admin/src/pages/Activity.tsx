import { useEffect, useState } from "react";
import { api, HttpError, type ActivityEntry, type Item } from "../api";
import CategoryControl from "../CategoryControl";

export default function Activity() {
    const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null); // item id being updated

    async function refresh() {
        try {
            const res = await api.recentActivity(50);
            setEntries(res.entries);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function setCategory(itemId: string, category: Item["Category"]) {
        setBusy(itemId);
        setError(null);
        try {
            await api.setCategory(itemId, category);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="page">
            <h1>Recent activity</h1>
            <p className="muted">
                Last 50 categorization changes. Surface to catch fresh mistakes -
                click a different category to flip it back.
            </p>
            {error && <div className="error">{error}</div>}
            {entries === null ? (
                <p>Loading...</p>
            ) : entries.length === 0 ? (
                <p className="muted">No activity yet.</p>
            ) : (
                <ul className="activity-list">
                    {entries.map((e) => (
                        <li key={e.id}>
                            <div className="activity-row">
                                <div className="activity-info">
                                    <div className="activity-name">{e.itemName}</div>
                                    <div className="muted">
                                        {e.fromCategory ? `${e.fromCategory} → ` : ""}
                                        <strong>{e.toCategory}</strong>
                                        {" · "}
                                        {new Date(e.changedAt * 1000).toLocaleString()}
                                    </div>
                                </div>
                                <CategoryControl
                                    value={e.toCategory as Item["Category"]}
                                    onChange={(next) => setCategory(e.itemId, next)}
                                    busy={busy === e.itemId}
                                    compact
                                />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
