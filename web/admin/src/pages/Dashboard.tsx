import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type User } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";

type Props = {
    user: User;
    onLogout: () => void;
};

type Counts = {
    visible: number;
    hidden: number;
    unset: number;
};

// Dashboard is now a status overview for the active profile: how many
// items are visible vs hidden vs still uncategorized, with direct links
// into the workflows that move those numbers.

export default function Dashboard({ user, onLogout }: Props) {
    const { profile, loading: profileLoading } = useActiveProfile();
    const [counts, setCounts] = useState<Counts | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!profile) return;
        let cancelled = false;
        setError(null);
        setCounts(null);
        // Three small queries to read each bucket's total. limit=1 keeps
        // payloads tiny; we only consume TotalRecordCount.
        Promise.all([
            api.listItems({ profileId: profile.id, state: "visible", limit: 1, type: "Movie,Series" }),
            api.listItems({ profileId: profile.id, state: "hidden", limit: 1, type: "Movie,Series" }),
            api.listItems({ profileId: profile.id, state: "unset", limit: 1, type: "Movie,Series" }),
        ])
            .then(([v, h, u]) => {
                if (cancelled) return;
                setCounts({
                    visible: v.TotalRecordCount,
                    hidden: h.TotalRecordCount,
                    unset: u.TotalRecordCount,
                });
            })
            .catch((err) => {
                if (cancelled) return;
                if (err instanceof HttpError && err.status === 401) {
                    onLogout();
                    return;
                }
                setError(err.message || "Failed to load library counts.");
            });
        return () => {
            cancelled = true;
        };
    }, [profile?.id, onLogout]);

    return (
        <div className="page">
            <h1>Welcome, {user.name}</h1>
            {profile ? (
                <p className="muted">
                    Showing curation state for profile <strong>{profile.name}</strong>{" "}
                    (default audio: <code>{profile.defaultLanguage || "eng"}</code>).
                    Switch profiles via the picker at the top right.
                </p>
            ) : profileLoading ? (
                <Spinner size={20} label="Loading profile…" />
            ) : (
                <p className="muted">No profile available.</p>
            )}

            {error && <div className="error">{error}</div>}

            {profile && (counts?.unset ?? 0) > 0 && (
                <div className="dashboard-primary-cta">
                    <div>
                        <div className="dashboard-primary-cta-label">
                            {(counts?.unset ?? 0).toLocaleString()} item
                            {counts?.unset === 1 ? "" : "s"} need a decision
                        </div>
                        <div className="muted">
                            Swipe through them one at a time. Left to hide, right to allow.
                        </div>
                    </div>
                    <Link to="/swipe" className="cta-primary">
                        Start swiping →
                    </Link>
                </div>
            )}

            <div className="dashboard-counts">
                <CountCard
                    label="Needs review"
                    value={counts?.unset}
                    tone="warn"
                    cta={{ to: "/swipe", label: "Swipe" }}
                    note="Items with no decision yet for this profile."
                />
                <CountCard
                    label="Visible"
                    value={counts?.visible}
                    tone="ok"
                    cta={{ to: "/search", label: "Search" }}
                    note="Approved for kids in this profile."
                />
                <CountCard
                    label="Hidden"
                    value={counts?.hidden}
                    tone="bad"
                    cta={{ to: "/search", label: "Search" }}
                    note="Excluded from this profile."
                />
            </div>

            <div className="dashboard-links">
                <Link to="/bulk">Bulk categorize</Link>
                <Link to="/activity">Recent activity</Link>
                <Link to="/kids">Kids</Link>
                <Link to="/profiles">Profiles</Link>
            </div>
        </div>
    );
}

type CountCardProps = {
    label: string;
    value: number | undefined;
    tone: "ok" | "warn" | "bad";
    cta: { to: string; label: string };
    note: string;
};

function CountCard({ label, value, tone, cta, note }: CountCardProps) {
    return (
        <div className={`count-card count-${tone}`}>
            <div className="count-label">{label}</div>
            <div className="count-value">
                {value === undefined ? "…" : value.toLocaleString()}
            </div>
            <div className="count-note">{note}</div>
            <Link to={cta.to} className="count-cta">
                {cta.label} →
            </Link>
        </div>
    );
}
