import { useEffect, useState } from "react";
import { api, HttpError, type Kid, type Profile } from "../api";
import KidModal from "../KidModal";
import KidFavoritesModal from "../KidFavoritesModal";
import Spinner from "../Spinner";

type Modal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; kid: Kid }
    | { kind: "favorites"; kid: Kid };

export default function Kids() {
    const [kids, setKids] = useState<Kid[] | null>(null);
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    async function refresh() {
        try {
            const [kidsRes, profilesRes] = await Promise.all([
                api.listKids(),
                api.listProfiles(),
            ]);
            setKids(kidsRes.kids);
            setProfiles(profilesRes.profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function remove(k: Kid) {
        if (!confirm(`Remove kid "${k.name}"? The Jellyfin user is left untouched.`)) {
            return;
        }
        try {
            await api.deleteKid(k.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Kids</h1>
                    <p className="muted">
                        Each kid maps a Jellyfin user to a Jellybean profile. The kid's TV
                        / app authenticates directly with Jellyfin on first launch - no API
                        keys, no passwords stored.
                    </p>
                </div>
                <button className="primary" onClick={() => setModal({ kind: "create" })}>+ Add kid</button>
            </div>

            {error && <div className="error">{error}</div>}

            {kids === null ? (
                <Spinner block size={36} label="Loading kids…" />
            ) : kids.length === 0 ? (
                <p className="muted">No kids yet. Tap "+ Add kid" above.</p>
            ) : (
                <ul className="kid-list">
                    {kids.map((k) => (
                        <li key={k.id}>
                            <div className="kid-row">
                                <div className="kid-info">
                                    <div className="kid-name">{k.name}</div>
                                    <div className="muted">
                                        Profile: {k.profileName} · Jellyfin user: {k.jellyfinUserId}
                                    </div>
                                </div>
                                <div className="kid-actions">
                                    <a
                                        className="kid-preview"
                                        href={`/player/library?profileId=${k.profileId}&kidId=${k.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Open the kids client scoped to this kid's profile (admin cookie auth; library + filters work, but no resume / continue-watching since it's not the kid's Jellyfin token). kidId stamps every override request so the parent can test the override flow as this specific kid."
                                    >
                                        View as {k.name}
                                    </a>
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "favorites", kid: k })
                                        }
                                    >
                                        Favorites
                                    </button>
                                    <button onClick={() => setModal({ kind: "edit", kid: k })}>
                                        Edit
                                    </button>
                                    <button onClick={() => remove(k)}>Remove</button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {(modal.kind === "create" || modal.kind === "edit") && (
                <KidModal
                    mode={modal.kind}
                    kid={modal.kind === "edit" ? modal.kid : undefined}
                    profiles={profiles}
                    onClose={() => setModal({ kind: "closed" })}
                    onSaved={async () => {
                        setModal({ kind: "closed" });
                        await refresh();
                    }}
                />
            )}
            {modal.kind === "favorites" && (
                <KidFavoritesModal
                    kid={modal.kid}
                    onClose={() => setModal({ kind: "closed" })}
                />
            )}
        </div>
    );
}
