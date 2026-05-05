import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Profile } from "../api";
import ProfileModal from "../ProfileModal";
import Spinner from "../Spinner";

// The Profiles list page is intentionally lean - one row per profile
// with a Settings link to /profiles/:id. The settings page itself
// hosts all the per-profile config (tag rules, time limits, body
// breaks, viewing controls, modes, channels). Create / Delete still
// live on the list since they affect the list itself.

type Modal = { kind: "closed" } | { kind: "create" } | { kind: "edit"; profile: Profile };

export default function Profiles() {
    const [profiles, setProfiles] = useState<Profile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    async function refresh() {
        try {
            const pRes = await api.listProfiles();
            setProfiles(pRes.profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function remove(p: Profile) {
        if (
            !confirm(
                `Delete profile "${p.name}"? Visibility decisions made for it will be lost.`,
            )
        )
            return;
        setError(null);
        try {
            await api.deleteProfile(p.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Profiles</h1>
                    <p className="muted">
                        Each profile carries its own visibility decisions and
                        its own settings (tag rules, time limits, modes,
                        channels, etc.). Pick the active profile in the top
                        nav before triaging.
                    </p>
                </div>
                <button onClick={() => setModal({ kind: "create" })}>
                    + Add profile
                </button>
            </div>

            {error && <div className="error">{error}</div>}

            {profiles === null ? (
                <Spinner block size={36} label="Loading profiles..." />
            ) : (
                <ul className="profile-list">
                    {profiles.map((p) => (
                        <li key={p.id}>
                            <Link
                                to={`/profiles/${p.id}`}
                                className="profile-row profile-row-link"
                            >
                                <div className="profile-info">
                                    <div className="profile-name">
                                        {p.name}
                                    </div>
                                    <div className="muted">
                                        {p.description ?? ""}
                                        {p.description ? " · " : ""}
                                        {p.kidCount} kid
                                        {p.kidCount === 1 ? "" : "s"}
                                        {" · default lang "}
                                        <code>
                                            {p.defaultLanguage || "eng"}
                                        </code>
                                    </div>
                                    <div className="profile-stats">
                                        <span className="stat stat-visible">
                                            {p.visibleCount.toLocaleString()}{" "}
                                            visible
                                        </span>
                                        <span className="stat stat-hidden">
                                            {p.hiddenCount.toLocaleString()}{" "}
                                            hidden
                                        </span>
                                    </div>
                                </div>
                                <div className="profile-row-chevron">
                                    Settings →
                                </div>
                            </Link>
                            <div className="profile-actions">
                                <button
                                    onClick={() =>
                                        setModal({ kind: "edit", profile: p })
                                    }
                                >
                                    Rename
                                </button>
                                <button
                                    onClick={() => remove(p)}
                                    disabled={p.name === "Default"}
                                    title={
                                        p.name === "Default"
                                            ? "Default profile cannot be deleted"
                                            : ""
                                    }
                                >
                                    Delete
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {(modal.kind === "create" || modal.kind === "edit") && (
                <ProfileModal
                    mode={modal.kind}
                    profile={modal.kind === "edit" ? modal.profile : undefined}
                    existingProfiles={profiles ?? []}
                    onClose={() => setModal({ kind: "closed" })}
                    onSaved={async () => {
                        setModal({ kind: "closed" });
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}
