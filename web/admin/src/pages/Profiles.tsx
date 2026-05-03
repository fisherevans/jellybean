import { useEffect, useState } from "react";
import { api, HttpError, type Profile } from "../api";
import ProfileModal from "../ProfileModal";

type Modal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; profile: Profile };

export default function Profiles() {
    const [profiles, setProfiles] = useState<Profile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    async function refresh() {
        try {
            const res = await api.listProfiles();
            setProfiles(res.profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

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
                <p className="muted">Loading...</p>
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
                                </div>
                                <div className="profile-actions">
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

            {modal.kind !== "closed" && (
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
