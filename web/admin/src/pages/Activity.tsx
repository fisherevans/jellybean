import { useEffect, useState } from "react";
import { api, HttpError, formatState, type ActivityEntry, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";
import StateControl from "../CategoryControl";
import Spinner from "../Spinner";

// Activity shows recent visibility changes for the active profile (or all
// profiles if "All" is selected). Each row has a re-categorize control so
// the parent can flip a recent decision.

export default function Activity() {
    const { profile, profiles } = useActiveProfile();
    const [scope, setScope] = useState<"active" | "all">("active");
    const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    async function refresh() {
        try {
            const res = await api.recentActivity(50, scope === "active" ? profile?.id : undefined);
            setEntries(res.entries);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.id, scope]);

    async function setItemState(itemId: string, profileId: number, state: ItemState) {
        setBusy(itemId + ":" + profileId);
        setError(null);
        try {
            await api.setState(itemId, profileId, state);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    function profileName(id: number): string {
        return profiles.find((p) => p.id === id)?.name ?? `#${id}`;
    }

    return (
        <div className="page">
            <h1>Recent activity</h1>
            <p className="muted">
                Last 50 visibility changes
                {scope === "active" && profile ? ` for ${profile.name}` : " across all profiles"}.
                <button
                    onClick={() => setScope(scope === "active" ? "all" : "active")}
                    className="link-button"
                    style={{ marginLeft: "0.5rem" }}
                >
                    {scope === "active" ? "show all profiles" : "show active only"}
                </button>
            </p>
            {error && <div className="error">{error}</div>}
            {entries === null ? (
                <Spinner block size={36} label="Loading activity…" />
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
                                        {profileName(e.profileId)} ·{" "}
                                        {e.fromState !== null
                                            ? `${formatState(e.fromState)} → `
                                            : ""}
                                        <strong>{formatState(e.toState)}</strong>
                                        {" · "}
                                        {new Date(e.changedAt * 1000).toLocaleString()}
                                    </div>
                                </div>
                                <StateControl
                                    value={e.toState}
                                    onChange={(next) => setItemState(e.itemId, e.profileId, next)}
                                    busy={busy === e.itemId + ":" + e.profileId}
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
