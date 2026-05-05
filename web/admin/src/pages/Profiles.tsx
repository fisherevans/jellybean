import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Layout, type Profile } from "../api";
import ProfileModal from "../ProfileModal";
import ProfileTagFiltersModal from "../ProfileTagFiltersModal";
import ProfileTimeLimitsModal from "../ProfileTimeLimitsModal";
import ProfileBodyBreaksModal from "../ProfileBodyBreaksModal";
import ProfileViewingControlsModal from "../ProfileViewingControlsModal";
import ProfileModesModal from "../ProfileModesModal";
import Spinner from "../Spinner";

type Modal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; profile: Profile }
    | { kind: "tag-filters"; profile: Profile }
    | { kind: "time-limits"; profile: Profile }
    | { kind: "body-breaks"; profile: Profile }
    | { kind: "viewing-controls"; profile: Profile }
    | { kind: "modes"; profile: Profile };

export default function Profiles() {
    const [profiles, setProfiles] = useState<Profile[] | null>(null);
    const [layouts, setLayouts] = useState<Layout[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    async function refresh() {
        try {
            const [pRes, lRes] = await Promise.all([
                api.listProfiles(),
                api.listLayouts(),
            ]);
            setProfiles(pRes.profiles);
            setLayouts(lRes.layouts);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function changeLayout(profileId: number, layoutId: number) {
        try {
            await api.setProfileLayout(profileId, layoutId);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function remove(p: Profile) {
        if (!confirm(`Delete profile "${p.name}"? Visibility decisions made for it will be lost.`)) return;
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
                        Each profile carries its own visibility decisions. An item can be
                        visible for one profile and hidden for another. Pick the active
                        profile in the top nav before triaging.
                    </p>
                </div>
                <button onClick={() => setModal({ kind: "create" })}>+ Add profile</button>
            </div>

            {error && <div className="error">{error}</div>}

            {profiles === null ? (
                <Spinner block size={36} label="Loading profiles…" />
            ) : (
                <ul className="profile-list">
                    {profiles.map((p) => (
                        <li key={p.id}>
                            <div className="profile-row">
                                <div className="profile-info">
                                    <div className="profile-name">{p.name}</div>
                                    <div className="muted">
                                        {p.description ?? ""}
                                        {p.description ? " · " : ""}
                                        {p.kidCount} kid{p.kidCount === 1 ? "" : "s"}
                                        {" · default lang "}
                                        <code>{p.defaultLanguage || "eng"}</code>
                                    </div>
                                    <div className="profile-stats">
                                        <span className="stat stat-visible">
                                            {p.visibleCount.toLocaleString()} visible
                                        </span>
                                        <span className="stat stat-hidden">
                                            {p.hiddenCount.toLocaleString()} hidden
                                        </span>
                                    </div>
                                    <div className="profile-layout">
                                        <label>
                                            Browse layout
                                            <select
                                                value={p.layoutId ?? 0}
                                                onChange={(e) =>
                                                    changeLayout(p.id, Number(e.target.value))
                                                }
                                            >
                                                {layouts.map((l) => (
                                                    <option key={l.id} value={l.id}>
                                                        {l.name}
                                                        {l.isDefault ? " (default)" : ""}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        {p.layoutId ? (
                                            <Link
                                                to={`/layouts/${p.layoutId}`}
                                                className="profile-layout-edit"
                                            >
                                                Edit this layout
                                            </Link>
                                        ) : null}
                                    </div>
                                </div>
                                <div className="profile-actions">
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "tag-filters", profile: p })
                                        }
                                    >
                                        Tag rules
                                    </button>
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "time-limits", profile: p })
                                        }
                                    >
                                        Time limits
                                    </button>
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "body-breaks", profile: p })
                                        }
                                    >
                                        Body breaks
                                    </button>
                                    <button
                                        onClick={() =>
                                            setModal({
                                                kind: "viewing-controls",
                                                profile: p,
                                            })
                                        }
                                    >
                                        Viewing
                                    </button>
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "modes", profile: p })
                                        }
                                    >
                                        Modes
                                    </button>
                                    <button onClick={() => setModal({ kind: "edit", profile: p })}>
                                        Edit
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
            {modal.kind === "tag-filters" && (
                <ProfileTagFiltersModal
                    profile={modal.profile}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
            {modal.kind === "time-limits" && (
                <ProfileTimeLimitsModal
                    profile={modal.profile}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
            {modal.kind === "body-breaks" && (
                <ProfileBodyBreaksModal
                    profile={modal.profile}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
            {modal.kind === "viewing-controls" && (
                <ProfileViewingControlsModal
                    profile={modal.profile}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
            {modal.kind === "modes" && (
                <ProfileModesModal
                    profile={modal.profile}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
        </div>
    );
}
