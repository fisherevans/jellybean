import { useEffect, useState } from "react";
import { api, HttpError, type Kid, type Profile } from "./api";

type Props = {
    mode: "create" | "edit";
    kid?: Kid; // required when mode === "edit"
    profiles: Profile[];
    onSaved: (apiKey?: string) => void; // create returns the show-once API key
    onClose: () => void;
};

// KidModal handles create + edit. Create asks for Jellyfin username and
// password so we can mint a per-kid token; edit only touches name and
// profile (re-issuing tokens has its own "Regenerate key" path).

export default function KidModal({
    mode,
    kid,
    profiles,
    onSaved,
    onClose,
}: Props) {
    const [name, setName] = useState(kid?.name ?? "");
    const [profileId, setProfileId] = useState<number>(
        kid?.profileId ?? profiles[0]?.id ?? 0,
    );
    const [jellyfinUsername, setJellyfinUsername] = useState("");
    const [jellyfinPassword, setJellyfinPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !busy) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            if (mode === "create") {
                const res = await api.createKid(
                    name.trim(),
                    profileId,
                    jellyfinUsername.trim(),
                    jellyfinPassword,
                );
                onSaved(res.apiKey);
            } else if (kid) {
                await api.updateKid(kid.id, {
                    name: name.trim(),
                    profileId,
                });
                onSaved();
            }
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop" onClick={() => !busy && onClose()}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>{mode === "create" ? "Add kid" : `Edit ${kid?.name}`}</h2>
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Display name
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            autoFocus
                        />
                    </label>
                    <label>
                        Profile
                        <select
                            value={profileId}
                            onChange={(e) => setProfileId(Number(e.target.value))}
                            required
                        >
                            {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </label>

                    {mode === "create" && (
                        <>
                            <label>
                                Jellyfin username
                                <input
                                    value={jellyfinUsername}
                                    onChange={(e) => setJellyfinUsername(e.target.value)}
                                    required
                                    autoComplete="username"
                                />
                            </label>
                            <label>
                                Jellyfin password
                                <input
                                    type="password"
                                    value={jellyfinPassword}
                                    onChange={(e) => setJellyfinPassword(e.target.value)}
                                    required
                                    autoComplete="new-password"
                                />
                                <span className="modal-hint">
                                    Used once to mint a per-kid Jellyfin token. Not stored.
                                </span>
                            </label>
                        </>
                    )}

                    {error && <div className="error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Saving..." : mode === "create" ? "Add kid" : "Save"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
