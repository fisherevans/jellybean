import { useEffect, useState } from "react";
import { api, HttpError, formatMinAge, type ActivityEntry } from "../api";
import AgePicker from "../CategoryControl";

export default function Activity() {
    const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

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

    async function setAge(itemId: string, age: number | null) {
        setBusy(itemId);
        setError(null);
        try {
            await api.setAge(itemId, age);
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
                Last 50 categorization changes. Click a different age tier to flip.
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
                                        {e.fromMinAge !== null
                                            ? `${formatMinAge(e.fromMinAge)} → `
                                            : ""}
                                        <strong>{formatMinAge(e.toMinAge)}</strong>
                                        {" · "}
                                        {new Date(e.changedAt * 1000).toLocaleString()}
                                    </div>
                                </div>
                                <AgePicker
                                    value={e.toMinAge}
                                    onChange={(next) => setAge(e.itemId, next)}
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
